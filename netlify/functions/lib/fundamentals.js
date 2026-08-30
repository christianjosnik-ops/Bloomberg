// fundamentals.js — Jahresabschluesse ueber Yahoos Zeitreihen-Endpunkt
// (fundamentals-timeseries). Reine Aufbereitung, kein Fetch: die URL wird hier
// gebaut, abgeholt wird sie in quote.js. CommonJS, nur serverseitig.
//
// WARUM ES DIESE DATEI GIBT
// quote.js holte die Abschluesse bisher ausschliesslich ueber
//   quoteSummary?modules=balanceSheetHistory,incomeStatementHistory,cashflowStatementHistory
// Das ist Yahoos AELTERE Schnittstelle. Sie antwortet fuer viele Titel
// inzwischen mit leeren Modulen - im Betrieb sichtbar daran, dass operativer
// Cashflow und Investitionen fehlten, weshalb sowohl die FCF-Marge (F5 RATIO)
// als auch die Monte-Carlo-Bewertung (F7) ohne Zahlen dastanden.
//
// Der Zeitreihen-Endpunkt ist der Weg, den Yahoos eigene Weboberflaeche heute
// benutzt:
//   /ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}
//     ?symbol={symbol}&type=annualTotalRevenue,annual...&period1=&period2=&merge=false
//
// Antwortform (je angefragtem Typ ein Eintrag in timeseries.result):
//   { timeseries: { result: [
//       { meta: { type: ["annualOperatingCashFlow"] },
//         annualOperatingCashFlow: [
//           { asOfDate: "2024-12-31", periodType: "12M",
//             reportedValue: { raw: 221000000000 } }, ... ] } ] } }
//
// Alles wird defensiv geparst: unerwartete Formen fuehren zu fehlenden Feldern
// (null), nie zum Absturz und nie zu einer 0, die eine Zahl vortaeuscht.

// Zeitreihen-Feldname -> Feldname im normalisierten Schema (siehe normalizer.js).
// Mehrere Quellnamen je Zielfeld sind erlaubt; der ERSTE gefundene gewinnt,
// deshalb steht die genauere Variante vorn. Yahoo benennt dieselbe Groesse je
// nach Titel unterschiedlich (z.B. EBIT vs. OperatingIncome).
const TS_FIELDS = {
  // Bilanz
  annualTotalAssets: "totalAssets",
  annualCurrentAssets: "currentAssets",
  annualCashAndCashEquivalents: "cash",
  annualOtherShortTermInvestments: "shortTermInvestments",
  annualAccountsReceivable: "receivables",
  annualInventory: "inventory",
  annualCurrentLiabilities: "currentLiabilities",
  annualAccountsPayable: "payables",
  annualCurrentDebt: "shortTermDebt",
  annualLongTermDebt: "longTermDebt",
  annualTotalLiabilitiesNetMinorityInterest: "totalLiabilities",
  annualStockholdersEquity: "equity",
  // GuV
  annualTotalRevenue: "revenue",
  annualCostOfRevenue: "costOfRevenue",
  annualGrossProfit: "grossProfit",
  annualEBIT: "operatingIncome",
  annualOperatingIncome: "operatingIncome",
  annualInterestExpense: "interestExpense",
  annualPretaxIncome: "pretaxIncome",
  annualTaxProvision: "taxExpense",
  annualNetIncome: "netIncome",
  annualEBITDA: "ebitda",
  // Kapitalflussrechnung - der eigentliche Anlass fuer diese Datei
  annualOperatingCashFlow: "operatingCashflow",
  annualCapitalExpenditure: "capex",
  annualDepreciationAndAmortization: "depreciationAmortization",
  annualReconciledDepreciation: "depreciationAmortization",
  // Yahoo liefert den freien Cashflow fertig mit. Wenn er da ist, ist er dem
  // Selbstausrechnen vorzuziehen: Yahoo beruecksichtigt dabei Posten, die
  // "operativer Cashflow minus Investitionen" nicht sieht.
  annualFreeCashFlow: "freeCashflowReported",
};

const TS_TYPES = Object.keys(TS_FIELDS);

function num(x) {
  if (x == null) return null;
  if (typeof x === "number") return Number.isNaN(x) ? null : x;
  if (typeof x === "object" && typeof x.raw === "number" && !Number.isNaN(x.raw)) return x.raw;
  return null;
}

/**
 * Baut die Abruf-URL. period1/period2 sind Unix-Sekunden.
 *
 * Der Zeitraum ist bewusst grosszuegig (Standard 6 Jahre): ratios.js braucht
 * fuer Durchschnitts-Kennzahlen immer auch das Vorjahr, und ein zu enges
 * Fenster wuerde beim ersten Jahreswechsel stillschweigend eine Zeile weniger
 * liefern.
 */
function timeseriesUrl(host, symbol, now, jahre) {
  const jetzt = Math.floor((now || Date.now()) / 1000);
  const spanne = (jahre || 6) * 365 * 24 * 3600;
  return `https://${host}.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&type=${TS_TYPES.join(",")}`
    + `&period1=${jetzt - spanne}&period2=${jetzt}&merge=false`;
}

/**
 * Wandelt die Zeitreihen-Antwort in dieselben Jahreszeilen um, die auch
 * normalizer.js liefert (neuestes Jahr zuerst) - damit ratios.js, peers.js und
 * mc.js unveraendert damit arbeiten koennen.
 *
 * @returns {Array<object>} Jahreszeilen, absteigend. Leeres Array, wenn nichts
 *          Verwertbares dabei war - NIE teilweise erfundene Zeilen.
 */
function parseTimeseries(json) {
  const result = json && json.timeseries && Array.isArray(json.timeseries.result)
    ? json.timeseries.result : [];
  if (!result.length) return [];

  // Jahr -> Zeile. Ein Eintrag der Antwort deckt genau EINEN Typ ueber mehrere
  // Jahre ab, deshalb wird ueber alle Eintraege hinweg nach Jahr eingesammelt.
  const nachJahr = new Map();

  // AEUSSERE Schleife ueber die Typen, INNERE ueber die Antwort-Eintraege -
  // nicht umgekehrt. Der Vorrang bei mehreren Quellnamen fuer dasselbe Zielfeld
  // (z.B. annualEBIT vor annualOperatingIncome) muss an der Reihenfolge in
  // TS_FIELDS haengen, nicht daran, in welcher Reihenfolge Yahoo die Eintraege
  // zurueckgibt. Andersherum entschied schlicht der zufaellige Aufbau der
  // Antwort, welcher Wert gewinnt.
  for (const tsName of TS_TYPES) {
    const ziel = TS_FIELDS[tsName];
    for (const eintrag of result) {
      if (!eintrag || typeof eintrag !== "object") continue;
      const werte = eintrag[tsName];
      if (!Array.isArray(werte)) continue;
      for (const punkt of werte) {
        if (!punkt || !punkt.asOfDate) continue;
        // Nur Jahreswerte. Yahoo mischt bei manchen Titeln TTM-Punkte in
        // dieselbe Reihe; die zusammen mit Geschaeftsjahren zu verrechnen
        // waere genau der Fehler, den normalizer.js ausdruecklich vermeidet.
        if (punkt.periodType && punkt.periodType !== "12M") continue;
        const jahr = parseInt(String(punkt.asOfDate).slice(0, 4), 10);
        if (!jahr || Number.isNaN(jahr)) continue;
        const v = num(punkt.reportedValue);
        if (v == null) continue;
        if (!nachJahr.has(jahr)) nachJahr.set(jahr, { year: jahr });
        const zeile = nachJahr.get(jahr);
        // Erster Treffer gewinnt: die Reihenfolge in TS_FIELDS ist die
        // Praeferenz (z.B. EBIT vor OperatingIncome).
        if (zeile[ziel] == null) zeile[ziel] = v;
      }
    }
  }

  const zeilen = Array.from(nachJahr.values()).sort((a, b) => b.year - a.year);

  for (const z of zeilen) {
    // Abgeleitete Felder wie in normalizer.js - gleiche Regeln, damit beide
    // Quellen dasselbe Schema liefern.
    if (z.ebitda == null && z.operatingIncome != null && z.depreciationAmortization != null) {
      z.ebitda = z.operatingIncome + z.depreciationAmortization;
    }
    if (z.totalDebt == null) {
      z.totalDebt = (z.shortTermDebt == null && z.longTermDebt == null)
        ? null : (z.shortTermDebt || 0) + (z.longTermDebt || 0);
    }
    // Fehlende Felder ausdruecklich auf null setzen, damit die Zeilen aus
    // beiden Quellen dieselbe Form haben und ein `in`-Test nicht je nach
    // Herkunft anders ausgeht.
    for (const feld of ALLE_FELDER) { if (z[feld] === undefined) z[feld] = null; }
  }

  // Eine Zeile, die ausser dem Jahr nichts enthaelt, ist wertlos und wuerde in
  // der Oberflaeche als leere Spalte auftauchen.
  return zeilen.filter((z) => ALLE_FELDER.some((f) => z[f] != null));
}

const ALLE_FELDER = [
  "totalAssets", "currentAssets", "cash", "shortTermInvestments", "receivables", "inventory",
  "currentLiabilities", "payables", "shortTermDebt", "longTermDebt", "totalLiabilities", "equity",
  "revenue", "costOfRevenue", "grossProfit", "operatingIncome", "interestExpense", "pretaxIncome",
  "taxExpense", "netIncome", "ebitda", "totalDebt",
  "depreciationAmortization", "operatingCashflow", "capex", "freeCashflowReported",
];

/**
 * Fuehrt zwei Zeilensaetze zusammen (z.B. quoteSummary + Zeitreihe).
 * `bevorzugt` gewinnt je Feld; die andere Quelle fuellt nur Luecken.
 *
 * Absichtlich feldweise statt "ganzer Satz oder gar nicht": In der Praxis
 * liefert die alte Schnittstelle oft Bilanz und GuV, aber keine
 * Kapitalflussrechnung. Ein Entweder-oder wuerde dann entweder den Cashflow
 * oder die Bilanzhistorie wegwerfen, obwohl beide vorliegen.
 */
function mergeRows(bevorzugt, ergaenzung) {
  const a = Array.isArray(bevorzugt) ? bevorzugt : [];
  const b = Array.isArray(ergaenzung) ? ergaenzung : [];
  if (!b.length) return a;
  if (!a.length) return b;

  const nachJahr = new Map();
  for (const z of b) if (z && z.year != null) nachJahr.set(z.year, Object.assign({}, z));
  for (const z of a) {
    if (!z || z.year == null) continue;
    const vorhanden = nachJahr.get(z.year);
    if (!vorhanden) { nachJahr.set(z.year, Object.assign({}, z)); continue; }
    for (const feld of ALLE_FELDER) {
      if (z[feld] != null) vorhanden[feld] = z[feld];
    }
  }
  return Array.from(nachJahr.values()).sort((x, y) => y.year - x.year);
}

module.exports = { TS_FIELDS, TS_TYPES, ALLE_FELDER, timeseriesUrl, parseTimeseries, mergeRows, num };
