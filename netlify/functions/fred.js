// Netlify Function: /.netlify/functions/fred?ids=UNRATE,CPIAUCSL,...  (Batch, 1 Aufruf fuer alle Serien)
//                    /.netlify/functions/fred?id=UNRATE               (Einzelabruf, Legacy)
//
// Makrodaten ausschliesslich ueber den FRED-CSV-Endpunkt (fredgraph.csv), ohne
// API-Key. Deckt neben US-Serien auch Euro-Raum-Serien ab, weil FRED zahlreiche
// OECD-/ECB-Reihen unter regulaeren FRED-IDs mitfuehrt (z.B. ECBDFR fuer den
// EZB-Einlagensatz) - dieselbe Function/Pipeline bedient also beide Regionen,
// ohne einen zweiten Provider zu integrieren.
//
// FRUEHER gab es hier zusaetzlich DBnomics als Rueckfallebene. Per Live-
// Diagnose auf der echten Instanz nachweislich tot: beide Pfadformen
// scheiterten mit "Could not find storage directory for provider 'FRED'" -
// keine Frage der URL-Form, DBnomics selbst findet die Daten nicht. Entfernt.
//
// Faellt der Sammelabruf wiederholt aus, wird er dank Circuit Breaker eine
// Zeit lang uebersprungen, statt bei jedem Aufruf erneut ins Timeout zu laufen.

const { tryChain, fetchWithTimeout, breakerState } = require("./lib/providers");

const CACHE = new Map(); const TTL = 10 * 60 * 1000; // 10 Min
// Bekannte Serien: passender Ruecklauf-Zeitraum je nach Frequenz (Tages-/Monats-/Quartalsdaten).
const DEFAULT_YEARS = {
  // US
  UNRATE: 10, CPIAUCSL: 10, FEDFUNDS: 10, DGS10: 1, T10Y2Y: 1, GDP: 30, PAYEMS: 10, UMCSENT: 10, MORTGAGE30US: 3, M2SL: 10,
  // Euro-Raum (ueber FRED gespiegelte Eurostat-/EZB-Reihen - siehe MACRO_PRESETS in market-data.js)
  ECBDFR: 10, CP0000EZ19M086NEST: 10, IRLTLT01DEM156N: 10, CLVMEURSCAB1GQEA19: 30,
};

// ERWARTETE AKTUALITAET je Serie, in Tagen - der wichtigste Schutz gegen eine
// stille Falschauskunft.
//
// Hintergrund: FRED stellt Serien ein, ohne sie zu entfernen. Eine eingestellte
// Serie antwortet weiter mit HTTP 200 und gueltigem CSV - nur eben mit Werten,
// die Jahre alt sind. Im UI sah das exakt aus wie ein frischer Wert. Genau das
// ist mit LRHUTTTTEZM156S passiert (Euro-Arbeitslosenquote, endet im Januar
// 2023): kein Fehler, keine Warnung, einfach eine falsche Zahl.
//
// Die Schwellen sind bewusst SEHR grosszuegig gewaehlt. Gesucht wird ein totes
// Band, kein verspaeteter Veroeffentlichungstermin - und der Unterschied ist
// riesig: eine eingestellte Serie ist um Jahre daneben (LRHUTTTTEZM156S lag bei
// ueber 1300 Tagen), waehrend normale Verzoegerungen sich in Wochen bewegen.
//
// Enge Schwellen waeren hier der schlimmere Fehler: Monatsdaten sind - je nach
// Quelle und Stichtag - regelmaessig zwei bis drei Monate alt (Eurostat
// veroeffentlicht spaeter als US-Behoerden, FRED datiert Monatswerte zudem auf
// den Monatsersten). Eine Warnung, die deshalb staendig erscheint, wuerde
// ueberlesen - und damit den einen Fall verdecken, fuer den sie da ist.
const MAX_AGE_DAYS = {
  // taeglich / woechentlich
  DGS10: 14, T10Y2Y: 14, ECBDFR: 21, MORTGAGE30US: 30,
  // Monatlich, einheitlich 150 Tage. US-Behoerden liefern zwar schneller als
  // Eurostat, aber eine Unterscheidung waere hier falsche Genauigkeit: gegen
  // die 1300+ Tage einer eingestellten Serie macht es keinen Unterschied, ob
  // die Schwelle bei 110 oder 150 liegt - fuer den Fehlalarm dagegen schon.
  UNRATE: 150, CPIAUCSL: 150, FEDFUNDS: 150, PAYEMS: 150, UMCSENT: 150, M2SL: 150,
  CP0000EZ19M086NEST: 150, IRLTLT01DEM156N: 150,
  // quartalsweise
  GDP: 260, CLVMEURSCAB1GQEA19: 260,
};
const MAX_AGE_FALLBACK_DAYS = 400; // unbekannte Serie: nur ein wirklich totes Band melden

// Ergaenzt eine Serie um ihr Alter und - falls ueberfaellig - um einen
// erklaerenden Hinweis. Bewusst NICHT als Fehler behandelt: der Wert stimmt ja,
// er ist nur alt. Das UI zeigt ihn weiter an, aber deutlich markiert.
function markiereAktualitaet(shaped, id, now) {
  if (!shaped || !shaped.latestDate) return shaped;
  const ts = Date.parse(shaped.latestDate + "T00:00:00Z");
  if (isNaN(ts)) return shaped;
  const ageDays = Math.floor(((now || Date.now()) - ts) / 864e5);
  shaped.ageDays = ageDays;
  const limit = MAX_AGE_DAYS[id] != null ? MAX_AGE_DAYS[id] : MAX_AGE_FALLBACK_DAYS;
  if (ageDays > limit) {
    shaped.outdated = true;
    shaped.outdatedNote = `letzter Wert ist ${ageDays} Tage alt (erwartet: hoechstens ${limit}) – Serie moeglicherweise eingestellt`;
  }
  return shaped;
}

// Zeitbudget - Hintergrund aus dem Livebetrieb:
//
// Zuvor holte diese Function jede Serie EINZELN (10 Anfragen in 4 Wellen). Damit
// das unter Netlifys 10s-Limit passte, war der FRED-Timeout auf 3000ms gedrueckt -
// zu knapp: In der Diagnose meldete jede Serie "fred: Timeout nach 3000ms", und
// nach drei Fehlschlaegen machte der Circuit Breaker die restlichen sechs Serien
// gleich mit ("circuit-open"). Ergebnis: F4 MAKRO komplett leer.
//
// Loesung: fredgraph.csv kann MEHRERE Serien in einer einzigen Antwort liefern
// (id=UNRATE,CPIAUCSL,...). Ein Abruf statt zehn - dadurch ist ein grosszuegiger
// Timeout problemlos im Budget, und ein einzelner langsamer Abruf kann keine
// Kaskade mehr ausloesen.
const FRED_BATCH_TIMEOUT = 6000;  // ein Sammelabruf fuer alle Serien
const FRED_CSV_TIMEOUT = 4000;    // Einzelabruf, nur noch als Rueckfallebene
const FUNCTION_BUDGET_MS = 9000;  // Sicherheitsabstand unter Netlifys 10s-Standardlimit
const MIN_ATTEMPT_MS = 500;       // unter dieser Restzeit lohnt kein weiterer Versuch mehr
// Gemeinsames Startdatum fuer den Sammelabruf. Angezeigt werden ohnehin nur die
// letzten ~90 Punkte je Serie (siehe shapeSeries), deshalb reicht ein Fenster,
// das auch fuer Quartalsdaten wie GDP genug Punkte liefert.
const BATCH_YEARS = 12;

function timeLeft(deadline) { return deadline - Date.now(); }

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/csv,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://fred.stlouisfed.org/",
};

// Aus rohen {t, v}-Punkten das einheitliche Ausgabeformat bauen. Die
// Aktualitaetspruefung sitzt bewusst HIER und nicht in den einzelnen Abruf-
// funktionen: so gilt sie fuer den Sammelabruf und den Einzelabruf gleicher-
// massen, und eine kuenftige dritte Quelle bekommt sie automatisch mit.
function shapeSeries(id, rows, now) {
  if (!rows || !rows.length) return null;
  const series = rows.slice(-90); // letzte ~90 Punkte
  const latest = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : null;
  return markiereAktualitaet({
    id,
    latest: latest ? latest.v : null,
    latestDate: latest ? latest.t : null,
    chg: (latest && prev) ? +(latest.v - prev.v).toFixed(2) : null,
    series,
  }, id, now);
}

// Erkennt eine Sperr-/Fehlerseite, die FRED auch mal mit Status 200 ausliefert.
function assertLooksLikeCsv(txt) {
  const head = txt.slice(0, 200).trim();
  if (/^\s*</.test(head)) throw new Error("FRED lieferte HTML statt CSV (vermutlich Bot-Sperre): " + head.replace(/\s+/g, " ").slice(0, 120));
}

// --- Provider 0: FRED CSV als SAMMELABRUF (Hauptweg) -----------------------
// fredgraph.csv?id=A,B,C liefert eine Tabelle mit einer Spalte je Serie:
//   DATE,UNRATE,CPIAUCSL
//   2020-01-01,3.5,257.9
//   2020-02-01,3.5,.          <- "." = kein Wert an diesem Datum
// Fehlende Werte entstehen zwangslaeufig, weil die Serien unterschiedliche
// Frequenzen haben (taeglich/monatlich/quartalsweise) und hier auf ein
// gemeinsames Datumsraster gelegt werden. Sie werden je Spalte uebersprungen.
async function fromFredCsvBatch(ids, timeoutMs) {
  const cosd = new Date(); cosd.setFullYear(cosd.getFullYear() - BATCH_YEARS);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(ids.join(","))}&cosd=${cosd.toISOString().slice(0, 10)}`;
  const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS }, timeoutMs || FRED_BATCH_TIMEOUT);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 150).replace(/\s+/g, " ").trim(); } catch (_) {}
    throw new Error(`FRED-Sammelabruf HTTP ${res.status}${detail ? " – " + detail : ""}`);
  }
  const txt = await res.text();
  assertLooksLikeCsv(txt);
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 3) throw new Error(`FRED-Sammelabruf: zu wenige Zeilen (${lines.length}) – Inhalt: ${txt.slice(0, 120).replace(/\s+/g, " ")}`);

  // Kopfzeile: erste Spalte ist das Datum, danach je Serie eine Spalte. Die
  // Reihenfolge/Schreibweise wird NICHT angenommen, sondern aus dem Kopf gelesen -
  // FRED benennt die Datumsspalte je nach Endpunkt "DATE" oder "observation_date".
  const header = lines[0].split(",").map((h) => h.trim().toUpperCase());
  const colOf = {};
  for (const id of ids) { const i = header.indexOf(id.toUpperCase()); if (i > 0) colOf[id] = i; }
  if (!Object.keys(colOf).length) throw new Error("FRED-Sammelabruf: keine der angefragten Serien in der Kopfzeile gefunden – Kopf: " + lines[0].slice(0, 150));

  const rowsById = {}; for (const id of Object.keys(colOf)) rowsById[id] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const t = (parts[0] || "").trim();
    if (!t) continue;
    for (const id of Object.keys(colOf)) {
      const v = parseFloat(parts[colOf[id]]);
      if (!isNaN(v)) rowsById[id].push({ t, v });
    }
  }
  const out = {};
  for (const id of Object.keys(rowsById)) { const shaped = shapeSeries(id, rowsById[id]); if (shaped) out[id] = shaped; }
  if (!Object.keys(out).length) throw new Error("FRED-Sammelabruf: keine verwertbaren Datenzeilen");
  return out;
}

// --- Provider 1: FRED CSV, Einzelabruf (Rueckfallebene) --------------------
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
    const deadline = Date.now() + FUNCTION_BUDGET_MS;
    const results = [];

    // SCHRITT 1: Ein einziger Sammelabruf fuer alle Serien. Das ist der Normalweg
    // und ersetzt die frueheren zehn Einzelanfragen samt Timeout-Kaskade.
    const stillMissing = [];
    const cachedHits = {};
    for (const id of ids) {
      const years = Math.min(50, Math.max(1, parseInt(qp.years || DEFAULT_YEARS[id] || 10, 10) || 10));
      const c = CACHE.get(`${id}:${years}`);
      if (c && Date.now() - c.ts < TTL) cachedHits[id] = c.data; else stillMissing.push(id);
    }

    let batchError = null;
    if (stillMissing.length) {
      try {
        const budget = Math.max(MIN_ATTEMPT_MS, Math.min(FRED_BATCH_TIMEOUT, timeLeft(deadline)));
        const batch = await fromFredCsvBatch(stillMissing, budget);
        for (const id of Object.keys(batch)) {
          const years = Math.min(50, Math.max(1, parseInt(qp.years || DEFAULT_YEARS[id] || 10, 10) || 10));
          const data = Object.assign({}, batch[id], { source: "fred" });
          CACHE.set(`${id}:${years}`, { ts: Date.now(), data });
          cachedHits[id] = data;
        }
      } catch (e) {
        batchError = String((e && e.message) || e);
      }
    }

    for (const id of ids) if (cachedHits[id]) results.push([id, cachedHits[id]]);
    const remaining = ids.filter((id) => !cachedHits[id]);

    // SCHRITT 2: Nur was der Sammelabruf nicht abgedeckt hat, einzeln nachholen -
    // in Wellen und weiterhin gegen dasselbe Gesamt-Zeitbudget. Der Grund des
    // Sammel-Fehlschlags wird angehaengt, damit im UI nicht nur der Einzelfehler
    // steht, sondern auch warum der Hauptweg nicht griff.
    const CONCURRENCY = 3;
    for (let i = 0; i < remaining.length; i += CONCURRENCY) {
      if (timeLeft(deadline) < MIN_ATTEMPT_MS) {
        for (const id of remaining.slice(i)) {
          results.push([id, { id, error: "Zeitbudget erreicht" + (batchError ? " (Sammelabruf zuvor: " + batchError + ")" : "") }]);
        }
        break;
      }
      const wave = remaining.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(wave.map(async (id) => {
        try { return [id, await fetchOne(id, qp.years, deadline)]; } catch (e) { return [id, { id, error: String(e && e.message || e) }]; }
      }));
      results.push(...settled);
    }

    const out = Object.fromEntries(results);
    if (batchError) {
      for (const id of Object.keys(out)) {
        if (out[id] && out[id].error) out[id].error += " | Sammelabruf: " + batchError;
      }
    }
    if (!isBatch) return { statusCode: 200, headers: cors, body: JSON.stringify(out[ids[0]]) };
    return { statusCode: 200, headers: { ...cors, "X-Breakers": JSON.stringify(breakerState()) }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};

// Fuer Tests: Einzelfunktionen ohne HTTP-Handler-Wrapper zugaenglich machen.
exports._internal = { fetchOne, fromFredCsv, fromFredCsvBatch, shapeSeries, markiereAktualitaet, MAX_AGE_DAYS, MAX_AGE_FALLBACK_DAYS, FUNCTION_BUDGET_MS, MIN_ATTEMPT_MS, BATCH_YEARS };
