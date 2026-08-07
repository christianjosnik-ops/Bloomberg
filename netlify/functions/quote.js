// Netlify Function: /.netlify/functions/quote?symbol=RHM.DE
// Yahoo-Finance-Proxy: Chart + quoteSummary (Kennzahlen, Analysten-Empfehlungen,
// Firmenprofil) WELTWEIT. Mit Cache(90s), Crumb+Cookie, Retry, UA-Rotation.

const { normalizeStatements, isFinancialCompany } = require("./lib/normalizer");

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

const RANGE_INTERVAL = {
  "1d": "5m", "5d": "15m", "1mo": "1d", "6mo": "1d", "1y": "1d", "5y": "1wk",
};

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

const CORE_MODULES = "assetProfile,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,price";
async function fetchSum(symbol, ua, sess, modules) {
  return yGet((h, q) => `https://${h}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${q}`, ua, sess);
}
async function fetchAll(symbol, range) {
  const interval = RANGE_INTERVAL[range] || "1d";
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ua = pickUA(); const sess = await getSession(ua);
    const chart = await yGet((h, q) => `https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}${q}`, ua, sess);
    if (chart) {
      let sum = await fetchSum(symbol, ua, sess, CORE_MODULES);
      if (!sum) {
        // Crumb/Session koennte abgelaufen sein - einmal mit frischer Session erneut versuchen
        SESSION = { cookie: null, crumb: null, ts: 0 };
        const sess2 = await getSession(pickUA());
        sum = await fetchSum(symbol, ua, sess2, CORE_MODULES);
      }
      // calendarEvents separat, unabhaengig vom Erfolg der Kernkennzahlen
      const cal = await fetchSum(symbol, ua, sess, "calendarEvents").catch(() => null);
      // Firmen-News separat ueber die Yahoo-Suche (funktioniert weltweit, nicht nur US).
      // Suche mit dem vollen Firmennamen statt dem rohen Ticker - liefert deutlich
      // treffsicherere, wirklich zum Unternehmen passende Ergebnisse.
      const meta0 = chart.chart && chart.chart.result && chart.chart.result[0] && chart.chart.result[0].meta;
      const newsQuery = (meta0 && (meta0.longName || meta0.shortName)) || symbol;
      const news = await yGet((h, q) => `https://${h}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(newsQuery)}&newsCount=12&quotesCount=0${q}`, ua, sess).catch(() => null);
      // Mehrjaehrige Umsatz/Gewinn-Historie separat, unabhaengig vom Erfolg der Kernkennzahlen
      const earn = await fetchSum(symbol, ua, sess, "earnings").catch(() => null);
      // Jahresabschluesse (Bilanz/GuV/Kapitalflussrechnung) fuer das Kennzahlen-Modul (F5 RATIO).
      // UNGETESTET gegen die echte Yahoo-API (kein Netzwerkzugriff in dieser Umgebung) - separater,
      // unabhaengiger Fetch, damit ein Fehlschlag hier nichts anderes blockiert. TODO nach erstem
      // Live-Deploy: pruefen, ob Yahoo diese drei Module noch zuverlaessig liefert.
      const fund = await fetchSum(symbol, ua, sess, "balanceSheetHistory,incomeStatementHistory,cashflowStatementHistory").catch(() => null);
      return { chart, sum, cal, news, earn, fund };
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
  const closes = q.close || []; const volumes = q.volume || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) { const c = closes[i]; if (c != null && !isNaN(c)) series.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), p: +(+c).toFixed(2), v: volumes[i] != null ? +volumes[i] : null }); }
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
    series, mktcap: null, pe: null, eps: null, divYield: null, target: null, description: "", sector: "", industry: "", recos: [],
    week52Low: null, week52High: null, volume: null, avgVolume: null, beta: null, earningsDate: null, news: [], financials: [], fundamentals: [], isFinancial: false,
  };
  out.volume = meta.regularMarketVolume != null ? +meta.regularMarketVolume : null;

  const baseSym = symbol.split(".")[0].toUpperCase();
  const newsItems = (data.news && Array.isArray(data.news.news)) ? data.news.news : [];
  out.news = newsItems
    .filter((n) => n.title)
    .map((n) => {
      const related = Array.isArray(n.relatedTickers) ? n.relatedTickers.map((t) => t.toUpperCase()) : [];
      return {
        headline: n.title, source: (n.publisher || "NEWS").toUpperCase().slice(0, 10),
        ago: n.providerPublishTime ? Math.max(1, Math.floor((Date.now() - n.providerPublishTime * 1000) / 6e4)) : 1,
        date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 16).replace("T", " ") : "",
        summary: "", url: n.link, tags: [symbol],
        _relevant: related.includes(symbol.toUpperCase()) || related.includes(baseSym) ? 1 : 0,
      };
    })
    .sort((a, b) => b._relevant - a._relevant)
    .slice(0, 10)
    .map(({ _relevant, ...n }) => n);

  const earnQs = data.earn && data.earn.quoteSummary && data.earn.quoteSummary.result && data.earn.quoteSummary.result[0];
  const yearly = (earnQs && earnQs.earnings && earnQs.earnings.financialsChart && earnQs.earnings.financialsChart.yearly) || [];
  out.financials = yearly.map((y) => ({ year: y.date, revenue: num(y.revenue), earnings: num(y.earnings) })).filter((y) => y.year != null);

  // F5 RATIO: normalisierte Jahresabschluesse fuers Kennzahlen-Modul (ausschliesslich GJ-Basis,
  // keine TTM-Werte gemischt - siehe normalizer.js). Fehlschlag hier lässt fundamentals einfach leer.
  const fundQs = data.fund && data.fund.quoteSummary && data.fund.quoteSummary.result && data.fund.quoteSummary.result[0];
  if (fundQs) {
    out.fundamentals = normalizeStatements({
      balanceSheet: (fundQs.balanceSheetHistory && fundQs.balanceSheetHistory.balanceSheetStatements) || [],
      incomeStatement: (fundQs.incomeStatementHistory && fundQs.incomeStatementHistory.incomeStatementHistory) || [],
      cashflow: (fundQs.cashflowStatementHistory && fundQs.cashflowStatementHistory.cashflowStatements) || [],
    });
  }

  const qs = data.sum && data.sum.quoteSummary && data.sum.quoteSummary.result && data.sum.quoteSummary.result[0];
  const calQs = data.cal && data.cal.quoteSummary && data.cal.quoteSummary.result && data.cal.quoteSummary.result[0];
  if (qs) {
    const sd = qs.summaryDetail || {}, ks = qs.defaultKeyStatistics || {}, fd = qs.financialData || {}, ap = qs.assetProfile || {};
    const ce = (calQs && calQs.calendarEvents) || {};
    const rt = (qs.recommendationTrend && qs.recommendationTrend.trend) || [];
    const mc = num(sd.marketCap);
    if (mc != null) out.mktcap = +(mc / 1e9).toFixed(1);
    out.pe = num(sd.trailingPE); if (out.pe != null) out.pe = +out.pe.toFixed(1);
    out.eps = num(ks.trailingEps); if (out.eps != null) out.eps = +out.eps.toFixed(2);
    const dy = num(sd.dividendYield); if (dy != null) out.divYield = +(dy * 100).toFixed(2);
    out.target = num(fd.targetMeanPrice); if (out.target != null) out.target = +out.target.toFixed(2);
    out.description = (ap.longBusinessSummary || "").slice(0, 600);
    out.sector = ap.sector || ""; out.industry = ap.industry || "";
    out.isFinancial = isFinancialCompany(ap.sector, ap.industry);
    out.week52Low = num(sd.fiftyTwoWeekLow); if (out.week52Low != null) out.week52Low = +out.week52Low.toFixed(2);
    out.week52High = num(sd.fiftyTwoWeekHigh); if (out.week52High != null) out.week52High = +out.week52High.toFixed(2);
    out.avgVolume = num(sd.averageVolume) != null ? Math.round(num(sd.averageVolume)) : null;
    out.beta = num(ks.beta); if (out.beta != null) out.beta = +out.beta.toFixed(2);
    const ed = ce.earningsDate && ce.earningsDate[0]; const edVal = num(ed);
    out.earningsDate = edVal != null ? new Date(edVal * 1000).toISOString().slice(0, 10) : null;
    if (rt.length) out.recos = [{ period: rt[0].period, strongBuy: rt[0].strongBuy, buy: rt[0].buy, hold: rt[0].hold, sell: rt[0].sell, strongSell: rt[0].strongSell }];
  }
  return out;
}

async function searchSymbols(query) {
  const ua = pickUA(); const sess = await getSession(ua);
  let r = await yGet((h, q) => `https://${h}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0${q}`, ua, sess);
  if (!r || !Array.isArray(r.quotes)) {
    // Crumb/Session koennte abgelaufen sein - einmal mit frischer Session erneut versuchen
    SESSION = { cookie: null, crumb: null, ts: 0 };
    const sess2 = await getSession(pickUA());
    r = await yGet((h, q) => `https://${h}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0${q}`, ua, sess2);
  }
  const quotes = (r && Array.isArray(r.quotes)) ? r.quotes : [];
  return quotes.filter((x) => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF" || x.quoteType === "INDEX")).slice(0, 8)
    .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchDisp || x.exchange || "", type: x.quoteType || "" }));
}

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const search = (event.queryStringParameters && event.queryStringParameters.search || "").trim();
  if (search) {
    try { return { statusCode: 200, headers: cors, body: JSON.stringify({ quotes: await searchSymbols(search) }) }; }
    catch (e) { return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) }; }
  }

  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || "").trim();
  if (!symbol) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "symbol fehlt" }) };
  const rangeIn = (event.queryStringParameters && event.queryStringParameters.range || "6mo").trim();
  const range = RANGE_INTERVAL[rangeIn] ? rangeIn : "6mo";
  const cacheKey = `${symbol}:${range}`;

  const cachedVal = CACHE.get(cacheKey);
  if (cachedVal && (Date.now() - cachedVal.ts) < TTL) return { statusCode: 200, headers: { ...cors, "X-Cache": "hit" }, body: JSON.stringify(cachedVal.data) };

  try {
    const data = await fetchAll(symbol, range);
    if (data.__error) {
      if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: data.__error + " (Yahoo drosselt, kurz erneut versuchen)" }) };
    }
    const out = shape(data, symbol);
    if (!out) {
      if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Kein Ergebnis (Ticker pruefen)" }) };
    }
    CACHE.set(cacheKey, { ts: Date.now(), data: out });
    return { statusCode: 200, headers: { ...cors, "X-Cache": "miss" }, body: JSON.stringify(out) };
  } catch (e) {
    if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
