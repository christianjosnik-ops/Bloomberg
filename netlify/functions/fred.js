// Netlify Function: /.netlify/functions/fred?ids=UNRATE,CPIAUCSL,...  (Batch, 1 Aufruf fuer alle Serien)
//                    /.netlify/functions/fred?id=UNRATE               (Einzelabruf, Legacy)
// Holt FRED-Makrodaten server-seitig (CSV, ohne API-Key) und gibt JSON zurueck.

const CACHE = new Map(); const TTL = 10 * 60 * 1000; // 10 Min
// Bekannte Serien: passender Ruecklauf-Zeitraum je nach Frequenz (Tages-/Monats-/Quartalsdaten).
const DEFAULT_YEARS = { UNRATE: 10, CPIAUCSL: 10, FEDFUNDS: 10, DGS10: 1, T10Y2Y: 1, GDP: 30, PAYEMS: 10, UMCSENT: 10, MORTGAGE30US: 3, M2SL: 10 };

async function fetchOne(id, yearsIn) {
  const years = Math.min(50, Math.max(1, parseInt(yearsIn || DEFAULT_YEARS[id] || 10, 10) || 10));
  const cacheKey = `${id}:${years}`;
  const c = CACHE.get(cacheKey);
  if (c && Date.now() - c.ts < TTL) return c.data;

  const cosd = new Date(); cosd.setFullYear(cosd.getFullYear() - years);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${cosd.toISOString().slice(0, 10)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv,*/*" } });
  if (!res.ok) return { error: `FRED HTTP ${res.status}` };
  const txt = await res.text();
  const lines = txt.trim().split("\n");
  if (lines.length < 3) return { error: "Keine Daten" };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const t = parts[0]; const v = parseFloat(parts[1]);
    if (t && !isNaN(v)) rows.push({ t, v });
  }
  const series = rows.slice(-90); // letzte ~90 Punkte
  const latest = series.length ? series[series.length - 1] : null;
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const data = {
    id, latest: latest ? latest.v : null, latestDate: latest ? latest.t : null,
    chg: (latest && prev) ? +(latest.v - prev.v).toFixed(2) : null,
    series,
  };
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
    const results = await Promise.all(ids.map(async (id) => {
      try { return [id, await fetchOne(id, qp.years)]; } catch (e) { return [id, { error: String(e && e.message || e) }]; }
    }));
    const out = Object.fromEntries(results);
    if (!isBatch) return { statusCode: 200, headers: cors, body: JSON.stringify(out[ids[0]]) };
    return { statusCode: 200, headers: cors, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
