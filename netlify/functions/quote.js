// Netlify Function: /.netlify/functions/quote?symbol=RHM.DE
// Robuste Yahoo-Finance-Abfrage: mehrere Hosts, Retry bei 429, browserähnliche Header.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const H = { "User-Agent": UA, "Accept": "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchChart(symbol) {
  const paths = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`,
  ];
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of paths) {
      const res = await fetch(url, { headers: H });
      if (res.ok) return await res.json();
      lastStatus = res.status;
      if (res.status === 429) await sleep(600 + attempt * 500);
    }
  }
  return { __error: `Yahoo HTTP ${lastStatus}` };
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

  try {
    const data = await fetchChart(symbol);
    if (data.__error) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: data.__error + " (Yahoo drosselt, kurz erneut versuchen)" }) };

    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result || !result.meta) {
      const msg = (data && data.chart && data.chart.error && data.chart.error.description) || "Kein Ergebnis (Ticker pruefen)";
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: msg }) };
    }

    const meta = result.meta;
    const ts = result.timestamp || [];
    const quotes = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const closes = quotes.close || [];

    const series = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c != null && !isNaN(c)) series.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), p: +(+c).toFixed(2) });
    }

    const price = meta.regularMarketPrice != null ? +(+meta.regularMarketPrice).toFixed(2) : (series.length ? series[series.length - 1].p : null);
    const prevClose = meta.chartPreviousClose != null ? +(+meta.chartPreviousClose).toFixed(2)
      : (meta.previousClose != null ? +(+meta.previousClose).toFixed(2)
      : (series.length > 1 ? series[series.length - 2].p : null));
    const chg = (price != null && prevClose != null) ? +(price - prevClose).toFixed(2) : null;
    const chgPct = (price != null && prevClose != null && prevClose !== 0) ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null;

    const out = {
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
    return { statusCode: 200, headers: cors, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
