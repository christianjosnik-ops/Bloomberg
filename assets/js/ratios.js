// ratios.js — reine Kennzahlen-Berechnung auf normalisierten Jahresabschluss-
// Zeilen (Schema siehe netlify/functions/lib/normalizer.js). Kein Fetch, kein
// DOM. Dual-Export: laeuft unveraendert in Node (ratios.test.js, spaeter auch
// im Zinssensitivitaets-Modul) UND im Browser (<script src="assets/js/ratios.js">, ohne
// Babel-Transpilierung - deshalb bewusst kein Optional Chaining/Nullish
// Coalescing, nur breit unterstuetztes ES6).
//
// Grundregel durchgaengig: fehlt ein benoetigter Input, ist das Ergebnis null.
// Niemals ein fehlendes Feld stillschweigend als 0 behandeln - das wuerde eine
// Kennzahl vortaeuschen, die es nicht gibt.

(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.Ratios = mod;
})(typeof self !== "undefined" ? self : this, function () {

  function isNum(x) { return typeof x === "number" && !isNaN(x); }
  function allPresent() {
    for (var i = 0; i < arguments.length; i++) { if (!isNum(arguments[i])) return false; }
    return true;
  }
  function div(a, b) { return (isNum(a) && isNum(b) && b !== 0) ? a / b : null; }
  function avg(a, b) { return (isNum(a) && isNum(b)) ? (a + b) / 2 : null; }
  function get(row, key) { return row && isNum(row[key]) ? row[key] : null; }

  // ---- Margen (nur laufendes Jahr, keine Bilanz-Durchschnitte noetig) ----
  function margins(row) {
    var fcfMargin = allPresent(row.operatingCashflow, row.capex, row.revenue) && row.revenue !== 0
      ? (row.operatingCashflow - Math.abs(row.capex)) / row.revenue : null;
    return {
      grossMargin: div(row.grossProfit, row.revenue),
      ebitdaMargin: div(row.ebitda, row.revenue),
      ebitMargin: div(row.operatingIncome, row.revenue), // operatingIncome = EBIT (siehe normalizer.js Mapping)
      netMargin: div(row.netIncome, row.revenue),
      fcfMargin: fcfMargin,
    };
  }

  // ---- Liquiditaet (Stichtag, keine Durchschnitte - Branchenkonvention) ----
  function liquidity(row) {
    var quickRatio = allPresent(row.currentAssets, row.inventory, row.currentLiabilities)
      ? div(row.currentAssets - row.inventory, row.currentLiabilities) : null;
    var cashRatio = allPresent(row.cash, row.shortTermInvestments, row.currentLiabilities)
      ? div(row.cash + row.shortTermInvestments, row.currentLiabilities) : null;
    return {
      currentRatio: div(row.currentAssets, row.currentLiabilities),
      quickRatio: quickRatio,
      cashRatio: cashRatio,
    };
  }

  // ---- Verschuldung ----
  function leverage(row) {
    var netDebt = allPresent(row.totalDebt, row.cash) ? row.totalDebt - row.cash : null;
    // Negatives EBITDA -> Net Debt/EBITDA ist nicht interpretierbar (Edge-Case-Regel)
    var netDebtToEbitda = (netDebt != null && isNum(row.ebitda) && row.ebitda > 0) ? netDebt / row.ebitda : null;
    var interestCoverage = allPresent(row.operatingIncome, row.interestExpense) && row.interestExpense !== 0
      ? row.operatingIncome / row.interestExpense : null;
    // Negatives EK -> Debt/Equity wuerde sich wie niedrige Verschuldung lesen (Vorzeichenfehler-Falle,
    // gleiches Prinzip wie bei ROE) -> n/a statt irrefuehrender Zahl
    var debtToEquity = allPresent(row.totalDebt, row.equity) && row.equity > 0 ? row.totalDebt / row.equity : null;
    // EK-Quote bekommt KEINE Negativ-Sperre: eine negative Quote ist direkt und korrekt als
    // Ueberschuldung lesbar, hat nicht die Vorzeichen-Falle von ROE/Debt-Equity
    var equityRatio = div(row.equity, row.totalAssets);
    return { netDebt: netDebt, netDebtToEbitda: netDebtToEbitda, interestCoverage: interestCoverage, debtToEquity: debtToEquity, equityRatio: equityRatio };
  }

  // ---- Working Capital (mischt GuV-Fluss mit Bilanz-Bestand -> Bilanzwerte mitteln) ----
  function workingCapital(current, prior) {
    var avgReceivables = avg(get(current, "receivables"), prior ? get(prior, "receivables") : null);
    var avgInventory = avg(get(current, "inventory"), prior ? get(prior, "inventory") : null);
    var avgPayables = avg(get(current, "payables"), prior ? get(prior, "payables") : null);
    var rev = get(current, "revenue"), cogs = get(current, "costOfRevenue");

    var dso = (avgReceivables != null && isNum(rev) && rev !== 0) ? (avgReceivables / rev) * 365 : null;
    var dio = (avgInventory != null && isNum(cogs) && cogs !== 0) ? (avgInventory / cogs) * 365 : null;
    var dpo = (avgPayables != null && isNum(cogs) && cogs !== 0) ? (avgPayables / cogs) * 365 : null;
    var ccc = allPresent(dso, dio, dpo) ? dso + dio - dpo : null;
    return { dso: dso, dio: dio, dpo: dpo, ccc: ccc };
  }

  function investedCapital(row) {
    return allPresent(row.equity, row.totalDebt, row.cash) ? row.equity + row.totalDebt - row.cash : null;
  }

  // ---- Rendite (mischt GuV-Fluss mit Bilanz-Bestand -> Bilanzwerte mitteln) ----
  function returns(current, prior) {
    var avgEquity = avg(get(current, "equity"), prior ? get(prior, "equity") : null);
    var avgAssets = avg(get(current, "totalAssets"), prior ? get(prior, "totalAssets") : null);

    // Negatives EK -> ROE wuerde bei Verlust positiv und bei Gewinn negativ erscheinen
    // (klassische Vorzeichen-Falle) -> explizit n/a statt irrefuehrender Zahl
    var roe = (avgEquity != null && avgEquity > 0 && isNum(current.netIncome)) ? current.netIncome / avgEquity : null;
    var roa = (avgAssets != null && isNum(current.netIncome)) ? current.netIncome / avgAssets : null;

    var effTaxRate = allPresent(current.taxExpense, current.pretaxIncome) && current.pretaxIncome > 0
      ? current.taxExpense / current.pretaxIncome : null;
    var nopat = (effTaxRate != null && isNum(current.operatingIncome)) ? current.operatingIncome * (1 - effTaxRate) : null;
    var icCurrent = investedCapital(current);
    var icPrior = prior ? investedCapital(prior) : null;
    var avgInvestedCapital = avg(icCurrent, icPrior);
    var roic = (nopat != null && avgInvestedCapital != null && avgInvestedCapital > 0) ? nopat / avgInvestedCapital : null;

    return { roe: roe, roa: roa, roic: roic, avgEquity: avgEquity, avgAssets: avgAssets };
  }

  // ---- DuPont-Dreifaktor-Zerlegung: ROE = Nettomarge x Kapitalumschlag x Eigenkapital-Multiplikator ----
  function dupont(current, prior) {
    var avgEquity = avg(get(current, "equity"), prior ? get(prior, "equity") : null);
    var avgAssets = avg(get(current, "totalAssets"), prior ? get(prior, "totalAssets") : null);
    var netMargin = div(current.netIncome, current.revenue);
    var assetTurnover = div(current.revenue, avgAssets);
    var equityMultiplier = (avgAssets != null && avgEquity != null && avgEquity > 0) ? avgAssets / avgEquity : null;
    var roe = allPresent(netMargin, assetTurnover, equityMultiplier) ? netMargin * assetTurnover * equityMultiplier : null;
    return { netMargin: netMargin, assetTurnover: assetTurnover, equityMultiplier: equityMultiplier, roe: roe };
  }

  // ---- Orchestrierung ----
  // current: normalisierte Zeile des betrachteten Jahres. prior: Vorjahreszeile
  // oder null (dann werden alle Bilanz-Durchschnitts-Kennzahlen automatisch null).
  function computeRatios(current, prior) {
    if (!current) return null;
    var p = prior || null;
    var out = { year: current.year };
    var parts = [margins(current), liquidity(current), leverage(current), workingCapital(current, p), returns(current, p)];
    for (var i = 0; i < parts.length; i++) {
      for (var k in parts[i]) { if (Object.prototype.hasOwnProperty.call(parts[i], k)) out[k] = parts[i][k]; }
    }
    return out;
  }

  // rows: normalizer.js-Output, absteigend nach Jahr sortiert (neuestes zuerst).
  function computeSeries(rows) {
    if (!rows || !rows.length) return [];
    var out = [];
    for (var i = 0; i < rows.length; i++) { out.push(computeRatios(rows[i], rows[i + 1] || null)); }
    return out;
  }

  return { computeRatios: computeRatios, computeSeries: computeSeries, dupont: dupont, div: div, avg: avg };
});
