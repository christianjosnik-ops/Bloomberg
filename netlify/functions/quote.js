// Netlify Function: /.netlify/functions/quote?symbol=RHM.DE
// Yahoo-Finance-Proxy: Chart + quoteSummary (Kennzahlen, Analysten-Empfehlungen,
// Firmenprofil) WELTWEIT. Mit Cache(90s), Crumb+Cookie, Retry, UA-Rotation.

const UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];
const baseHeaders = (ua) => ({ "User-Agent": ua, "Accept": "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (x && typeof x.raw === "number") ? x.raw : (typeof x === "number" ? x : null);

const CACHE = new Map(); const TTL = 90 * 1000;
let SESSION = { cookie: null, crumb: null, ts: 0 }; const SESSION_TTL = 20 * 60 * 1000;

async function getSession(ua) {
  if (SESSION.cookie && SESSION.crumb && (Date.now() - SESSION.ts) < SESSION_TTL) return SESSION;
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: baseHeaders(ua) });
    let cookie = r1.headers.get("set-cookie") || "";
    cookie = cookie.split(",").map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...baseHeaders(ua), ...(cookie ? { Cookie: cookie } : {}) } });
    const crumb = (await r2.text()).trim();
    if (crumb && crumb.length < 40 && !crumb.includes("<")) SESSION = { cookie, crumb, ts: Date.now() };
  } catch (_) {}
  return SESSION;
}

async function yGet(pathBuilder, ua, sess) {
  const crumbQ = sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : "";
  const headers = { ...baseHeaders(ua), ...(sess.cookie ? { Cookie: sess.cookie } : {}) };
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(pathBuilder(host, crumbQ), { headers });
      if (res.ok) return await res.json();
      if (res.status === 401 || res.status === 403) SESSION = { cookie: null, crumb: null, ts: 0 };
    } catch (_) {}
  }
  return null;
}

async function fetchAll(symbol) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ua = pickUA(); const sess = await getSession(ua);
    const chart = await yGet((h, q) => `https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d${q}`, ua, sess);
    if (chart) {
      const modules = "assetProfile,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,price";
      const sum = await yGet((h, q) => `https://${h}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${q}`, ua, sess);
      return { chart, sum };
    }
    last = "429/blockiert";
    if (attempt < 3) await sleep(500 + attempt * 700);
  }
  return { __error: `Yahoo ${last || "Fehler"}` };
}

function shape(data, symbol) {
  const result = data.chart && data.chart.chart && data.chart.chart.result && data.chart.chart.result[0];
  if (!result || !result.meta) return null;
  const meta = result.meta;
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = q.close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) { const c = closes[i]; if (c != null && !isNaN(c)) series.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), p: +(+c).toFixed(2) }); }
  const price = meta.regularMarketPrice != null ? +(+meta.regularMarketPrice).toFixed(2) : (series.length ? series[series.length - 1].p : null);
  const prevClose = meta.chartPreviousClose != null ? +(+meta.chartPreviousClose).toFixed(2) : (meta.previousClose != null ? +(+meta.previousClose).toFixed(2) : (series.length > 1 ? series[series.length - 2].p : null));
  const chg = (price != null && prevClose != null) ? +(price - prevClose).toFixed(2) : null;
  const chgPct = (price != null && prevClose != null && prevClose !== 0) ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null;

  const out = {
    symbol: meta.symbol || symbol, name: meta.longName || meta.shortName || meta.symbol || symbol,
    currency: meta.currency || "", exchange: meta.fullExchangeName || meta.exchangeName || "",
    price, prevClose, chg, chgPct,
    open: meta.regularMarketOpen != null ? +(+meta.regularMarketOpen).toFixed(2) : null,
    high: meta.regularMarketDayHigh != null ? +(+meta.regularMarketDayHigh).toFixed(2) : null,
    low: meta.regularMarketDayLow != null ? +(+meta.regularMarketDayLow).toFixed(2) : null,
    series, mktcap: null, pe: null, eps: null, divYield: null, target: null, description: "", sector: "", recos: [],
  };

  const qs = data.sum && data.sum.quoteSummary && data.sum.quoteSummary.result && data.sum.quoteSummary.result[0];
  if (qs) {
    const sd = qs.summaryDetail || {}, ks = qs.defaultKeyStatistics || {}, fd = qs.financialData || {}, ap = qs.assetProfile || {};
    const rt = (qs.recommendationTrend && qs.recommendationTrend.trend) || [];
    const mc = num(sd.marketCap);
    if (mc != null) out.mktcap = +(mc / 1e9).toFixed(1);
    out.pe = num(sd.trailingPE); if (out.pe != null) out.pe = +out.pe.toFixed(1);
    out.eps = num(ks.trailingEps); if (out.eps != null) out.eps = +out.eps.toFixed(2);
    const dy = num(sd.dividendYield); if (dy != null) out.divYield = +(dy * 100).toFixed(2);
    out.target = num(fd.targetMeanPrice); if (out.target != null) out.target = +out.target.toFixed(2);
    out.description = (ap.longBusinessSummary || "").slice(0, 600);
    out.sector = ap.sector || "";
    if (rt.length) out.recos = [{ period: rt[0].period, strongBuy: rt[0].strongBuy, buy: rt[0].buy, hold: rt[0].hold, sell: rt[0].sell, strongSell: rt[0].strongSell }];
  }
  return out;
}

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || "").trim();
  if (!symbol) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "symbol fehlt" }) };

  const cachedVal = CACHE.get(symbol);
  if (cachedVal && (Date.now() - cachedVal.ts) < TTL) return { statusCode: 200, headers: { ...cors, "X-Cache": "hit" }, body: JSON.stringify(cachedVal.data) };

  try {
    const data = await fetchAll(symbol);
    if (data.__error) {
      if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: data.__error + " (Yahoo drosselt, kurz erneut versuchen)" }) };
    }
    const out = shape(data, symbol);
    if (!out) {
      if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Kein Ergebnis (Ticker pruefen)" }) };
    }
    CACHE.set(symbol, { ts: Date.now(), data: out });
    return { statusCode: 200, headers: { ...cors, "X-Cache": "miss" }, body: JSON.stringify(out) };
  } catch (e) {
    if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
