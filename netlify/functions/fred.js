// Netlify Function: /.netlify/functions/fred?id=UNRATE
// Holt FRED-Makrodaten server-seitig (CSV, ohne API-Key) und gibt JSON zurueck.

const CACHE = new Map(); const TTL = 10 * 60 * 1000; // 10 Min

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const id = (event.queryStringParameters && event.queryStringParameters.id || "").trim().toUpperCase();
  if (!id || !/^[A-Z0-9]{1,20}$/.test(id)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "id fehlt/ungueltig" }) };
  const years = Math.min(50, Math.max(1, parseInt((event.queryStringParameters && event.queryStringParameters.years) || "10", 10) || 10));

  const cacheKey = `${id}:${years}`;
  const c = CACHE.get(cacheKey);
  if (c && Date.now() - c.ts < TTL) return { statusCode: 200, headers: { ...cors, "X-Cache": "hit" }, body: JSON.stringify(c.data) };

  try {
    const cosd = new Date(); cosd.setFullYear(cosd.getFullYear() - years);
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${cosd.toISOString().slice(0, 10)}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv,*/*" } });
    if (!res.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: `FRED HTTP ${res.status}` }) };
    const txt = await res.text();
    const lines = txt.trim().split("\n");
    if (lines.length < 3) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Keine Daten" }) };
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
    return { statusCode: 200, headers: { ...cors, "X-Cache": "miss" }, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
