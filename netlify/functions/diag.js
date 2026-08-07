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

const PROBE_TIMEOUT = 6000;
const BODY_SNIPPET = 400;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Aus fred.js/geopolitics.js gespiegelt, damit die Diagnose GENAU die URLs
// prueft, die im Betrieb verwendet werden. Weichen die Dateien auseinander,
// diagnostiziert man sonst etwas anderes als das, was tatsaechlich laeuft.
const RELIEFWEB_BASE = "https://api.reliefweb.int/v1/disasters"
  + "?appname=terminal-app-geopolitics"
  + "&fields[include][]=name&fields[include][]=date.created&fields[include][]=type.name&fields[include][]=country.iso3&fields[include][]=country.iso2&fields[include][]=country.name"
  + "&sort[]=date.created:desc&limit=5";

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
    key: "dbnomics-3seg",
    label: "DBnomics Kandidat 1 (Pfad mit 3 Segmenten)",
    url: "https://api.db.nomics.world/v22/series/FRED/UNRATE/UNRATE?observations=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "dbnomics-2seg",
    label: "DBnomics Kandidat 2 (Pfad mit 2 Segmenten)",
    url: "https://api.db.nomics.world/v22/series/FRED/UNRATE?observations=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "dbnomics-query",
    label: "DBnomics Kandidat 3 (series_ids-Abfrage)",
    url: "https://api.db.nomics.world/v22/series?series_ids=FRED/UNRATE&observations=1",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "reliefweb-filtered",
    label: "ReliefWeb MIT Statusfilter (so lief es bisher)",
    url: RELIEFWEB_BASE + "&filter[field]=status&filter[value][]=alert&filter[value][]=current",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "reliefweb-ongoing",
    label: "ReliefWeb mit Statuswerten alert/ongoing",
    url: RELIEFWEB_BASE + "&filter[field]=status&filter[value][]=alert&filter[value][]=ongoing",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "reliefweb-plain",
    label: "ReliefWeb OHNE Filter (Rueckfallebene)",
    url: RELIEFWEB_BASE,
    headers: { "Accept": "application/json", "User-Agent": UA },
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
