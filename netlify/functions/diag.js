// Netlify Function: /.netlify/functions/diag
//
// Diagnose-Endpunkt: probiert JEDE externe Datenquelle einzeln an und meldet,
// was tatsaechlich zurueckkommt - HTTP-Status, Content-Type, Dauer und ein
// Auszug des Antwortkoerpers.
//
// Warum es das gibt: Die Entwicklungsumgebung erreicht fred.stlouisfed.org,
// api.reliefweb.int und api.db.nomics.world nicht (Egress-Richtlinie blockt
// CONNECT mit 403). Fehler wie "ReliefWeb nicht erreichbar" lassen sich von
// dort also nicht nachstellen. Diese Function laeuft dagegen auf Netlify, wo
// die echten Aufrufe stattfinden - ihr Ergebnis zeigt den konkreten Grund
// (falscher Filterwert, Bot-Sperre, geaenderter Pfad, Zeitueberschreitung...)
// statt nur "hat nicht geklappt".
//
// Aufruf:  /.netlify/functions/diag           (alle Quellen)
//          /.netlify/functions/diag?only=reliefweb
//
// Sicherheit: Es werden ausschliesslich oeffentliche, schluessellose Endpunkte
// geprueft. Es werden KEINE Umgebungsvariablen, API-Schluessel, Cookies oder
// Anfrage-Header ausgegeben - nur Statuszeilen und ein gekuerzter Auszug des
// Antwortkoerpers.

// Siehe ausfuehrlicher Kommentar in lib/providers.js: fred-csv UND gdelt
// verstummten im Livebetrieb beide komplett (kein Status, keine Bytes) - das
// Symptom eines haengenden IPv6-Verbindungsversuchs ohne funktionierendes
// IPv6-Egress. Diese Function nutzt providers.js NICHT (rohes fetch), deshalb
// hier derselbe Fix separat.
require("dns").setDefaultResultOrder("ipv4first");

const PROBE_TIMEOUT = 6000;
const BODY_SNIPPET = 400;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Aus fred.js/geopolitics.js gespiegelt, damit die Diagnose GENAU die URLs
// prueft, die im Betrieb verwendet werden. Weichen die Dateien auseinander,
// diagnostiziert man sonst etwas anderes als das, was tatsaechlich laeuft.
//
// Live-Beleg: "country.iso2" wurde mit HTTP 400 "Unrecognized field
// 'country.iso2' in parameter 'fields'" abgelehnt - dieses Feld gibt es im
// ReliefWeb-v2-Schema nicht (nur iso3). Deshalb entfernt.
const RW_FIELDS = "&fields[include][]=name&fields[include][]=date.created&fields[include][]=type.name"
  + "&fields[include][]=country.iso3&fields[include][]=country.name";
// Live-Beleg: die feldlose Rueckfallebene lieferte HTTP 403 "You are not
// using an approved appname" - ReliefWeb v2 verlangt inzwischen einen
// REGISTRIERTEN Appnamen (anders als v1). Das ist kein URL-Formfehler, den
// Code beheben kann, sondern eine externe Registrierung. Ueber Umgebungs-
// variable konfigurierbar, damit ein spaeter genehmigter Appname ohne
// Redeploy eingetragen werden kann.
const RELIEFWEB_APPNAME = process.env.RELIEFWEB_APPNAME || "terminal-app-geopolitics";
const RELIEFWEB_BASE = "https://api.reliefweb.int/v2/disasters"
  + "?appname=" + encodeURIComponent(RELIEFWEB_APPNAME) + RW_FIELDS + "&sort[]=date.created:desc&limit=5";

const PROBES = [
  {
    key: "fred-csv",
    label: "FRED CSV (Makro, Hauptquelle)",
    url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=UNRATE&cosd=2024-01-01",
    headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://fred.stlouisfed.org/" },
    // Erwartet: CSV, erste Zeile Kopfzeile, danach "JJJJ-MM-TT,wert"
    expect: (body) => /^[^\n]*\n\d{4}-\d{2}-\d{2},/.test(body.trim()) ? null : "sieht nicht nach FRED-CSV aus (Bot-Sperre oder HTML-Antwort?)",
  },
  {
    // Der eigentliche Hauptweg seit dem Timeout-Befund: EIN Abruf fuer alle
    // Serien statt zehn einzelne. Wenn diese Probe traegt, ist F4 MAKRO gesund.
    key: "fred-csv-sammel",
    label: "FRED CSV SAMMELABRUF (Hauptweg – alle Serien in einer Antwort)",
    url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=UNRATE,CPIAUCSL,FEDFUNDS,DGS10,T10Y2Y,GDP,PAYEMS,UMCSENT,MORTGAGE30US,M2SL&cosd=2014-01-01",
    headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://fred.stlouisfed.org/" },
    expect: (body) => {
      const head = (body.split(/\r?\n/)[0] || "").toUpperCase();
      const fehlend = ["UNRATE", "CPIAUCSL", "GDP"].filter((id) => !head.includes(id));
      return fehlend.length ? "Kopfzeile enthaelt diese Serien nicht: " + fehlend.join(", ") : null;
    },
  },
  {
    key: "dbnomics-pfad-3seg",
    label: "DBnomics Kandidat 1 (Pfad, 3 Segmente)",
    url: "https://api.db.nomics.world/v22/series/FRED/UNRATE/UNRATE?observations=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "dbnomics-ids-3seg",
    label: "DBnomics Kandidat 2 (series_ids, 3 Segmente)",
    url: "https://api.db.nomics.world/v22/series?series_ids=FRED/UNRATE/UNRATE&observations=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    // Beleg-Probe: genau diese Form lieferte im Livebetrieb HTTP 400
    // ("series_ids":["FRED/UNRATE"]). Bleibt drin, um den Befund festzuhalten.
    key: "dbnomics-ids-2seg-ungueltig",
    label: "DBnomics mit 2 Segmenten (ungültig – erwartet HTTP 400)",
    url: "https://api.db.nomics.world/v22/series?series_ids=FRED/UNRATE&observations=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
    expectStatus: 400,
  },
  {
    key: "dbnomics-suche",
    label: "DBnomics Kandidat 3 (Suche über den Provider)",
    url: "https://api.db.nomics.world/v22/search?q=UNRATE&provider_code=FRED&observations=1&limit=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    // Beleg-Probe: v1 wurde abgeschaltet (HTTP 410). Bleibt drin, damit man
    // schwarz auf weiss sieht, WARUM auf v2 umgestellt wurde - und sofort
    // merkt, falls sich daran je etwas aendern sollte.
    key: "reliefweb-v1-abgeschaltet",
    label: "ReliefWeb v1 (abgeschaltet – erwartet HTTP 410)",
    url: "https://api.reliefweb.int/v1/disasters?appname=" + encodeURIComponent(RELIEFWEB_APPNAME) + "&limit=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
    expectStatus: 410,
  },
  {
    key: "reliefweb-v2-filtered",
    label: "ReliefWeb v2 MIT Statusfilter alert/ongoing (Hauptpfad)",
    url: RELIEFWEB_BASE + "&filter[field]=status&filter[value][]=alert&filter[value][]=ongoing",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "reliefweb-v2-plain",
    label: "ReliefWeb v2 OHNE Filter (Rueckfallebene 1)",
    url: RELIEFWEB_BASE,
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "reliefweb-v2-minimal",
    label: "ReliefWeb v2 ohne Feldauswahl (Rueckfallebene 2)",
    url: "https://api.reliefweb.int/v2/disasters?appname=" + encodeURIComponent(RELIEFWEB_APPNAME) + "&limit=5",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    // Beleg-Probe fuer DBnomics: zeigt, ob 'FRED' ueberhaupt (noch) als
    // Provider im Katalog steht. Die Kandidaten 1+2 scheiterten beide mit
    // "Could not find storage directory for provider 'FRED'" - das ist KEIN
    // Formatfehler unserer URL (der Provider-Code wird korrekt erkannt),
    // sondern DBnomics selbst findet die hinterlegten Daten fuer FRED nicht.
    // Diese Probe unterscheidet "Provider fehlt im Katalog komplett" von
    // "Provider bekannt, aber Datenspeicher gerade nicht verfuegbar".
    key: "dbnomics-providers",
    label: "DBnomics Katalog (Beleg: steht 'FRED' ueberhaupt in der Providerliste?)",
    url: "https://api.db.nomics.world/v22/providers?limit=1000",
    headers: { "Accept": "application/json", "User-Agent": UA },
    expect: (body) => {
      try {
        const j = JSON.parse(body);
        const list = (j && j.providers && (j.providers.docs || j.providers)) || j.docs || [];
        const codes = (Array.isArray(list) ? list : []).map((p) => p && (p.code || p.provider_code)).filter(Boolean);
        if (!codes.length) return "konnte keine Provider-Codes aus der Antwort lesen";
        const hasFred = codes.some((c) => String(c).toUpperCase() === "FRED");
        if (!hasFred) {
          const aehnlich = codes.filter((c) => /fed|fred/i.test(String(c)));
          return "Provider 'FRED' NICHT in der Katalogliste" + (aehnlich.length ? " – aehnliche Codes: " + aehnlich.join(", ") : " (keine aehnlichen Codes gefunden)");
        }
        return null;
      } catch (e) { return "Antwort konnte nicht als Providerliste geparst werden: " + String(e && e.message || e); }
    },
  },
  {
    key: "gdelt",
    label: "GDELT (Weltlage, Nachrichtenvolumen)",
    url: "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent('"Sudan" (war OR conflict)') + "&mode=artlist&maxrecords=3&timespan=3d&format=json&sort=datedesc",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "yahoo",
    label: "Yahoo Finance (Kurse - Kontrollprobe, funktioniert erfahrungsgemäß)",
    url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "stooq",
    label: "Stooq (Kurs-Ersatzquelle)",
    url: "https://stooq.com/q/d/l/?s=aapl.us&i=d",
    headers: { "User-Agent": UA },
  },
  {
    key: "frankfurter",
    label: "Frankfurter (Wechselkurse, EZB)",
    url: "https://api.frankfurter.app/latest?from=EUR&to=USD",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
];

async function probe(p) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  const base = { key: p.key, label: p.label, url: p.url };
  try {
    const res = await fetch(p.url, { headers: p.headers || {}, signal: ctrl.signal, redirect: "follow" });
    const raw = await res.text();
    const ms = Date.now() - t0;
    const out = {
      ...base,
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") || null,
      ms,
      bodyLength: raw.length,
      bodySnippet: raw.slice(0, BODY_SNIPPET),
    };
    // Bei JSON zusaetzlich die oberste Struktur zeigen - daran erkennt man
    // sofort, ob das Parsen in fred.js/geopolitics.js ueberhaupt passen kann.
    if ((out.contentType || "").includes("json")) {
      try {
        const j = JSON.parse(raw);
        out.jsonTopLevelKeys = j && typeof j === "object" ? Object.keys(j).slice(0, 15) : typeof j;
        if (j && Array.isArray(j.data)) out.dataArrayLength = j.data.length;
        if (j && Array.isArray(j.articles)) out.articlesArrayLength = j.articles.length;
      } catch (e) { out.jsonParseError = String(e && e.message || e); }
    }
    if (res.ok && p.expect) { const warn = p.expect(raw); if (warn) out.warning = warn; }
    // Manche Proben SOLLEN fehlschlagen (z.B. das abgeschaltete v1 mit 410).
    // Die als Fehler zu zaehlen wuerde die Zusammenfassung unbrauchbar machen.
    if (p.expectStatus != null) {
      out.erwarteterStatus = p.expectStatus;
      out.wieErwartet = res.status === p.expectStatus;
      out.ok = out.wieErwartet;
    }
    return out;
  } catch (e) {
    const ms = Date.now() - t0;
    return {
      ...base, ok: false, status: null, ms,
      error: ctrl.signal.aborted ? `Zeitueberschreitung nach ${PROBE_TIMEOUT}ms` : String((e && e.message) || e),
      errorName: e && e.name ? e.name : null,
      // Bei Netzwerkfehlern steckt der eigentliche Grund oft erst in .cause
      errorCause: e && e.cause ? String((e.cause && e.cause.message) || e.cause) : null,
    };
  } finally {
    clearTimeout(to);
  }
}

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const qp = (event && event.queryStringParameters) || {};
  const only = (qp.only || "").trim().toLowerCase();
  const list = only ? PROBES.filter((p) => p.key.includes(only)) : PROBES;

  // Nacheinander statt parallel: parallel wuerden sich die Proben das
  // Zeitbudget der Function teilen und gegenseitig ins Timeout treiben - genau
  // das Problem, das hier diagnostiziert werden soll.
  const results = [];
  const started = Date.now();
  for (const p of list) {
    if (Date.now() - started > 20000) { results.push({ key: p.key, label: p.label, skipped: "Zeitbudget der Diagnose erreicht" }); continue; }
    results.push(await probe(p));
  }

  const summary = {
    ok: results.filter((r) => r.ok).map((r) => r.key),
    fehlgeschlagen: results.filter((r) => r.ok === false).map((r) => ({ key: r.key, status: r.status, grund: r.error || `HTTP ${r.status}` })),
  };

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({
      hinweis: "Diagnose der externen Datenquellen. Enthaelt keine Schluessel oder Umgebungsvariablen.",
      zeitpunkt: new Date().toISOString(),
      laufzeitumgebung: {
        node: process.version,
        fetchGlobalVorhanden: typeof fetch === "function",
        region: process.env.AWS_REGION || null,
      },
      zusammenfassung: summary,
      proben: results,
    }, null, 2),
  };
};

exports._internal = { PROBES, probe };
