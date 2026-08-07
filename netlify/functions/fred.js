// Netlify Function: /.netlify/functions/fred?ids=UNRATE,CPIAUCSL,...  (Batch, 1 Aufruf fuer alle Serien)
//                    /.netlify/functions/fred?id=UNRATE               (Einzelabruf, Legacy)
//
// Makrodaten mit Fallback-Kette (beide Quellen ohne API-Key):
//   1. FRED CSV-Endpunkt (fredgraph.csv)
//   2. DBnomics (spiegelt FRED-Serien)
// Faellt eine Quelle wiederholt aus, wird sie dank Circuit Breaker eine Zeit
// lang uebersprungen, statt bei jedem Aufruf erneut ins Timeout zu laufen.
//
// UNGETESTET: Der DBnomics-Abruf konnte in der Entwicklungsumgebung nicht gegen
// die echte API geprueft werden (kein Netzwerkzugriff). Das Parsen ist bewusst
// defensiv - unerwartete Antwortformen fuehren zu null (= naechster Provider
// bzw. "keine Daten"), nicht zu einem Absturz.

const { tryChain, fetchWithTimeout, breakerState } = require("./lib/providers");

const CACHE = new Map(); const TTL = 10 * 60 * 1000; // 10 Min
// Bekannte Serien: passender Ruecklauf-Zeitraum je nach Frequenz (Tages-/Monats-/Quartalsdaten).
const DEFAULT_YEARS = { UNRATE: 10, CPIAUCSL: 10, FEDFUNDS: 10, DGS10: 1, T10Y2Y: 1, GDP: 30, PAYEMS: 10, UMCSENT: 10, MORTGAGE30US: 3, M2SL: 10 };

// Feste Provider-Timeouts sind hier bewusst NICHT die einzige Bremse: fetchOne()
// bekommt zusaetzlich ein gemeinsames deadline ueber ALLE Serien und Wellen
// hinweg, gegen das jeder Provider-Aufruf seinen eigenen Timeout zusaetzlich
// kappt. Ohne das konnte eine einzelne Serie im Worst Case (FRED-Timeout +
// DBnomics ueber 2 Kandidaten) schon fast 10s brauchen - mal 4 Wellen fuer die
// 10 Makro-Serien haette das Netlify-Funktionslimit (Standard 10s) klar
// gerissen und die GANZE Antwort waere verlorengegangen statt nur einzelner
// Serien, die dann als "nicht verfuegbar" markiert werden.
const FRED_CSV_TIMEOUT = 3000;
const DBNOMICS_TIMEOUT = 2500;
const FUNCTION_BUDGET_MS = 8500; // Sicherheitsabstand unter Netlifys 10s-Standardlimit
const MIN_ATTEMPT_MS = 500; // unter dieser Restzeit lohnt kein weiterer Versuch mehr

function timeLeft(deadline) { return deadline - Date.now(); }

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/csv,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://fred.stlouisfed.org/",
};

// Aus rohen {t, v}-Punkten das einheitliche Ausgabeformat bauen.
function shapeSeries(id, rows) {
  if (!rows || !rows.length) return null;
  const series = rows.slice(-90); // letzte ~90 Punkte
  const latest = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : null;
  return {
    id,
    latest: latest ? latest.v : null,
    latestDate: latest ? latest.t : null,
    chg: (latest && prev) ? +(latest.v - prev.v).toFixed(2) : null,
    series,
  };
}

// --- Provider 1: FRED CSV -------------------------------------------------
async function fromFredCsv(id, years, timeoutMs) {
  const cosd = new Date(); cosd.setFullYear(cosd.getFullYear() - years);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${cosd.toISOString().slice(0, 10)}`;
  const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS }, timeoutMs || FRED_CSV_TIMEOUT);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 150).replace(/\s+/g, " ").trim(); } catch (_) {}
    throw new Error(`FRED HTTP ${res.status}${detail ? " – " + detail : ""}`);
  }
  const txt = await res.text();
  // FRED liefert bei Bot-Erkennung eine HTML-Seite MIT Status 200. Ohne diese
  // Pruefung lief das als "leeres/ungueltiges Ergebnis" durch und man sah nie,
  // dass in Wahrheit eine Sperrseite zurueckkam.
  const head = txt.slice(0, 200).trim();
  if (/^\s*</.test(head)) throw new Error("FRED lieferte HTML statt CSV (vermutlich Bot-Sperre): " + head.replace(/\s+/g, " ").slice(0, 120));
  // Zeilenenden koennen \r\n sein - sonst haengt am letzten Feld ein \r.
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 3) throw new Error(`FRED: zu wenige Zeilen (${lines.length}) – Inhalt: ${txt.slice(0, 120).replace(/\s+/g, " ")}`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const t = (parts[0] || "").trim(); const v = parseFloat(parts[1]);
    // Fehlende Werte schreibt FRED als "." - parseFloat ergibt NaN, wird uebersprungen.
    if (t && !isNaN(v)) rows.push({ t, v });
  }
  if (!rows.length) throw new Error(`FRED: keine verwertbaren Datenzeilen – Kopf: ${lines.slice(0, 2).join(" / ").slice(0, 120)}`);
  return shapeSeries(id, rows);
}

// --- Provider 2: DBnomics -------------------------------------------------
// DBnomics spiegelt FRED unter dem Provider-Code "FRED". Die genaue Pfadform
// (Dataset-Ebene) konnte hier nicht verifiziert werden, deshalb werden zwei
// plausible Varianten probiert und die Antwort formunabhaengig ausgewertet:
// gesucht werden schlicht parallele period[]/value[]-Arrays, egal wie tief
// verschachtelt.
function findObservations(node, depth) {
  if (!node || typeof node !== "object" || (depth || 0) > 6) return null;
  const periods = node.period || node.periods;
  const values = node.value || node.values;
  if (Array.isArray(periods) && Array.isArray(values) && periods.length && periods.length === values.length) {
    return { periods, values };
  }
  for (const k of Object.keys(node)) {
    const child = node[k];
    if (Array.isArray(child)) {
      for (const item of child) { const hit = findObservations(item, (depth || 0) + 1); if (hit) return hit; }
    } else if (child && typeof child === "object") {
      const hit = findObservations(child, (depth || 0) + 1); if (hit) return hit;
    }
  }
  return null;
}

async function fromDbnomics(id, years, deadline) {
  const candidates = [
    // Wahrscheinlichste Form zuerst: bei DBnomics ist fuer FRED-gespiegelte Serien
    // der Dataset-Code oft identisch zur eigentlichen Serien-ID (3-Segment-Pfad).
    `https://api.db.nomics.world/v22/series/FRED/${encodeURIComponent(id)}/${encodeURIComponent(id)}?observations=1`,
    `https://api.db.nomics.world/v22/series/FRED/${encodeURIComponent(id)}?observations=1`,
    `https://api.db.nomics.world/v22/series?series_ids=FRED/${encodeURIComponent(id)}&observations=1`,
  ];
  let lastErr = null;
  for (const url of candidates) {
    // Gemeinsames Zeitbudget respektieren: ohne genug Restzeit lohnt kein
    // weiterer Kandidat mehr - lieber sauber als "keine Zeit mehr" scheitern,
    // statt das Gesamtbudget aller Serien/Wellen zu reissen.
    const remaining = deadline ? timeLeft(deadline) : DBNOMICS_TIMEOUT;
    if (remaining < MIN_ATTEMPT_MS) { lastErr = lastErr || new Error("Zeitbudget erreicht"); break; }
    const timeoutMs = Math.max(MIN_ATTEMPT_MS, Math.min(DBNOMICS_TIMEOUT, remaining));
    try {
      const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": BROWSER_HEADERS["User-Agent"] } }, timeoutMs);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 120).replace(/\s+/g, " ").trim(); } catch (_) {}
        lastErr = new Error(`DBnomics HTTP ${res.status}${detail ? " – " + detail : ""}`);
        continue;
      }
      const json = await res.json();
      const obs = findObservations(json, 0);
      if (!obs) { lastErr = new Error("DBnomics: keine period/value-Arrays gefunden"); continue; }
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - years);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const rows = [];
      for (let i = 0; i < obs.periods.length; i++) {
        const t = String(obs.periods[i]); const v = parseFloat(obs.values[i]);
        if (t && !isNaN(v) && t >= cutoffStr) rows.push({ t, v });
      }
      const shaped = shapeSeries(id, rows);
      if (shaped) return shaped;
      lastErr = new Error("DBnomics: keine verwertbaren Datenpunkte");
    } catch (e) {
      lastErr = e;
      // Timeout = Host nicht erreichbar. Die zweite Pfadvariante wuerde nur ein
      // weiteres Timeout kosten - nur bei echten HTTP-/Formatfehlern lohnt sie.
      if (e && e.isTimeout) break;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function fetchOne(id, yearsIn, deadline) {
  const years = Math.min(50, Math.max(1, parseInt(yearsIn || DEFAULT_YEARS[id] || 10, 10) || 10));
  const cacheKey = `${id}:${years}`;
  const c = CACHE.get(cacheKey);
  if (c && Date.now() - c.ts < TTL) return c.data;

  if (deadline && timeLeft(deadline) < MIN_ATTEMPT_MS) {
    if (c) return Object.assign({}, c.data, { stale: true });
    return { id, error: "Zeitbudget erreicht, bevor diese Serie an der Reihe war" };
  }

  const result = await tryChain([
    { name: "fred", run: () => fromFredCsv(id, years, deadline ? Math.max(MIN_ATTEMPT_MS, Math.min(FRED_CSV_TIMEOUT, timeLeft(deadline))) : FRED_CSV_TIMEOUT) },
    { name: "dbnomics", run: () => fromDbnomics(id, years, deadline) },
  ]);

  if (!result.data) {
    // Abgelaufener Cache ist immer noch besser als gar nichts.
    if (c) return Object.assign({}, c.data, { stale: true });
    const detail = result.attempts.map((a) => `${a.name}: ${a.skipped || a.error || "?"}`).join(" | ");
    return { id, error: "Keine Quelle lieferte Daten (" + detail + ")" };
  }
  const data = Object.assign({}, result.data, { source: result.source });
  CACHE.set(cacheKey, { ts: Date.now(), data });
  return data;
}

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const qp = event.queryStringParameters || {};
  const isBatch = !!qp.ids;
  const raw = (qp.ids || qp.id || "").trim().toUpperCase();
  if (!raw) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "id(s) fehlen" }) };
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!ids.length || ids.some((id) => !/^[A-Z0-9]{1,20}$/.test(id))) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "id ungueltig" }) };

  try {
    // Begrenzte Parallelitaet statt Promise.all ueber alle Serien: Wenn eine Quelle
    // tot ist, laeuft sonst JEDE Serie gleichzeitig in ihr eigenes Timeout, weil alle
    // starten bevor die erste einen Fehler gemeldet hat - der Circuit Breaker greift
    // dann erst beim naechsten Seitenaufruf. Mit Wellen von 3 loest die erste Welle
    // den Breaker aus und alle uebrigen Serien brechen sofort ab.
    //
    // Zusaetzlich ein gemeinsames Zeitbudget UEBER ALLE Wellen hinweg (siehe
    // FUNCTION_BUDGET_MS oben): ohne das konnte im Worst Case eine einzelne
    // Welle schon fast das Netlify-Funktionslimit ausschoepfen, wodurch die
    // GESAMTE Antwort verlorenging statt nur einzelner Serien.
    const deadline = Date.now() + FUNCTION_BUDGET_MS;
    const results = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      if (timeLeft(deadline) < MIN_ATTEMPT_MS) {
        for (const id of ids.slice(i)) results.push([id, { id, error: "Zeitbudget erreicht" }]);
        break;
      }
      const wave = ids.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(wave.map(async (id) => {
        try { return [id, await fetchOne(id, qp.years, deadline)]; } catch (e) { return [id, { id, error: String(e && e.message || e) }]; }
      }));
      results.push(...settled);
    }
    const out = Object.fromEntries(results);
    if (!isBatch) return { statusCode: 200, headers: cors, body: JSON.stringify(out[ids[0]]) };
    return { statusCode: 200, headers: { ...cors, "X-Breakers": JSON.stringify(breakerState()) }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};

// Fuer Tests: Einzelfunktionen ohne HTTP-Handler-Wrapper zugaenglich machen.
exports._internal = { fetchOne, fromFredCsv, fromDbnomics, shapeSeries, findObservations, FUNCTION_BUDGET_MS, MIN_ATTEMPT_MS };
