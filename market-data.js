// market-data.js — Presets/Konstanten + Datenbeschaffungs-Helfer (Yahoo-Proxy,
// Finnhub, FRED-Batch, Groq). Kein JSX. Dual-Export wie ratios.js/peers.js/
// theme.js: laeuft unveraendert in Node (Tests) und im Browser (<script
// src="market-data.js">, ohne Babel - dieser Code enthaelt kein JSX).
//
// Ausgelagert aus index.html, um die Menge an JSX-Code zu verkleinern, die
// Babel bei jedem Seitenaufruf live im Browser kompilieren muss, und um die
// Datenbeschaffungs-Logik unabhaengig von der React-UI testbar zu machen.
// Alle Funktionen sind zustandslos (Keys werden als Parameter uebergeben,
// kein Zugriff auf React-State) - genau deshalb liessen sie sich 1:1 verschieben.

(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.MarketData = mod;
})(typeof self !== "undefined" ? self : this, function () {

  // Weltweite Presets. `y` = Yahoo-Ticker (läuft über die Netlify-Funktion, weltweit).
  // Ohne `y` = reiner US-Wert über Finnhub (mit Analysten-Empfehlungen + News).
  const EU_PRESETS = [
    { s: "RHM", y: "RHM.DE", label: "Rheinmetall" }, { s: "SAP", y: "SAP.DE", label: "SAP" },
    { s: "PUM", y: "PUM.DE", label: "Puma" }, { s: "VOW3", y: "VOW3.DE", label: "Volkswagen" },
    { s: "BMW", y: "BMW.DE", label: "BMW" }, { s: "MBG", y: "MBG.DE", label: "Mercedes" },
    { s: "AIR", y: "AIR.PA", label: "Airbus" }, { s: "MC", y: "MC.PA", label: "LVMH" },
    { s: "ASML", y: "ASML.AS", label: "ASML" }, { s: "NESN", y: "NESN.SW", label: "Nestlé" },
  ];
  const ASIA_PRESETS = [
    { s: "TOYOTA", y: "7203.T", label: "Toyota" }, { s: "SONY", y: "6758.T", label: "Sony" },
    { s: "SAMSUNG", y: "005930.KS", label: "Samsung" }, { s: "TENCENT", y: "0700.HK", label: "Tencent" },
    { s: "ALIBABA", y: "9988.HK", label: "Alibaba HK" }, { s: "TSMC-TW", y: "2330.TW", label: "TSMC Taiwan" },
  ];
  const US_MACRO_PRESETS = [
    { id: "UNRATE", label: "Arbeitslosenquote", unit: "%" },
    { id: "CPIAUCSL", label: "Verbraucherpreise (CPI)", unit: "Index" },
    { id: "FEDFUNDS", label: "Fed Funds Rate", unit: "%" },
    { id: "DGS10", label: "US-Staatsanleihen 10J", unit: "%" },
    { id: "T10Y2Y", label: "Zinskurve 10J–2J", unit: "%" },
    { id: "GDP", label: "BIP (nominal)", unit: "Mrd $" },
    { id: "PAYEMS", label: "Beschäftigte (Nonfarm)", unit: "Tsd" },
    { id: "UMCSENT", label: "Verbrauchervertrauen", unit: "Index" },
    { id: "MORTGAGE30US", label: "Hypothekenzins 30J", unit: "%" },
    { id: "M2SL", label: "Geldmenge M2", unit: "Mrd $" },
  ];
  // Euro-Raum ueber FRED gespiegelte Eurostat-/EZB-Reihen - kein zweiter
  // Provider, dieselbe fredgraph.csv-Sammelabruf-Pipeline wie die US-Serien.
  //
  // ACHTUNG bei Aenderungen: Die urspruengliche Auswahl enthielt zwei Serien aus
  // der OECD-"Main Economic Indicators"-Familie (EA19CPALTT01GYM,
  // LRHUTTTTEZM156S). Die hat FRED eingestellt - LRHUTTTTEZM156S endet im
  // Januar 2023. Beide lieferten weiterhin brav eine CSV-Antwort, nur eben mit
  // drei Jahre alten Werten, die im UI aussahen wie frische Daten. Ersetzt durch
  // Eurostat-/EZB-Quellen, deren aktuelle Fortschreibung geprueft ist. Wer hier
  // eine Serie ergaenzt: Enddatum pruefen, nicht nur ob die ID existiert.
  const EURO_MACRO_PRESETS = [
    { id: "ECBDFR", label: "EZB-Einlagensatz", unit: "%" },
    { id: "CP0000EZ19M086NEST", label: "Euro-Verbraucherpreise (HVPI)", unit: "Index" },
    { id: "IRLTLT01DEM156N", label: "Bund-Rendite 10J", unit: "%" },
    { id: "CLVMEURSCAB1GQEA19", label: "Euro-BIP (real)", unit: "Mrd €" },
  ];
  const MACRO_PRESETS = [...US_MACRO_PRESETS, ...EURO_MACRO_PRESETS];
  const INDEX_PRESETS = [
    { s: "SPX", y: "^GSPC", label: "S&P 500" }, { s: "NDX", y: "^IXIC", label: "Nasdaq" },
    { s: "DJI", y: "^DJI", label: "Dow Jones" }, { s: "VIX", y: "^VIX", label: "VIX" },
    { s: "GOLD", y: "GC=F", label: "Gold" }, { s: "OIL", y: "CL=F", label: "Öl (WTI)" },
    { s: "EURUSD", y: "EURUSD=X", label: "EUR/USD" }, { s: "UST10Y", y: "^TNX", label: "US 10J-Rendite" },
  ];
  // ~60 liquide US-Large-Caps ueber 11 Sektoren (vorher 30 ueber 7). Bewusst auf
  // Werte begrenzt, die Finnhubs kostenloser Plan zuverlaessig mit Echtzeitkursen
  // fuehrt - der Scanner fragt sie alle einzeln ab (siehe runScan), eine noch
  // groessere Liste wuerde nur die Wartezeit strecken, ohne die Wellen-Abfrage
  // (SCAN_WAVE) an Finnhubs Rate-Limit vorbeizubringen.
  const US_UNIVERSE = [
    ["AAPL", "Apple Inc", "Technology"], ["MSFT", "Microsoft", "Technology"], ["NVDA", "NVIDIA", "Technology"], ["GOOGL", "Alphabet", "Technology"],
    ["META", "Meta Platforms", "Technology"], ["AMD", "Adv Micro Dev", "Technology"], ["AVGO", "Broadcom", "Technology"], ["TSM", "TSMC", "Technology"],
    ["QCOM", "Qualcomm", "Technology"], ["ORCL", "Oracle", "Technology"], ["ADBE", "Adobe", "Technology"], ["CRM", "Salesforce", "Technology"],
    ["INTC", "Intel", "Technology"], ["CSCO", "Cisco", "Technology"],
    ["TSLA", "Tesla", "Automotive"], ["F", "Ford Motor", "Automotive"], ["GM", "General Motors", "Automotive"],
    ["AMZN", "Amazon", "Consumer"], ["NKE", "Nike", "Consumer"], ["MCD", "McDonald's", "Consumer"], ["KO", "Coca-Cola", "Consumer"],
    ["PEP", "PepsiCo", "Consumer"], ["SBUX", "Starbucks", "Consumer"], ["HD", "Home Depot", "Consumer"], ["TGT", "Target", "Consumer"],
    ["DIS", "Walt Disney", "Consumer"], ["COST", "Costco", "Consumer"],
    ["JPM", "JPMorgan", "Financials"], ["V", "Visa", "Financials"], ["MA", "Mastercard", "Financials"], ["GS", "Goldman Sachs", "Financials"],
    ["BAC", "Bank of America", "Financials"], ["WFC", "Wells Fargo", "Financials"], ["MS", "Morgan Stanley", "Financials"], ["AXP", "American Express", "Financials"],
    ["JNJ", "Johnson&Johnson", "Healthcare"], ["PFE", "Pfizer", "Healthcare"], ["LLY", "Eli Lilly", "Healthcare"], ["UNH", "UnitedHealth", "Healthcare"],
    ["ABBV", "AbbVie", "Healthcare"], ["MRK", "Merck", "Healthcare"], ["TMO", "Thermo Fisher", "Healthcare"],
    ["XOM", "Exxon Mobil", "Energy"], ["CVX", "Chevron", "Energy"], ["COP", "ConocoPhillips", "Energy"], ["SLB", "Schlumberger", "Energy"],
    ["CAT", "Caterpillar", "Industrials"], ["BA", "Boeing", "Industrials"], ["GE", "GE Aerospace", "Industrials"], ["HON", "Honeywell", "Industrials"],
    ["UPS", "United Parcel Service", "Industrials"], ["LMT", "Lockheed Martin", "Industrials"],
    ["NFLX", "Netflix", "Communication Services"], ["CMCSA", "Comcast", "Communication Services"], ["T", "AT&T", "Communication Services"], ["VZ", "Verizon", "Communication Services"],
    ["AMT", "American Tower", "Real Estate"], ["PLD", "Prologis", "Real Estate"],
    ["NEE", "NextEra Energy", "Utilities"], ["DUK", "Duke Energy", "Utilities"],
    ["LIN", "Linde", "Materials"], ["FCX", "Freeport-McMoRan", "Materials"],
  ];
  const US_NAME = Object.fromEntries(US_UNIVERSE.map(([s, n, sec]) => [s, [n, sec]]));
  const SECTORS = ["Alle", ...Array.from(new Set(US_UNIVERSE.map((u) => u[2])))];

  const FH = "https://finnhub.io/api/v1", TD = "https://api.twelvedata.com";
  const YF = "/.netlify/functions/quote";
  const FRED_FN = "/.netlify/functions/fred";

  // Hartes Client-Timeout fuer JEDEN Abruf: ohne das kann eine haengende
  // Server-Antwort den "lädt…"-Zustand einer Ansicht auf ewig einfrieren, ohne
  // dass jemals ein Fehler sichtbar wird - der try/catch drumherum kommt nie
  // zum Zug, weil das fetch-Promise selbst nie fertig wird.
  async function jgetTimeout(u, ms, headers) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms || 15000);
    try {
      const r = await fetch(u, { signal: ctrl.signal, headers: headers || undefined });
      return await r.json();
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(`Zeitüberschreitung nach ${((ms || 15000) / 1000).toFixed(0)}s`);
      throw e;
    } finally {
      clearTimeout(to);
    }
  }
  // jget war frueher ein blankes fetch() OHNE Timeout. Damit konnte eine
  // haengende Antwort ganze Ansichten dauerhaft im Ladezustand einfrieren:
  // F3 NEWS und die Detailansicht riefen es direkt auf, sodass ein stummer
  // Anbieter dort in einem "lädt…" ohne Fehlermeldung endete. Jetzt teilt es
  // sich die Timeout-Logik mit jgetTimeout - explizite Aufrufe koennen eine
  // kuerzere Frist setzen, aber gar keine Frist gibt es nicht mehr.
  const JGET_DEFAULT_TIMEOUT_MS = 20000;
  const jget = (u) => jgetTimeout(u, JGET_DEFAULT_TIMEOUT_MS);
  const keyOf = (e) => e.y || e.s;

  // Der FRED-Schluessel geht als HEADER mit, nicht als Anfrageparameter.
  // In der URL stuende er in Netlifys Zugriffsprotokoll, im Browserverlauf und
  // im Referrer; im Header steht er in keinem davon. Ist kein Schluessel
  // eingetragen, wird gar kein Header gesetzt - dann greift serverseitig die
  // Umgebungsvariable FRED_API_KEY, falls es sie gibt.
  async function fredGetBatch(ids, fredKey) {
    const k = (fredKey || "").trim();
    return jgetTimeout(
      `${FRED_FN}?ids=${encodeURIComponent(ids.join(","))}`,
      15000,
      k ? { "X-FRED-Key": k } : undefined
    );
  }

  /* Data layer (nur Finnhub/US — läuft garantiert im Browser) */
  async function fhQuote(sym, k) { return jget(`${FH}/quote?symbol=${sym}&token=${k}`); }
  async function tdQuote(sym, k) { return jget(`${TD}/quote?symbol=${sym}&apikey=${k}`); }
  async function tdSeries(sym, k) {
    const r = await jget(`${TD}/time_series?symbol=${sym}&interval=1day&outputsize=140&apikey=${k}`);
    if (r?.status === "ok" && Array.isArray(r.values)) return { ok: true, series: r.values.map((v) => ({ t: v.datetime, p: +v.close })).reverse() };
    return { ok: false, series: [] };
  }
  async function yfGet(yticker, range) {
    const r = await jget(`${YF}?symbol=${encodeURIComponent(yticker)}${range ? `&range=${range}` : ""}`);
    if (r?.error) throw new Error(r.error);
    return r;
  }
  async function searchSymbol(query) {
    try { const r = await jget(`${YF}?search=${encodeURIComponent(query)}`); return r?.quotes || []; } catch { return []; }
  }
  function localPresetMatch(query) {
    const q = query.trim().toLowerCase(); if (!q) return null;
    const all = [...EU_PRESETS, ...ASIA_PRESETS];
    return all.find((p) => p.s.toLowerCase() === q || p.label.toLowerCase() === q) || all.find((p) => p.label.toLowerCase().includes(q)) || null;
  }
  async function resolveSymbol(query) {
    const q = query.trim(); if (!q) return null;
    const local = localPresetMatch(q);
    if (local) return { s: local.s, y: local.y };
    const hits = await searchSymbol(q);
    const hit = hits[0];
    if (!hit) return { s: q.toUpperCase() };
    const short = hit.symbol.split(".")[0].split("=")[0].replace(/^\^/, "").toUpperCase();
    return { s: short, y: hit.symbol };
  }
  const CHART_RANGES = [["1d", "1T"], ["5d", "5T"], ["1mo", "1M"], ["6mo", "6M"], ["1y", "1J"], ["5y", "5J"]];
  async function getChart(e, tdKey, range) {
    try { const r = await yfGet(e.y || e.s, range || "6mo"); return { ok: Array.isArray(r.series) && r.series.length > 3, series: r.series || [] }; } catch {}
    if (tdKey && !e.y) { const r = await tdSeries(e.s, tdKey); if (r.ok) return r; }
    return { ok: false, series: [] };
  }
  async function getQuoteLite(e, fhKey) {
    if (e.y) { try { const r = await yfGet(e.y); return { price: r.price, chgPct: r.chgPct }; } catch { return { price: null, chgPct: null }; } }
    const q = await fhQuote(e.s, fhKey); return { price: q?.c ?? null, chgPct: q?.dp != null ? +(+q.dp).toFixed(2) : null };
  }
  async function getDetail(e, fhKey) {
    // Globaler Wert (Europa/Asien) über Yahoo-Proxy
    if (e.y) {
      const r = await yfGet(e.y);
      return {
        s: e.s, y: e.y, region: "GLOBAL", name: r.name || e.s, sector: r.exchange || "—", currency: r.currency || "",
        price: r.price, chg: r.chg, chgPct: r.chgPct, open: r.open, high: r.high, low: r.low, prevClose: r.prevClose,
        mktcap: r.mktcap, pe: r.pe, eps: r.eps, divYield: r.divYield, target: r.target,
        week52Low: r.week52Low, week52High: r.week52High, volume: r.volume, avgVolume: r.avgVolume, beta: r.beta, earningsDate: r.earningsDate,
        recos: r.recos || [], news: r.news || [], financials: r.financials || [],
        fundamentals: r.fundamentals || [], industry: r.industry || "", isFinancial: !!r.isFinancial,
        source: r.source || null, partial: r.partial || null,
      };
    }
    // US-Wert über Finnhub (mit Empfehlungen + News) + Yahoo (52W/Beta/Volumen)
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    const [q, p, rec, news, yx] = await Promise.all([
      fhQuote(e.s, fhKey), jget(`${FH}/stock/profile2?symbol=${e.s}&token=${fhKey}`),
      jget(`${FH}/stock/recommendation?symbol=${e.s}&token=${fhKey}`), jget(`${FH}/company-news?symbol=${e.s}&from=${from}&to=${to}&token=${fhKey}`),
      yfGet(e.s).catch(() => null),
    ]);
    if (!q || !q.c) throw new Error("Kein Kurs — US-Ticker prüfen, oder für Nicht-US den Preset/Börsen-Ticker nutzen (z.B. RHM.DE).");
    const [nm, sec] = US_NAME[e.s] || [e.s, "—"]; const now = Date.now();
    return {
      s: e.s, region: "US", name: p?.name || nm, sector: p?.finnhubIndustry || sec, currency: "USD",
      price: q?.c ?? null, chg: q?.d != null ? +(+q.d).toFixed(2) : null, chgPct: q?.dp != null ? +(+q.dp).toFixed(2) : null,
      open: q?.o, high: q?.h, low: q?.l, prevClose: q?.pc, mktcap: p?.marketCapitalization ? +(p.marketCapitalization / 1000).toFixed(1) : null,
      pe: yx?.pe ?? null, eps: yx?.eps ?? null, divYield: yx?.divYield ?? null, target: yx?.target ?? null,
      week52Low: yx?.week52Low ?? null, week52High: yx?.week52High ?? null, volume: yx?.volume ?? null, avgVolume: yx?.avgVolume ?? null, beta: yx?.beta ?? null, earningsDate: yx?.earningsDate ?? null,
      financials: yx?.financials || [],
      fundamentals: yx?.fundamentals || [], industry: yx?.industry || "", isFinancial: !!(yx && yx.isFinancial),
      source: yx?.source || "finnhub", partial: yx?.partial || null,
      recos: Array.isArray(rec) ? rec.slice(0, 4).map((x) => ({ period: x.period, strongBuy: x.strongBuy, buy: x.buy, hold: x.hold, sell: x.sell, strongSell: x.strongSell })) : [],
      news: Array.isArray(news) ? news.slice(0, 8).map((n) => ({ headline: n.headline, source: (n.source || "NEWS").toUpperCase().slice(0, 10), ago: Math.max(1, Math.floor((now - n.datetime * 1000) / 6e4)), summary: n.summary || "", url: n.url, tags: [e.s] })) : [],
    };
  }

  /* Groq AI (OpenAI-kompatibel, kostenlos, kein Kreditkarte nötig) */
  async function askGroq(groqKey, systemPrompt, historyMsgs, latest) {
    const messages = [
      { role: "system", content: systemPrompt },
      ...historyMsgs.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      { role: "user", content: latest },
    ];
    // Auch hier ein hartes Timeout: ohne das bliebe der Knopf bei einer
    // haengenden Antwort dauerhaft auf "analysiere…" stehen. Grosszuegiger als
    // bei Datenabrufen, weil eine Modellantwort legitim laenger dauern darf.
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 45000);
    let res;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, max_tokens: 700, temperature: 0.4 }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error("Zeitüberschreitung nach 45s");
      throw e;
    } finally {
      clearTimeout(to);
    }
    const data = await res.json();
    if (data?.error) throw new Error(data.error.message || "Groq-Fehler");
    return data?.choices?.[0]?.message?.content?.trim() || "Keine Antwort.";
  }

  return {
    EU_PRESETS, ASIA_PRESETS, MACRO_PRESETS, US_MACRO_PRESETS, EURO_MACRO_PRESETS, INDEX_PRESETS, US_UNIVERSE, US_NAME, SECTORS,
    FH, TD, YF, FRED_FN,
    jget, jgetTimeout, keyOf, fredGetBatch,
    fhQuote, tdQuote, tdSeries, yfGet, searchSymbol, localPresetMatch, resolveSymbol,
    CHART_RANGES, getChart, getQuoteLite, getDetail, askGroq,
  };
});
