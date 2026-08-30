// Netlify Function: /.netlify/functions/quote?symbol=RHM.DE
// Yahoo-Finance-Proxy: Chart + quoteSummary (Kennzahlen, Analysten-Empfehlungen,
// Firmenprofil) WELTWEIT. Mit Cache(90s), Crumb+Cookie, Retry, UA-Rotation.

const { normalizeStatements, isFinancialCompany } = require("./lib/normalizer");
const { tryChain, fetchWithTimeout } = require("./lib/providers");

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

// Zeitgrenzen. Vorher liefen ALLE Yahoo-Aufrufe hier als blankes fetch() ohne
// jede Frist. Bei einer stummen Gegenstelle bedeutete das: getSession und yGet
// haengen, fetchAll wiederholt das bis zu viermal ueber zwei Hosts - und
// irgendwann bricht Netlify die Function nach 10s hart ab. Der Client sah dann
// keinen sprechenden Fehler, sondern nur einen abgerissenen Aufruf. Dieselbe
// Klasse Fehler, die im Makro-Tab den Timeout-Sturm ausgeloest hatte.
const YAHOO_TIMEOUT = 4000;       // je Einzelabruf
const SESSION_TIMEOUT = 2500;     // Cookie/Crumb sind reine Vorbereitung, duerfen nicht dominieren
const FUNCTION_BUDGET_MS = 8500;  // Sicherheitsabstand unter Netlifys 10s-Limit
// Die Symbolsuche laeuft waehrend des Tippens im Suchfeld. Sie darf deshalb
// nicht das volle Budget ausschoepfen: acht Sekunden auf Vorschlaege zu warten
// ist auch dann unbrauchbar, wenn die Function technisch noch im Limit bleibt.
// Lieber keine Vorschlaege als eine erstarrte Eingabe.
const SEARCH_BUDGET_MS = 5000;

async function getSession(ua, deadline) {
  if (SESSION.cookie && SESSION.crumb && (Date.now() - SESSION.ts) < SESSION_TTL) return SESSION;
  const rest = () => (deadline ? deadline - Date.now() : SESSION_TIMEOUT);
  try {
    if (rest() < 300) return SESSION; // ohne Restzeit lieber ohne Crumb weiter als gar nicht
    const r1 = await fetchWithTimeout("https://fc.yahoo.com/", { headers: baseHeaders(ua) }, Math.min(SESSION_TIMEOUT, rest()));
    let cookie = r1.headers.get("set-cookie") || "";
    cookie = cookie.split(",").map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    if (rest() < 300) return SESSION;
    const r2 = await fetchWithTimeout("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...baseHeaders(ua), ...(cookie ? { Cookie: cookie } : {}) } }, Math.min(SESSION_TIMEOUT, rest()));
    const crumb = (await r2.text()).trim();
    if (crumb && crumb.length < 40 && !crumb.includes("<")) SESSION = { cookie, crumb, ts: Date.now() };
  } catch (_) {}
  return SESSION;
}

async function yGet(pathBuilder, ua, sess, deadline) {
  const crumbQ = sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : "";
  const headers = { ...baseHeaders(ua), ...(sess.cookie ? { Cookie: sess.cookie } : {}) };
  for (const host of ["query1", "query2"]) {
    const rest = deadline ? deadline - Date.now() : YAHOO_TIMEOUT;
    // Ohne Restzeit den zweiten Host gar nicht erst anfassen - er wuerde nur
    // in denselben Abbruch laufen und das Budget der uebrigen Abrufe fressen.
    if (rest < 300) return null;
    try {
      const res = await fetchWithTimeout(pathBuilder(host, crumbQ), { headers }, Math.min(YAHOO_TIMEOUT, rest));
      if (res.ok) return await res.json();
      if (res.status === 401 || res.status === 403) SESSION = { cookie: null, crumb: null, ts: 0 };
    } catch (_) {}
  }
  return null;
}

const CORE_MODULES = "assetProfile,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,price";
async function fetchSum(symbol, ua, sess, modules, deadline) {
  return yGet((h, q) => `https://${h}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${q}`, ua, sess, deadline);
}
async function fetchAll(symbol, range, deadline) {
  const interval = RANGE_INTERVAL[range] || "1d";
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Wiederholungen nur solange noch Zeit bleibt. Ohne diese Pruefung liefen
    // die vier Versuche samt Wartepausen stur durch, bis Netlify die Function
    // abbrach - der Aufrufer bekam dann keinen Fehlertext, sondern gar nichts.
    if (deadline && deadline - Date.now() < 800) { last = last || "Zeitbudget erreicht"; break; }
    const ua = pickUA(); const sess = await getSession(ua, deadline);
    const chart = await yGet((h, q) => `https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}${q}`, ua, sess, deadline);
    if (chart) {
      let sum = await fetchSum(symbol, ua, sess, CORE_MODULES, deadline);
      if (!sum && (!deadline || deadline - Date.now() > 1200)) {
        // Crumb/Session koennte abgelaufen sein - einmal mit frischer Session erneut versuchen
        SESSION = { cookie: null, crumb: null, ts: 0 };
        const sess2 = await getSession(pickUA(), deadline);
        sum = await fetchSum(symbol, ua, sess2, CORE_MODULES, deadline);
      }
      // Die folgenden vier Abrufe sind Beiwerk: sie reichern an, sind aber
      // einzeln entbehrlich. Deshalb parallel statt nacheinander - vorher
      // summierten sich vier sequenzielle Rundreisen zu Yahoo im schlechtesten
      // Fall auf ein Vielfaches des Budgets, obwohl keiner auf den anderen
      // wartet. allSettled, damit ein Fehlschlag die anderen nicht mitreisst.
      const meta0 = chart.chart && chart.chart.result && chart.chart.result[0] && chart.chart.result[0].meta;
      const newsQuery = (meta0 && (meta0.longName || meta0.shortName)) || symbol;
      const [cal, news, earn, fund] = (await Promise.allSettled([
        fetchSum(symbol, ua, sess, "calendarEvents", deadline),
        yGet((h, q) => `https://${h}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(newsQuery)}&newsCount=12&quotesCount=0${q}`, ua, sess, deadline),
        fetchSum(symbol, ua, sess, "earnings", deadline),
        // Jahresabschluesse fuer das Kennzahlen-Modul (F5 RATIO).
        fetchSum(symbol, ua, sess, "balanceSheetHistory,incomeStatementHistory,cashflowStatementHistory", deadline),
      ])).map((r) => (r.status === "fulfilled" ? r.value : null));
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
  // Yahoo liefert Open/Hoch/Tief JE BALKEN im selben quote-Objekt wie close.
  // Sie werden fuer die Kerzendarstellung mitgenommen. Bewusst einzeln
  // abgesichert: Yahoo hat in der Praxis Luecken (Feiertage, Handelspausen),
  // in denen close gesetzt ist, aber open/high/low null sind. Ein solcher
  // Balken darf keine Kerze mit Nullwerten erzeugen - dann fehlt die Kerze
  // eben und die Linie zeichnet trotzdem weiter.
  const opens = q.open || []; const highs = q.high || []; const lows = q.low || [];
  const bar = (arr, i) => (arr[i] != null && !isNaN(arr[i]) ? +(+arr[i]).toFixed(2) : null);
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || isNaN(c)) continue;
    series.push({
      t: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      p: +(+c).toFixed(2),
      v: volumes[i] != null ? +volumes[i] : null,
      o: bar(opens, i), h: bar(highs, i), l: bar(lows, i),
    });
  }
  const price = meta.regularMarketPrice != null ? +(+meta.regularMarketPrice).toFixed(2) : (series.length ? series[series.length - 1].p : null);
  // WICHTIG: previousClose zuerst, chartPreviousClose NUR als Rueckfallebene.
  //
  // Yahoo liefert zwei verschiedene Dinge:
  //   previousClose        = Schlusskurs des letzten Handelstages  -> Tagesveraenderung
  //   chartPreviousClose   = Schlusskurs VOR dem angefragten Zeitraum -> zeitraumabhaengig!
  //
  // Vorher stand chartPreviousClose an erster Stelle. Da der Standard-Zeitraum
  // "6mo" ist (und Watchlist/Index-Laufband ganz ohne Zeitraum anfragen), wurde
  // die "Tagesveraenderung" in Wahrheit gegen den Kurs von vor sechs Monaten
  // gerechnet - daher Werte wie "S&P 500 +11.91%" und der Eindruck, die
  // Prozentzahlen bewegten sich nicht: sie hatten mit dem Handelstag nichts zu tun.
  const prevClose = meta.previousClose != null ? +(+meta.previousClose).toFixed(2)
    : (meta.regularMarketPreviousClose != null ? +(+meta.regularMarketPreviousClose).toFixed(2)
      : (meta.chartPreviousClose != null ? +(+meta.chartPreviousClose).toFixed(2)
        : (series.length > 1 ? series[series.length - 2].p : null)));
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
  // Kern-Woerter des Firmennamens fuer die Titel-Pruefung: Rechtsform-Suffixe und
  // Fuellwoerter raus, sonst wuerde z.B. "AG" oder "Inc" praktisch jeden Treffer
  // "relevant" machen. Nur Woerter >2 Zeichen zaehlen als brauchbares Signal.
  const STOPWORDS = new Set(["inc", "incorporated", "corp", "corporation", "ltd", "limited", "plc", "se", "ag", "sa", "nv", "co", "company", "group", "holding", "holdings", "the", "and", "class"]);
  const coreWords = (out.name || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const newsItems = (data.news && Array.isArray(data.news.news)) ? data.news.news : [];
  const scored = newsItems
    .filter((n) => n.title)
    .map((n) => {
      const related = Array.isArray(n.relatedTickers) ? n.relatedTickers.map((t) => t.toUpperCase()) : [];
      const relatedMatch = related.includes(symbol.toUpperCase()) || related.includes(baseSym);
      const titleLower = n.title.toLowerCase();
      const nameMatch = coreWords.some((w) => titleLower.includes(w));
      return {
        headline: n.title, source: (n.publisher || "NEWS").toUpperCase().slice(0, 10),
        ago: n.providerPublishTime ? Math.max(1, Math.floor((Date.now() - n.providerPublishTime * 1000) / 6e4)) : 1,
        date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 16).replace("T", " ") : "",
        summary: "", url: n.link, tags: [symbol],
        _relevant: relatedMatch || nameMatch,
      };
    });
  // Echte Filterung, nicht nur Sortierung: Yahoos Suche ist eine allgemeine
  // Volltextsuche, kein "News fuer dieses Wertpapier"-Endpunkt - ohne Filter
  // landen thematisch lose passende Treffer im Ergebnis. Nur im Ausnahmefall,
  // dass wirklich gar nichts als relevant erkannt wird, eine kleine, klar
  // reduzierte Notfall-Auswahl zeigen statt komplett leer zu bleiben.
  const relevant = scored.filter((n) => n._relevant);
  const chosen = (relevant.length ? relevant : scored.slice(0, 3));
  out.news = chosen.slice(0, 10).map(({ _relevant, ...n }) => n);

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

async function searchSymbols(query, deadline) {
  const ua = pickUA(); const sess = await getSession(ua, deadline);
  let r = await yGet((h, q) => `https://${h}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0${q}`, ua, sess, deadline);
  if (!r || !Array.isArray(r.quotes)) {
    // Crumb/Session koennte abgelaufen sein - einmal mit frischer Session erneut
    // versuchen, aber nur wenn dafuer noch Zeit ist. Die Suche laeuft bei jedem
    // Tastendruck im Suchfeld - ein haengender Wiederholungsversuch waere hier
    // besonders schmerzhaft.
    if (!deadline || deadline - Date.now() > 1000) {
      SESSION = { cookie: null, crumb: null, ts: 0 };
      const sess2 = await getSession(pickUA(), deadline);
      r = await yGet((h, q) => `https://${h}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0${q}`, ua, sess2, deadline);
    }
  }
  const quotes = (r && Array.isArray(r.quotes)) ? r.quotes : [];
  return quotes.filter((x) => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF" || x.quoteType === "INDEX")).slice(0, 8)
    .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchDisp || x.exchange || "", type: x.quoteType || "" }));
}

// --- Fallback-Quelle: Stooq (CSV, ohne API-Key) ---------------------------
// Liefert NUR Kurs + Tagesreihe. Keine Kennzahlen, keine News, keine Analysten-
// Empfehlungen - die bleiben bei einem Yahoo-Ausfall zwangslaeufig leer.
// UNGETESTET gegen die echte Stooq-Antwort (kein Netzwerkzugriff in der
// Entwicklungsumgebung); das Parsen ist defensiv, unerwartete Formen -> null.
//
// Symbol-Uebersetzung: Yahoo und Stooq benennen Maerkte unterschiedlich.
// Abgedeckt sind die Faelle, die in der App vorkommen; alles Unbekannte wird
// unveraendert durchgereicht und faellt notfalls einfach auf null zurueck.
const STOOQ_SUFFIX = { DE: ".de", PA: ".fr", AS: ".nl", SW: ".ch", L: ".uk", MI: ".it", MC: ".es", T: ".jp", HK: ".hk", KS: ".kr", TW: ".tw" };
function toStooqSymbol(symbol) {
  if (!symbol) return null;
  if (symbol.startsWith("^")) return null;   // Indizes: abweichende Codes, nicht zuverlaessig ableitbar
  if (symbol.includes("=")) return null;      // Futures/FX: andere Systematik
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return symbol.toLowerCase() + ".us"; // ohne Suffix = US-Wert
  const base = symbol.slice(0, dot).toLowerCase();
  const suffix = STOOQ_SUFFIX[symbol.slice(dot + 1).toUpperCase()];
  return suffix ? base + suffix : null;
}
const RANGE_DAYS = { "1d": 5, "5d": 10, "1mo": 35, "6mo": 190, "1y": 380, "5y": 1850 };

async function fromStooq(symbol, range) {
  const s = toStooqSymbol(symbol);
  if (!s) return null;
  const days = RANGE_DAYS[range] || 190;
  const d2 = new Date(); const d1 = new Date(Date.now() - days * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&d1=${fmt(d1)}&d2=${fmt(d2)}&i=d`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": pickUA(), "Accept": "text/csv,*/*" } }, 6000);
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  const txt = await res.text();
  const lines = txt.trim().split("\n");
  if (lines.length < 3) return null; // Stooq liefert bei unbekanntem Symbol nur eine Zeile
  const head = lines[0].toLowerCase().split(",");
  const iDate = head.indexOf("date"), iClose = head.indexOf("close"), iVol = head.indexOf("volume");
  const iOpen = head.indexOf("open"), iHigh = head.indexOf("high"), iLow = head.indexOf("low");
  if (iDate === -1 || iClose === -1) return null;
  // Open/Hoch/Tief JE ZEILE fuer die Kerzendarstellung. Die Spaltenindizes
  // wurden oben ohnehin schon gesucht - vorher wurden sie nur fuer die letzte
  // Zeile (Tageswerte) ausgewertet, die Historie blieb reine Schlusskurse.
  const zelle = (p, idx) => {
    if (idx === -1) return null;
    const v = parseFloat(p[idx]);
    return isNaN(v) ? null : +v.toFixed(2);
  };
  const series = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    const t = p[iDate]; const c = parseFloat(p[iClose]);
    if (t && !isNaN(c)) {
      series.push({
        t, p: +c.toFixed(2), v: iVol > -1 ? (parseFloat(p[iVol]) || null) : null,
        o: zelle(p, iOpen), h: zelle(p, iHigh), l: zelle(p, iLow),
      });
    }
  }
  if (series.length < 2) return null;
  const lastLine = lines[lines.length - 1].split(",");
  const price = series[series.length - 1].p;
  const prevClose = series[series.length - 2].p;
  const numAt = (idx) => { if (idx === -1) return null; const v = parseFloat(lastLine[idx]); return isNaN(v) ? null : +v.toFixed(2); };
  return {
    symbol, name: symbol, currency: "", exchange: "Stooq",
    price, prevClose,
    chg: +(price - prevClose).toFixed(2),
    chgPct: prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null,
    open: numAt(iOpen), high: numAt(iHigh), low: numAt(iLow),
    series,
    // Alles Folgende kann Stooq nicht liefern - explizit leer statt geraten:
    mktcap: null, pe: null, eps: null, divYield: null, target: null, description: "", sector: "", industry: "",
    recos: [], week52Low: null, week52High: null, volume: series[series.length - 1].v,
    avgVolume: null, beta: null, earningsDate: null, news: [], financials: [], fundamentals: [], isFinancial: false,
    partial: "Nur Kurs und Chart verfügbar (Ersatzquelle Stooq) — Kennzahlen, News und Analystendaten fehlen.",
  };
}

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  // Gesamtfrist ab Funktionsstart - dieselbe Bauweise wie in fred.js und
  // geopolitics.js. Was bis dahin nicht fertig ist, wird sauber als Fehler
  // gemeldet, statt in Netlifys hartem 10s-Abbruch zu verschwinden.
  const deadline = Date.now() + FUNCTION_BUDGET_MS;

  const search = (event.queryStringParameters && event.queryStringParameters.search || "").trim();
  if (search) {
    try { return { statusCode: 200, headers: cors, body: JSON.stringify({ quotes: await searchSymbols(search, Math.min(deadline, Date.now() + SEARCH_BUDGET_MS)) }) }; }
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
    // Fallback-Kette: Yahoo (voller Datensatz) -> Stooq (nur Kurs + Chart).
    const chain = await tryChain([
      // Yahoo bekommt nicht die volle Frist: Stooq muss danach noch eine echte
      // Chance haben. Ohne diese Reserve waere die Ersatzquelle genau dann
      // wertlos, wenn man sie am dringendsten braucht - bei einem haengenden Yahoo.
      { name: "yahoo", run: async () => { const data = await fetchAll(symbol, range, deadline - 2000); return data.__error ? null : shape(data, symbol); } },
      { name: "stooq", run: () => fromStooq(symbol, range) },
    ]);
    const out = chain.data ? Object.assign({}, chain.data, { source: chain.source }) : null;
    if (!out) {
      if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
      const detail = chain.attempts.map((a) => `${a.name}: ${a.skipped || a.error || "kein Ergebnis"}`).join(" | ");
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Keine Quelle lieferte Daten (" + detail + ")" }) };
    }
    CACHE.set(cacheKey, { ts: Date.now(), data: out });
    return { statusCode: 200, headers: { ...cors, "X-Cache": "miss" }, body: JSON.stringify(out) };
  } catch (e) {
    if (cachedVal) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cachedVal.data) };
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};

// Fuer Tests: Einzelfunktionen ohne HTTP-Handler-Wrapper zugaenglich machen.
exports._internal = { shape, fromStooq, toStooqSymbol };
