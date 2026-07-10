// Netlify Function: /.netlify/functions/quote?symbol=RHM.DE
// Ruft Yahoo Finance server-seitig ab (kein CORS-Problem) und liefert
// Kurs + Kennzahlen + Kursverlauf (~6 Monate Tagesdaten) als JSON zurück.

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || "").trim();
  if (!symbol) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "symbol fehlt" }) };
  }

  try {
    // range=6mo, interval=1d -> Tages-Chart; enthält auch meta mit Live-Kurs
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
    const res = await fetch(url, {
      headers: {
        // Yahoo braucht einen User-Agent, sonst blockt es die Anfrage
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      return { statusCode: res.status, headers: cors, body: JSON.stringify({ error: `Yahoo HTTP ${res.status}` }) };
    }

    const data = await res.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result || !result.meta) {
      const msg = (data && data.chart && data.chart.error && data.chart.error.description) || "Kein Ergebnis (Ticker prüfen)";
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: msg }) };
    }

    const meta = result.meta;
    const ts = result.timestamp || [];
    const quotes = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const closes = quotes.close || [];

    // Serie fürs Chart (nur gültige Punkte)
    const series = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c != null && !isNaN(c)) {
        series.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), p: +(+c).toFixed(2) });
      }
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
      price,
      prevClose,
      chg,
      chgPct,
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
