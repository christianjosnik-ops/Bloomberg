// Netlify Function: /.netlify/functions/diag
//
// Diagnose-Endpunkt: probiert JEDE externe Datenquelle einzeln an und meldet,
// was tatsaechlich zurueckkommt - HTTP-Status, Content-Type, Dauer und ein
// Auszug des Antwortkoerpers.
//
// Warum es das gibt: Die Entwicklungsumgebung erreicht fred.stlouisfed.org,
// ucdpapi.pcr.uu.se nicht (Egress-Richtlinie blockt
// CONNECT mit 403). Fehler wie "UCDP nicht erreichbar" lassen sich von
// dort also nicht nachstellen. Diese Function laeuft dagegen auf Netlify, wo
// die echten Aufrufe stattfinden - ihr Ergebnis zeigt den konkreten Grund
// (falscher Filterwert, Bot-Sperre, geaenderter Pfad, Zeitueberschreitung...)
// statt nur "hat nicht geklappt".
//
// Aufruf:  /.netlify/functions/diag           (alle Quellen)
//          /.netlify/functions/diag?only=gdelt
//
// Sicherheit: Es werden KEINE Schluesselwerte, Cookies oder Anfrage-Header
// ausgegeben - nur Statuszeilen und ein gekuerzter Auszug des Antwortkoerpers.
// Von konfigurierten Schluesseln wird ausschliesslich gemeldet, OB sie gesetzt
// sind und wie lang sie sind; zusaetzlich filtert redigiere() jeden Wert aus
// allen ausgehenden Texten heraus, falls ein Anbieter ihn je zurueckspiegelt.

// Siehe ausfuehrlicher Kommentar in lib/providers.js: fred-csv UND gdelt
// verstummten im Livebetrieb beide komplett (kein Status, keine Bytes) - das
// Symptom eines haengenden IPv6-Verbindungsversuchs ohne funktionierendes
// IPv6-Egress. Diese Function nutzt providers.js NICHT (rohes fetch), deshalb
// hier derselbe Fix separat.
require("dns").setDefaultResultOrder("ipv4first");

// Gruppierung und Serienliste kommen aus fred.js selbst - nicht abgeschrieben.
// Nur so kann die Diagnose nicht etwas anderes pruefen als das, was im Betrieb
// laeuft. Das blosse Laden von fred.js loest keine Netzwerkaufrufe aus.
const { SERIES_FREQ: FRED_SERIES_FREQ, gruppiereNachFrequenz: FRED_GRUPPIEREN, FRED_API_BASIS } = require("./fred.js")._internal;

// Aus JEDEM ausgehenden Text die konfigurierten Geheimnisse entfernen.
//
// Der Normalfall ist, dass sie ohnehin nicht vorkommen - sie stehen in Headern,
// nicht in URLs. Das hier ist die zweite Verteidigungslinie fuer den Fall, dass
// ein Anbieter den gesendeten Schluessel in seiner Fehlermeldung zurueckspiegelt
// ("invalid key: abc123..."). Dieser Auszug landet sonst unveraendert im UI.
function redigiere(text, geheimnisse) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const g of geheimnisse) {
    if (g && g.length >= 8) out = out.split(g).join("***");
  }
  return out;
}

// Kopfzeile unabhaengig von der Schreibweise lesen (Netlify liefert klein,
// andere Laufzeiten nicht zwingend).
function header(event, name) {
  const h = (event && event.headers) || {};
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name) return String(h[k] || "").trim();
  }
  return "";
}

const PROBE_TIMEOUT = 6000;
const BODY_SNIPPET = 400;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Aus fred.js/geopolitics.js gespiegelt, damit die Diagnose GENAU die URLs
// prueft, die im Betrieb verwendet werden. Weichen die Dateien auseinander,
// diagnostiziert man sonst etwas anderes als das, was tatsaechlich laeuft.
const { timeseriesUrl, parseTimeseries } = require("./lib/fundamentals");
const UCDP_TOKEN = process.env.UCDP_ACCESS_TOKEN || "";
const FRED_ENV_KEY = process.env.FRED_API_KEY || "";
const PROBES = [
  // --- Trennschaerfe-Proben: warum antwortet FRED nicht? ---------------------
  //
  // Der Livebetrieb zeigte: JEDE FRED-Abfrage laeuft in 6s Timeout, auch die
  // kleine Einzelserie. Kein 403, kein HTML, keine Fehlerseite - schlicht keine
  // Antwort. Daraus allein laesst sich die Ursache nicht ableiten, und Raten
  // hat hier schon zweimal zu falschen Diagnosen gefuehrt. Die folgenden drei
  // Proben trennen die moeglichen Ursachen sauber voneinander:
  {
    // Eine winzige, statische Datei ohne jede Berechnung auf FRED-Seite.
    // Antwortet SIE schnell, ist der Host erreichbar und das Problem liegt an
    // der CSV-Erzeugung (zu langsam). Laeuft auch sie ins Timeout, ist der Host
    // von dieser Netlify-Region aus schlicht nicht erreichbar - dann helfen
    // weder Header noch Timeouts, sondern nur ein anderer Weg.
    key: "fred-erreichbarkeit",
    label: "FRED Erreichbarkeit (robots.txt – statisch, ohne Berechnung)",
    url: "https://fred.stlouisfed.org/robots.txt",
    headers: { "User-Agent": UA },
  },
  {
    // Die offizielle FRED-API liegt auf einer ANDEREN Subdomain und damit
    // moeglicherweise hinter anderer Infrastruktur. Ohne Schluessel antwortet
    // sie mit einem Fehler - aber ein SCHNELLER Fehler beweist Erreichbarkeit.
    // Genau das ist die entscheidende Information: seit FRED im November 2025
    // die Schluesselpflicht durchgesetzt hat, fuehrt der Weg ohnehin nur noch
    // ueber einen Schluessel. Antwortet diese Probe zuegig, ist F4 MAKRO
    // eine Registrierung entfernt - laeuft auch sie ins Timeout, ist der
    // gesamte Anbieter aus dieser Region nicht erreichbar.
    //
    // Kein expectStatus: welchen Code FRED ohne Schluessel genau liefert (400
    // oder 401), ist nicht sicher belegt - und ein falsch erwarteter Code
    // wuerde die Probe faelschlich rot faerben. Wichtig ist allein, DASS
    // schnell geantwortet wird; expect() prueft deshalb den Inhalt.
    key: "fred-api-erreichbarkeit",
    label: "FRED offizielle API (api.stlouisfed.org) – ohne Schluessel; Fehler ist hier normal, Hauptsache schnell",
    url: "https://api.stlouisfed.org/fred/series/observations?series_id=UNRATE&file_type=json",
    headers: { "Accept": "application/json", "User-Agent": UA },
    expect: (body) => (/api[_ ]?key/i.test(body)
      ? null
      : "Antwort erwaehnt keinen fehlenden Schluessel – unerwartete Form: " + body.slice(0, 120).replace(/\s+/g, " ")),
  },
  {
    key: "fred-csv",
    label: "FRED CSV (Makro, Hauptquelle)",
    url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=UNRATE&cosd=2024-01-01",
    headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://fred.stlouisfed.org/" },
    // Erwartet: CSV, erste Zeile Kopfzeile, danach "JJJJ-MM-TT,wert"
    expect: (body) => /^[^\n]*\n\d{4}-\d{2}-\d{2},/.test(body.trim()) ? null : "sieht nicht nach FRED-CSV aus (Bot-Sperre oder HTML-Antwort?)",
  },
  // FRED-Sammelabrufe: EINE Probe je Frequenzgruppe - erzeugt aus derselben
  // Gruppierungslogik, die fred.js im Betrieb verwendet. Frueher standen hier
  // zwei handgeschriebene URLs mit gemischten Frequenzen; die haetten ab jetzt
  // etwas anderes diagnostiziert als das, was die App tatsaechlich abfragt.
  // Genau diese Art Auseinanderlaufen hat schon einmal zu einer Fehldiagnose
  // gefuehrt, deshalb hier eine gemeinsame Quelle statt zweier Listen.
  ...(function fredGruppenProben() {
    const ids = Object.keys(FRED_SERIES_FREQ);
    const gruppen = [...FRED_GRUPPIEREN(ids).entries()];
    return gruppen.map(([freq, gruppenIds]) => ({
      key: "fred-sammel-" + freq,
      label: `FRED Sammelabruf ${freq} (${gruppenIds.length} Serien) – Hauptweg fuer F4 MAKRO`,
      url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + gruppenIds.join(",") + "&cosd=2014-01-01",
      headers: { "User-Agent": UA, "Accept": "text/csv,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://fred.stlouisfed.org/" },
      // Prueft DREI Dinge, nicht nur Erreichbarkeit:
      //   1. kommen alle angefragten Serien als Spalte zurueck (fehlende IDs
      //      laesst FRED stillschweigend weg),
      //   2. ist die juengste Zeile ueberhaupt aus juengerer Zeit (eine
      //      eingestellte Serie antwortet normal, nur mit alten Werten),
      //   3. sieht die Antwort ueberhaupt nach CSV aus.
      expect: (body) => {
        const zeilen = body.trim().split(/\r?\n/);
        if (zeilen.length < 3) return "zu wenige Zeilen – vermutlich keine Datenantwort: " + body.slice(0, 80).replace(/\s+/g, " ");
        const head = (zeilen[0] || "").toUpperCase();
        const fehlend = gruppenIds.filter((id) => !head.includes(id.toUpperCase()));
        if (fehlend.length) return "FRED lieferte keine Spalte fuer: " + fehlend.join(", ");
        const datum = ((zeilen[zeilen.length - 1] || "").split(",")[0] || "").trim();
        const ts = Date.parse(datum + "T00:00:00Z");
        if (isNaN(ts)) return "letzte Zeile beginnt nicht mit einem Datum: " + zeilen[zeilen.length - 1].slice(0, 60);
        const tage = Math.floor((Date.now() - ts) / 864e5);
        return tage > 400 ? `juengstes Datum ist ${datum} (${tage} Tage alt) – mindestens eine Serie dieser Gruppe duerfte eingestellt sein` : null;
      },
    }));
  })(),
  // UCDP ist die Hauptquelle fuer die dynamische Laenderliste in F6 WELTLAGE.
  // Die Monats-Candidate-Version WANDERT (Schema JJ.0.M) - deshalb werden die
  // beiden zuletzt plausiblen Monate geprobt, genau wie geopolitics.js sie
  // rueckwaerts durchlaeuft. Erwartungsgemaess antwortet der aktuelle Monat
  // haeufig mit 404 (noch nicht veroeffentlicht) und der Vormonat mit 200.
  ...(function ucdpProben() {
    const d = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const proben = [];
    for (let i = 0; i < 2; i++) {
      const v = `${d.getUTCFullYear() % 100}.0.${d.getUTCMonth() + 1}`;
      proben.push({
        key: `ucdp-monat-${i === 0 ? "aktuell" : "vormonat"}`,
        label: `UCDP Candidate ${v} (${i === 0 ? "laufender Monat – 404 ist hier normal" : "Vormonat – hier sollten Daten kommen"})`,
        url: `https://ucdpapi.pcr.uu.se/api/gedevents/${v}?pagesize=5&page=0`,
        // Den Token mitschicken, falls konfiguriert. Ohne ihn antwortet UCDP
        // garantiert mit 401 - eine Probe, die den Token NICHT sendet, koennte
        // also nie etwas anderes melden als "401" und waere nach dem
        // Hinterlegen des Tokens sofort irrefuehrend.
        headers: Object.assign(
          { "Accept": "application/json", "User-Agent": UA },
          UCDP_TOKEN ? { "x-ucdp-access-token": UCDP_TOKEN } : {}
        ),
        expect: (body) => {
          try {
            const j = JSON.parse(body);
            const arr = j && Array.isArray(j.Result) ? j.Result : null;
            if (!arr) return "kein Result-Array in der Antwort – Umschlag hat sich geaendert?";
            if (!arr.length) return "Result-Array ist leer";
            return "country" in arr[0] ? null : "Ereignisse haben kein country-Feld: " + Object.keys(arr[0]).slice(0, 8).join(", ");
          } catch (e) { return "Antwort ist kein gueltiges JSON: " + String(e && e.message || e); }
        },
      });
      d.setUTCMonth(d.getUTCMonth() - 1);
    }
    return proben;
  })(),
  // --- Fundamentaldaten: kommt der operative Cashflow ueberhaupt an? -------
  //
  // Anlass: Im Betrieb fehlten operativer Cashflow und Investitionen, wodurch
  // FCF-Marge (F5) und Bewertung (F7) ohne Zahlen dastanden. Ursache war die
  // aeltere quoteSummary-Schnittstelle. Diese beiden Proben zeigen schwarz auf
  // weiss, WELCHE der beiden Quellen liefert - ohne sie bliebe nur Raten.
  {
    key: "yahoo-fundamentals-timeseries",
    label: "Yahoo Fundamentaldaten NEU (fundamentals-timeseries, AAPL) – liefert es den operativen Cashflow?",
    url: timeseriesUrl("query1", "AAPL", Date.now(), 6),
    headers: { "Accept": "application/json", "User-Agent": UA },
    expect: (body) => {
      let json;
      try { json = JSON.parse(body); } catch (_) { return "Antwort ist kein JSON"; }
      const rows = parseTimeseries(json);
      if (!rows.length) return "keine Jahreszeilen erkannt - Antwortform hat sich geaendert?";
      const mitCf = rows.filter((r) => r.operatingCashflow != null).length;
      const mitFcf = rows.filter((r) => r.freeCashflowReported != null).length;
      if (!mitCf && !mitFcf) return `${rows.length} Jahre erkannt, aber KEIN operativer Cashflow und kein freier Cashflow dabei`;
      return null;
    },
  },
  {
    key: "yahoo-fundamentals-quotesummary",
    label: "Yahoo Fundamentaldaten ALT (quoteSummary, AAPL) – Vergleichsprobe, Leerlauf hier ist der bekannte Befund",
    url: "https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=cashflowStatementHistory",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    key: "gdelt",
    label: "GDELT (Weltlage, Nachrichtenvolumen – Hauptpfad mit 7-Tage-Fenster)",
    url: "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent('"Sudan" (war OR conflict)') + "&mode=artlist&maxrecords=25&timespan=7d&format=json&sort=datedesc",
    headers: { "Accept": "application/json", "User-Agent": UA },
  },
  {
    // Beleg-Probe fuer den neuen Trendverlauf (mode=timelinevol). Antwortform
    // ungetestet - expect() prueft, ob eine date/value-Zeitreihe erkennbar ist.
    key: "gdelt-timeline",
    label: "GDELT Timeline (Trendverlauf, mode=timelinevol)",
    url: "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent('"Sudan" (war OR conflict)') + "&mode=timelinevol&format=json&timespan=2w",
    headers: { "Accept": "application/json", "User-Agent": UA },
    expect: (body) => {
      try {
        const j = JSON.parse(body);
        const found = (function find(node, depth) {
          if (Array.isArray(node)) return node.length && node.every((x) => x && typeof x === "object" && "date" in x && "value" in x) ? node : node.map((n) => find(n, (depth || 0) + 1)).find(Boolean) || null;
          if (!node || typeof node !== "object" || (depth || 0) > 4) return null;
          for (const k of Object.keys(node)) { const hit = find(node[k], (depth || 0) + 1); if (hit) return hit; }
          return null;
        })(j, 0);
        return found ? null : "keine date/value-Zeitreihe in der Antwort gefunden";
      } catch (e) { return "Antwort konnte nicht als JSON gelesen werden: " + String(e && e.message || e); }
    },
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

// Die entscheidende Probe seit der Schluesselpflicht: funktioniert der
// hinterlegte Schluessel WIRKLICH? Alles andere ist Vermutung - ein gesetzter
// Schluessel kann trotzdem falsch abgetippt, widerrufen oder noch nicht
// deployt sein, und keine der uebrigen Proben wuerde das je zeigen.
//
// Nur vorhanden, wenn ein Schluessel existiert; sonst haette sie keinen
// Aussagewert und faerbte den Bericht bloss rot.
function schluesselProbe(schluessel, woher) {
  if (!schluessel) return [];
  return [{
    key: "fred-api-mit-schluessel",
    label: `FRED offizielle API MIT Schluessel (${woher}) – hier muss HTTP 200 stehen`,
    url: `${FRED_API_BASIS}?series_id=UNRATE&file_type=json&observation_start=2024-01-01`,
    // Bearer-Header, exakt wie fred.js im Betrieb. NICHT als api_key in der
    // URL: die URL steht im Diagnosebericht, der Header nicht.
    headers: { "Accept": "application/json", "User-Agent": UA, "Authorization": "Bearer " + schluessel },
    expect: (body) => {
      try {
        const j = JSON.parse(body);
        const obs = j && Array.isArray(j.observations) ? j.observations : null;
        if (!obs) return "kein observations-Array – Antwortform hat sich geaendert?";
        return obs.length ? null : "observations-Array ist leer";
      } catch (e) { return "Antwort ist kein gueltiges JSON: " + String(e && e.message || e); }
    },
  }];
}

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
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-FRED-Key", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  // Derselbe Vorrang wie in fred.js: Browser-Header schlaegt Umgebungsvariable.
  // Waere er hier anders, pruefte die Diagnose etwas anderes als das, was im
  // Betrieb passiert - genau der Fehler, der schon einmal zu einer
  // Fehldiagnose gefuehrt hat.
  const fredHeaderKey = header(event, "x-fred-key");
  const fredKey = fredHeaderKey || FRED_ENV_KEY;
  const fredWoher = fredHeaderKey ? "aus dem Startbildschirm" : "aus FRED_API_KEY";
  const geheimnisse = [fredKey, FRED_ENV_KEY, UCDP_TOKEN].filter(Boolean);

  const qp = (event && event.queryStringParameters) || {};
  const only = (qp.only || "").trim().toLowerCase();
  const alle = [...PROBES, ...schluesselProbe(fredKey, fredWoher)];
  const list = only ? alle.filter((p) => p.key.includes(only)) : alle;

  // PARALLEL, nicht nacheinander.
  //
  // Vorher liefen die Proben sequenziell, mit der Begruendung, sie wuerden sich
  // sonst gegenseitig das Zeitbudget nehmen. Der Livebetrieb hat gezeigt, dass
  // genau das Gegenteil eintritt: vier tote FRED-Proben a 6s ergaben 24s und
  // sprengten das 20s-Budget - alles danach (UCDP, GDELT, Yahoo,
  // Stooq, Frankfurter) wurde uebersprungen. Der Bericht meldete "0 OK" und
  // verschwieg ausgerechnet die Quellen, die funktionieren.
  //
  // Die Proben treffen verschiedene Hosts und warten fast nur auf das Netz;
  // sie konkurrieren also gar nicht um dieselbe Ressource. Parallel kostet der
  // Durchlauf so viel wie die LANGSAMSTE Probe statt der Summe aller - und
  // liefert immer ein vollstaendiges Bild. Genau das ist der Zweck einer
  // Diagnose: eine tote Quelle darf die Aussage ueber die anderen nicht
  // verhindern.
  const roh = await Promise.all(list.map((p) => probe(p)));
  // Zweite Verteidigungslinie: falls ein Anbieter den gesendeten Schluessel in
  // seiner Fehlermeldung zurueckspiegelt, wird er hier entfernt, bevor der
  // Auszug im UI landet.
  const results = roh.map((r) => Object.assign({}, r, {
    bodySnippet: redigiere(r.bodySnippet, geheimnisse),
    error: redigiere(r.error, geheimnisse),
    errorCause: redigiere(r.errorCause, geheimnisse),
    warning: redigiere(r.warning, geheimnisse),
    url: redigiere(r.url, geheimnisse),
  }));

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
      // Beantwortet die Frage, die keine einzelne Probe beantworten kann:
      // KOMMT der Schluessel ueberhaupt an? Ein 400 "api_key is not set" sagt
      // das nicht - die entsprechende Probe schickt bewusst keinen Schluessel.
      // Ausgegeben wird ausschliesslich OB und WIE LANG, nie der Wert.
      konfiguration: [
        {
          name: "FRED_API_KEY",
          zweck: "F4 MAKRO – US- und Euro-Konjunkturdaten",
          gesetzt: !!fredKey,
          quelle: fredKey ? fredWoher : null,
          laenge: fredKey ? fredKey.length : 0,
          hinweis: fredKey
            ? "Ob er GUELTIG ist, zeigt die Probe „FRED offizielle API MIT Schluessel“."
            : "Ohne Schluessel liefert FRED seit November 2025 nichts. Gratis unter https://fredaccount.stlouisfed.org/apikey – dann im Startbildschirm eintragen oder als FRED_API_KEY hinterlegen.",
        },
        {
          name: "UCDP_ACCESS_TOKEN",
          zweck: "F6 WELTLAGE – dynamische Liste aktiver Konfliktlaender",
          gesetzt: !!UCDP_TOKEN,
          quelle: UCDP_TOKEN ? "aus UCDP_ACCESS_TOKEN" : null,
          laenge: UCDP_TOKEN ? UCDP_TOKEN.length : 0,
          hinweis: UCDP_TOKEN
            ? null
            : "Optional. Ohne Token laeuft F6 auf der kuratierten 20-Laender-Liste. Token gratis per Mail an mertcan.yilmaz@pcr.uu.se.",
        },
      ],
      zusammenfassung: summary,
      proben: results,
    }, null, 2),
  };
};

exports._internal = { PROBES, probe, redigiere, header, schluesselProbe };
