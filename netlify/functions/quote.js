// Netlify Function: /.netlify/functions/quote?symbol=RHM.DE
// Yahoo-Finance-Proxy mit: In-Memory-Cache (90s), Crumb+Cookie-Handshake,
// moderatem Retry/Backoff (innerhalb ~10s Limit) und UA-Rotation.

const UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile Safari/604.1",
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];
const baseHeaders = (ua) => ({ "User-Agent": ua, "Accept": "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Cache (überlebt, solange die Function-Instanz warm ist) ---
const CACHE = new Map(); // symbol -> { ts, data }
const TTL = 90 * 1000;

// --- Yahoo-Session (Cookie + Crumb), einmal holen & wiederverwenden ---
let SESSION = { cookie: null, crumb: null, ts: 0 };
const SESSION_TTL = 20 * 60 * 1000;

async function getSession(ua) {
  if (SESSION.cookie && SESSION.crumb && (Date.now() - SESSION.ts) < SESSION_TTL) return SESSION;
  try {
    // 1) Cookie holen
    const r1 = await fetch("https://fc.yahoo.com/", { headers: baseHeaders(ua) });
    let cookie = r1.headers.get("set-cookie") || "";
    cookie = cookie.split(",").map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    // 2) Crumb mit Cookie holen
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { ...baseHeaders(ua), ...(cookie ? { Cookie: cookie } : {}) },
    });
    const crumb = (await r2.text()).trim();
    if (crumb && crumb.length < 40 && !crumb.includes("<")) {
      SESSION = { cookie, crumb, ts: Date.now() };
    }
  } catch (_) { /* Session bleibt leer -> ohne crumb weiter */ }
  return SESSION;
}

async function fetchChart(symbol) {
  const hosts = ["query1", "query2"];
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ua = pickUA();
    const sess = await getSession(ua);
    const crumbQ = sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : "";
    const headers = { ...baseHeaders(ua), ...(sess.cookie ? { Cookie: sess.cookie } : {}) };
    for (const host of hosts) {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d${crumbQ}`;
      try {
        const res = await fetch(url, { headers });
        if (res.ok) return await res.json();
        lastStatus = res.status;
        if (res.status === 401 || res.status === 403) { SESSION = { cookie: null, crumb: null, ts: 0 }; } // Session neu holen
      } catch (_) { lastStatus = -1; }
    }
    if (attempt < 3) await sleep(500 + attempt * 700); // 0.5s, 1.2s, 1.9s -> gesamt < 10s
  }
  return { __error: `Yahoo HTTP ${lastStatus}` };
}

function shape(data, symbol) {
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) return null;
  const meta = result.meta;
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = q.close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c != null && !isNaN(c)) series.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), p: +(+c).toFixed(2) });
  }
  const price = meta.regularMarketPrice != null ? +(+meta.regularMarketPrice).toFixed(2) : (series.length ? series[series.length - 1].p : null);
  const prevClose = meta.chartPreviousClose != null ? +(+meta.chartPreviousClose).toFixed(2)
    : (meta.previousClose != null ? +(+meta.previousClose).toFixed(2) : (series.length > 1 ? series[series.length - 2].p : null));
  const chg = (price != null && prevClose != null) ? +(price - prevClose).toFixed(2) : null;
  const chgPct = (price != null && prevClose != null && prevClose !== 0) ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null;
  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || meta.symbol || symbol,
    currency: meta.currency || "",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    price, prevClose, chg, chgPct,
    open: meta.regularMarketOpen != null ? +(+meta.regularMarketOpen).toFixed(2) : null,
    high: meta.regularMarketDayHigh != null ? +(+meta.regularMarketDayHigh).toFixed(2) : null,
    low: meta.regularMarketDayLow != null ? +(+meta.regularMarketDayLow).toFixed(2) : null,
    series,
  };
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || "").trim();
  if (!symbol) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "symbol fehlt" }) };

  // 1) Frischer Cache-Treffer -> sofort ausliefern
  const cached = CACHE.get(symbol);
  if (cached && (Date.now() - cached.ts) < TTL) {
    return { statusCode: 200, headers: { ...cors, "X-Cache": "hit" }, body: JSON.stringify(cached.data) };
  }

  try {
    const data = await fetchChart(symbol);
    if (data.__error) {
      // 2) Fehlgeschlagen, aber alter Cache vorhanden -> lieber alte Daten als Fehler
      if (cached) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cached.data) };
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: data.__error + " (Yahoo drosselt, kurz erneut versuchen)" }) };
    }
    const out = shape(data, symbol);
    if (!out) {
      const msg = (data && data.chart && data.chart.error && data.chart.error.description) || "Kein Ergebnis (Ticker pruefen)";
      if (cached) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cached.data) };
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: msg }) };
    }
    CACHE.set(symbol, { ts: Date.now(), data: out });
    return { statusCode: 200, headers: { ...cors, "X-Cache": "miss" }, body: JSON.stringify(out) };
  } catch (e) {
    if (cached) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cached.data) };
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
