// normalizer.js — Rohe Yahoo quoteSummary-Felder (balanceSheetHistory,
// incomeStatementHistory, cashflowStatementHistory) in ein einheitliches,
// geschaeftsjahr-basiertes Schema umwandeln. CommonJS, laeuft ausschliesslich
// serverseitig in quote.js (braucht kein Fetch, kein DOM).
//
// WICHTIG: Die Yahoo-Feldnamen unten stammen aus der historisch dokumentierten
// quoteSummary-Struktur (aus anderen Yahoo-Finance-API-Wrappern bekannt). Sie
// wurden in dieser Umgebung NICHT live gegen die Yahoo-API verifiziert (kein
// Netzwerkzugriff hier). Nach dem ersten Deploy unbedingt gegenchecken, ob die
// erwarteten Felder tatsaechlich ankommen - siehe TODO-Kommentar in quote.js.
//
// Fehlende Felder werden IMMER null, nie 0 - ein fehlender Wert ist kein
// Nullwert und darf keine falsche Kennzahl vortaeuschen.

const num = (x) => {
  if (x == null) return null;
  if (typeof x === "number") return Number.isNaN(x) ? null : x;
  if (typeof x.raw === "number" && !Number.isNaN(x.raw)) return x.raw;
  return null;
};

// Normalisiertes Feld -> Liste moeglicher Yahoo-Rohfeldnamen (Fallback-Kette).
// Reihenfolge = Praeferenz. Erstes vorhandenes, numerisches Feld gewinnt.
const FIELD_MAP = {
  // Bilanz (balanceSheetHistory)
  totalAssets: { stmt: "bs", keys: ["totalAssets"] },
  currentAssets: { stmt: "bs", keys: ["totalCurrentAssets"] },
  cash: { stmt: "bs", keys: ["cash", "cashAndCashEquivalents"] },
  shortTermInvestments: { stmt: "bs", keys: ["shortTermInvestments"] },
  receivables: { stmt: "bs", keys: ["netReceivables", "receivables"] },
  inventory: { stmt: "bs", keys: ["inventory"] },
  currentLiabilities: { stmt: "bs", keys: ["totalCurrentLiabilities"] },
  payables: { stmt: "bs", keys: ["accountsPayable"] },
  shortTermDebt: { stmt: "bs", keys: ["shortLongTermDebt", "shortTermDebt", "currentDebt"] },
  longTermDebt: { stmt: "bs", keys: ["longTermDebt"] },
  totalLiabilities: { stmt: "bs", keys: ["totalLiab", "totalLiabilities"] },
  equity: { stmt: "bs", keys: ["totalStockholderEquity", "stockholdersEquity", "commonStockEquity"] },
  // GuV (incomeStatementHistory)
  revenue: { stmt: "is", keys: ["totalRevenue"] },
  costOfRevenue: { stmt: "is", keys: ["costOfRevenue"] },
  grossProfit: { stmt: "is", keys: ["grossProfit"] },
  operatingIncome: { stmt: "is", keys: ["ebit", "operatingIncome"] }, // = EBIT
  interestExpense: { stmt: "is", keys: ["interestExpense"] },
  pretaxIncome: { stmt: "is", keys: ["incomeBeforeTax", "pretaxIncome"] },
  taxExpense: { stmt: "is", keys: ["incomeTaxExpense", "taxProvision"] },
  netIncome: { stmt: "is", keys: ["netIncome", "netIncomeApplicableToCommonShares"] },
  // Kapitalflussrechnung (cashflowStatementHistory)
  depreciationAmortization: { stmt: "cf", keys: ["depreciation", "depreciationAndAmortization"] },
  operatingCashflow: { stmt: "cf", keys: ["totalCashFromOperatingActivities", "operatingCashflow"] },
  capex: { stmt: "cf", keys: ["capitalExpenditures"] },
};

function pick(statement, keys) {
  if (!statement) return null;
  for (const k of keys) {
    if (statement[k] !== undefined) {
      const v = num(statement[k]);
      if (v != null) return v;
    }
  }
  return null;
}

function endYear(statement) {
  const d = statement && statement.endDate;
  if (!d) return null;
  if (typeof d.raw === "number") return new Date(d.raw * 1000).getUTCFullYear();
  if (d.fmt) { const y = parseInt(String(d.fmt).slice(0, 4), 10); return Number.isNaN(y) ? null : y; }
  return null;
}

/**
 * Baut aus den drei rohen Statement-Arrays eine nach Jahr sortierte Liste
 * normalisierter Zeilen (neuestes Jahr zuerst - wichtig fuer ratios.js, das
 * fuer Durchschnittsbildung auf row[i] (aktuell) und row[i+1] (Vorjahr) zugreift).
 *
 * @param {{balanceSheet: object[], incomeStatement: object[], cashflow: object[]}} raw
 * @returns {Array<object>} normalisierte Jahreszeilen, absteigend sortiert
 */
function normalizeStatements({ balanceSheet, incomeStatement, cashflow }) {
  const bsList = Array.isArray(balanceSheet) ? balanceSheet : [];
  const isList = Array.isArray(incomeStatement) ? incomeStatement : [];
  const cfList = Array.isArray(cashflow) ? cashflow : [];

  const years = new Set();
  for (const s of [...bsList, ...isList, ...cfList]) { const y = endYear(s); if (y != null) years.add(y); }

  return Array.from(years).sort((a, b) => b - a).map((year) => {
    const bs = bsList.find((s) => endYear(s) === year) || null;
    const is = isList.find((s) => endYear(s) === year) || null;
    const cf = cfList.find((s) => endYear(s) === year) || null;
    const byStmt = { bs, is, cf };

    const row = { year };
    for (const [field, def] of Object.entries(FIELD_MAP)) {
      row[field] = pick(byStmt[def.stmt], def.keys);
    }
    // EBITDA = EBIT + Abschreibungen (Statement-uebergreifend, nur wenn beide vorhanden)
    row.ebitda = (row.operatingIncome != null && row.depreciationAmortization != null)
      ? row.operatingIncome + row.depreciationAmortization : null;
    // Gesamtschulden = kurz- + langfristig, nur null wenn wirklich beide fehlen
    row.totalDebt = (row.shortTermDebt == null && row.longTermDebt == null)
      ? null : (row.shortTermDebt || 0) + (row.longTermDebt || 0);
    return row;
  });
}

// Grobe Branchen-Erkennung fuer den Edge-Case "Working-Capital-/Leverage-
// Kennzahlen bei Banken/Versicherern ausblenden". Basiert auf assetProfile-
// Feldern (sector/industry), die quote.js bereits laedt.
function isFinancialCompany(sector, industry) {
  const s = `${sector || ""} ${industry || ""}`.toLowerCase();
  return /bank|insurance|versicherung|reit|real estate investment/.test(s);
}

module.exports = { normalizeStatements, isFinancialCompany, num, FIELD_MAP };
