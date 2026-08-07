// ratios.test.js — Unit-Tests fuer ratios.js. Bewusst ohne Test-Framework
// (kein Jest/Vitest/Mocha), nur Node-Bordmittel: assert + node ratios.test.js.
// Referenzwerte wurden von Hand nachgerechnet (siehe Kommentare je Block).

const assert = require("assert");
const { computeRatios, dupont, div, avg } = require("./ratios.js");

function closeTo(actual, expected, eps, msg) {
  eps = eps == null ? 1e-9 : eps;
  assert.ok(actual != null && Math.abs(actual - expected) < eps,
    (msg || "") + " - erwartet ~" + expected + ", erhalten " + actual);
}

// ---------------------------------------------------------------------------
// Fixture: zwei Jahre eines fiktiven Unternehmens, von Hand durchgerechnet.
// ---------------------------------------------------------------------------
const y2023 = {
  year: 2023,
  revenue: 1000, costOfRevenue: 600, grossProfit: 400,
  operatingIncome: 200, // EBIT
  ebitda: 250, // = EBIT(200) + D&A(50), wie normalizer.js es ableitet
  interestExpense: 20, pretaxIncome: 180, taxExpense: 45, netIncome: 135,
  operatingCashflow: 220, capex: -80, // Yahoo-Konvention: capex negativ
  totalAssets: 2000, currentAssets: 800, cash: 300, shortTermInvestments: 100,
  receivables: 250, inventory: 150, currentLiabilities: 400, payables: 180,
  shortTermDebt: 50, longTermDebt: 450, totalDebt: 500, equity: 900, totalLiabilities: 1100,
};
const y2022 = {
  year: 2022,
  revenue: 900, costOfRevenue: 550,
  receivables: 210, inventory: 130, payables: 160,
  totalAssets: 1800, equity: 800, totalDebt: 480, cash: 250,
};

const r = computeRatios(y2023, y2022);

// ---- Margen (nur 2023, keine Durchschnittsbildung) ----
closeTo(r.grossMargin, 400 / 1000, 1e-9, "grossMargin");
closeTo(r.ebitdaMargin, 250 / 1000, 1e-9, "ebitdaMargin");
closeTo(r.ebitMargin, 200 / 1000, 1e-9, "ebitMargin");
closeTo(r.netMargin, 135 / 1000, 1e-9, "netMargin");
closeTo(r.fcfMargin, (220 - 80) / 1000, 1e-9, "fcfMargin (capex-Vorzeichen via Math.abs neutralisiert)");

// ---- Liquiditaet (Stichtag 2023) ----
closeTo(r.currentRatio, 800 / 400, 1e-9, "currentRatio");
closeTo(r.quickRatio, (800 - 150) / 400, 1e-9, "quickRatio = (currentAssets - inventory) / currentLiabilities");
closeTo(r.cashRatio, (300 + 100) / 400, 1e-9, "cashRatio");

// ---- Verschuldung ----
closeTo(r.netDebt, 500 - 300, 1e-9, "netDebt = totalDebt - cash");
closeTo(r.netDebtToEbitda, 200 / 250, 1e-9, "netDebtToEbitda");
closeTo(r.interestCoverage, 200 / 20, 1e-9, "interestCoverage = EBIT / Zinsaufwand");
closeTo(r.debtToEquity, 500 / 900, 1e-9, "debtToEquity");
closeTo(r.equityRatio, 900 / 2000, 1e-9, "equityRatio");

// ---- Working Capital (mit Vorjahres-Durchschnitt) ----
// avgReceivables=(250+210)/2=230, avgInventory=(150+130)/2=140, avgPayables=(180+160)/2=170
closeTo(r.dso, (230 / 1000) * 365, 1e-6, "DSO");
closeTo(r.dio, (140 / 600) * 365, 1e-6, "DIO");
closeTo(r.dpo, (170 / 600) * 365, 1e-6, "DPO");
closeTo(r.ccc, 65.7, 1e-6, "CCC = DSO+DIO-DPO, von Hand: 83.95 + 85.1666667 - 103.4166667 = 65.7");

// ---- Rendite (mit Vorjahres-Durchschnitt) ----
// avgEquity=(900+800)/2=850, avgAssets=(2000+1800)/2=1900
closeTo(r.roe, 135 / 850, 1e-9, "ROE = netIncome / avgEquity");
closeTo(r.roa, 135 / 1900, 1e-9, "ROA = netIncome / avgAssets");
// effTaxRate=45/180=0.25, NOPAT=200*0.75=150
// investedCapital(2023)=900+500-300=1100, investedCapital(2022)=800+480-250=1030, avg=1065
closeTo(r.roic, 150 / 1065, 1e-9, "ROIC = NOPAT / avgInvestedCapital");

// ---- DuPont: netMargin x assetTurnover x equityMultiplier muss algebraisch exakt ROE ergeben ----
const dp = dupont(y2023, y2022);
closeTo(dp.netMargin, 135 / 1000, 1e-9, "DuPont netMargin");
closeTo(dp.assetTurnover, 1000 / 1900, 1e-9, "DuPont assetTurnover");
closeTo(dp.equityMultiplier, 1900 / 850, 1e-9, "DuPont equityMultiplier");
closeTo(dp.roe, r.roe, 1e-9, "DuPont-Produkt muss identisch mit direkt berechnetem ROE sein (Identitaet)");

console.log("Block 1/3 (Hauptfixture, handgerechnet): OK");

// ---------------------------------------------------------------------------
// Fixture: fehlende Felder -> null-Handling, niemals 0 oder NaN.
// ---------------------------------------------------------------------------
const sparse = {
  year: 2023,
  revenue: 1000, netIncome: 50,
  // grossProfit, operatingIncome, ebitda, interestExpense: absichtlich weggelassen
  // Bilanzfelder absichtlich komplett weggelassen (keine Bilanz verfuegbar)
};

const rSparse = computeRatios(sparse, null); // kein Vorjahr

assert.strictEqual(rSparse.grossMargin, null, "fehlendes grossProfit -> grossMargin null, nicht 0");
assert.strictEqual(rSparse.ebitdaMargin, null, "fehlendes ebitda -> null");
assert.strictEqual(rSparse.ebitMargin, null, "fehlendes operatingIncome -> null");
assert.strictEqual(rSparse.netMargin, 50 / 1000, "netMargin berechenbar trotz fehlender anderer Felder");
assert.strictEqual(rSparse.fcfMargin, null, "fehlender Cashflow -> null");
assert.strictEqual(rSparse.currentRatio, null, "keine Bilanz -> currentRatio null");
assert.strictEqual(rSparse.quickRatio, null);
assert.strictEqual(rSparse.cashRatio, null);
assert.strictEqual(rSparse.netDebt, null, "fehlender totalDebt/cash -> netDebt null (NICHT 0)");
assert.strictEqual(rSparse.netDebtToEbitda, null);
assert.strictEqual(rSparse.interestCoverage, null, "fehlender Zinsaufwand -> null, kein Wurf/NaN");
assert.strictEqual(rSparse.debtToEquity, null);
assert.strictEqual(rSparse.equityRatio, null);
assert.strictEqual(rSparse.dso, null, "kein Vorjahr + keine Bilanz -> DSO null");
assert.strictEqual(rSparse.dio, null);
assert.strictEqual(rSparse.dpo, null);
assert.strictEqual(rSparse.ccc, null);
assert.strictEqual(rSparse.roe, null, "kein Vorjahr -> avgEquity null -> ROE null");
assert.strictEqual(rSparse.roa, null);
assert.strictEqual(rSparse.roic, null);

// Keine der Kennzahlen darf NaN sein (haeufigster Bug bei Division ohne Guard)
Object.keys(rSparse).forEach(function (k) {
  const v = rSparse[k];
  assert.ok(v === null || (typeof v === "number" && !isNaN(v)), "Feld " + k + " ist NaN statt null: " + v);
});

console.log("Block 2/3 (fehlende Felder -> null statt 0/NaN): OK");

// ---------------------------------------------------------------------------
// Edge Cases: negatives EK, negatives EBITDA, Zinsaufwand = 0
// ---------------------------------------------------------------------------
const negEquity = Object.assign({}, y2023, { equity: -100 });
const rNegEq = computeRatios(negEquity, y2022);
assert.strictEqual(rNegEq.equityRatio, -100 / 2000, "equityRatio bleibt trotz negativem EK berechnet (aussagekraeftig: Ueberschuldung)");
assert.strictEqual(computeRatios(negEquity, Object.assign({}, y2022, { equity: -50 })).roe, null, "negatives (avg) EK -> ROE explizit n/a");
assert.strictEqual(computeRatios(negEquity, y2022).debtToEquity, null, "negatives EK -> Debt/Equity explizit n/a (Vorzeichen-Falle)");

const negEbitda = Object.assign({}, y2023, { ebitda: -50 });
assert.strictEqual(computeRatios(negEbitda, y2022).netDebtToEbitda, null, "negatives EBITDA -> Net Debt/EBITDA n/a");

const zeroInterest = Object.assign({}, y2023, { interestExpense: 0 });
assert.strictEqual(computeRatios(zeroInterest, y2022).interestCoverage, null, "Zinsaufwand 0 -> Interest Coverage n/a statt Infinity");

console.log("Block 3/3 (Edge Cases: neg. EK, neg. EBITDA, Zinsaufwand=0): OK");

// ---------------------------------------------------------------------------
// div/avg Basisverhalten (von peers.js und der UI direkt wiederverwendet)
// ---------------------------------------------------------------------------
assert.strictEqual(div(10, 2), 5);
assert.strictEqual(div(10, 0), null, "Division durch 0 -> null, nicht Infinity");
assert.strictEqual(div(null, 5), null);
assert.strictEqual(div(5, null), null);
assert.strictEqual(avg(4, 6), 5);
assert.strictEqual(avg(4, null), null, "avg mit fehlendem Wert -> null, nicht nur der eine vorhandene Wert");

console.log("\nAlle ratios.js-Tests erfolgreich.");
