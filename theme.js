// theme.js — Farbschema, Formatierungs-Helfer und Anzeige-Metadaten. Reine
// Konstanten/Funktionen, kein Fetch, kein DOM, keine JSX. Dual-Export wie
// ratios.js/peers.js: laeuft unveraendert in Node (Tests) und im Browser
// (<script src="theme.js">, ohne Babel - dieser Code enthaelt kein JSX und
// braucht daher keine Transpilierung).
//
// Ausgelagert aus index.html, um die Menge an JSX-Code zu verkleinern, die
// Babel bei jedem Seitenaufruf live im Browser kompilieren muss, und um
// reine Logik unabhaengig von der React-UI testbar zu machen.

(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.Theme = mod;
})(typeof self !== "undefined" ? self : this, function () {

  // WICHTIG: Diese Farben sind mit den CSS-Custom-Properties in index.html
  // (:root-Block) gespiegelt. C wird dort gebraucht, wo CSS nicht hinkommt -
  // vor allem als fill/stroke in den SVG-Charts. Aenderungen immer an beiden
  // Stellen machen, sonst driften Chart- und UI-Farben auseinander.
  const C = {
    bg: "#000000",        // --bg
    panel: "#0b0c0e",     // --surface
    panel2: "#07080a",    // --surface-2
    panel3: "#121316",    // --surface-3
    line: "#24262b",      // --line
    lineStrong: "#34373d",// --line-strong
    orange: "#ff8a1e",    // --accent
    amber: "#ffb000",     // --accent-2
    amberDim: "#7a5416",  // --accent-dim
    amberBg: "#17140a",   // --accent-bg
    green: "#3fd07a",     // --up
    red: "#ff5252",       // --down
    blue: "#4ea3ff",      // --info
    violet: "#c07af0",    // --violet
    white: "#e8e9ec",     // --fg
    text: "#c9cbd0",      // --fg-2
    muted: "#8f959f",     // --fg-3
  };
  const mono = "ui-monospace, 'SF Mono', 'DejaVu Sans Mono', Menlo, monospace";
  const inp = { background: C.panel2, border: `1px solid ${C.line}`, color: C.amber, padding: "6px 8px", fontFamily: mono, fontSize: 12, outline: "none" };
  const CUR = { USD: "$", EUR: "€", GBP: "£", CHF: "Fr", JPY: "¥", HKD: "HK$", KRW: "₩", "": "" };

  const fmtCap = (b) => (b == null ? "—" : b >= 1000 ? (b / 1000).toFixed(2) + "T" : b.toFixed(1) + "B");
  const fmtVol = (v) => (v == null ? "—" : v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : String(v));
  const ago = (m) => (m < 60 ? m + "m" : Math.floor(m / 60) + "h");

  /* F5 RATIO: Formatierung + Metrik-Metadaten (UI-Schicht, importiert nur aus Ratios/Peers) */
  const fmtMoney = (v) => { if (v == null) return "n/a"; const sign = v < 0 ? "-" : ""; const av = Math.abs(v);
    return sign + (av >= 1e9 ? (av / 1e9).toFixed(2) + "B" : av >= 1e6 ? (av / 1e6).toFixed(1) + "M" : av >= 1e3 ? (av / 1e3).toFixed(0) + "K" : av.toFixed(0)); };
  const fmtRatio = (v, kind) => { if (v == null) return "n/a";
    if (kind === "pct") return (v * 100).toFixed(1) + "%"; if (kind === "days") return v.toFixed(0) + "T";
    if (kind === "money") return fmtMoney(v); return v.toFixed(2) + "x"; };
  const pctColor = (p) => { if (p == null) return "transparent"; const t = Math.max(0, Math.min(100, p)) / 100;
    return t >= 0.5 ? `rgba(63,208,122,${0.1 + (t - 0.5) * 0.9})` : `rgba(255,82,82,${0.1 + (0.5 - t) * 0.9})`; };
  // Nicht in DIRECTIONS (peers.js), sondern hier: Anzeige-Metadaten. Reihenfolge = Gruppen-Reihenfolge in der UI.
  const METRIC_META = {
    grossMargin: { label: "Brutto-Marge", group: "Marge", fmt: "pct" }, ebitdaMargin: { label: "EBITDA-Marge", group: "Marge", fmt: "pct" },
    ebitMargin: { label: "EBIT-Marge", group: "Marge", fmt: "pct" }, netMargin: { label: "Netto-Marge", group: "Marge", fmt: "pct" },
    fcfMargin: { label: "FCF-Marge", group: "Marge", fmt: "pct" },
    currentRatio: { label: "Current Ratio", group: "Liquidität", fmt: "x" }, quickRatio: { label: "Quick Ratio", group: "Liquidität", fmt: "x" },
    cashRatio: { label: "Cash Ratio", group: "Liquidität", fmt: "x" },
    netDebt: { label: "Net Debt", group: "Verschuldung", fmt: "money" }, netDebtToEbitda: { label: "Net Debt/EBITDA", group: "Verschuldung", fmt: "x" },
    interestCoverage: { label: "Zinsdeckung", group: "Verschuldung", fmt: "x" }, debtToEquity: { label: "Debt/Equity", group: "Verschuldung", fmt: "x" },
    equityRatio: { label: "EK-Quote", group: "Verschuldung", fmt: "pct" },
    dso: { label: "DSO", group: "Working Capital", fmt: "days" }, dio: { label: "DIO", group: "Working Capital", fmt: "days" },
    dpo: { label: "DPO", group: "Working Capital", fmt: "days" }, ccc: { label: "Cash Conversion Cycle", group: "Working Capital", fmt: "days" },
    roe: { label: "ROE", group: "Rendite", fmt: "pct" }, roa: { label: "ROA", group: "Rendite", fmt: "pct" }, roic: { label: "ROIC", group: "Rendite", fmt: "pct" },
  };
  // Working-Capital-/Verschuldungskennzahlen ergeben fuer Banken/Versicherer kein sinnvolles Bild
  // (siehe Edge-Case-Vorgabe) - werden fuer diese Gruppen ausgeblendet statt Unsinn anzuzeigen.
  const RATIO_SUPPRESS_FOR_FINANCIALS = ["currentRatio", "quickRatio", "cashRatio", "netDebt", "netDebtToEbitda", "interestCoverage", "debtToEquity", "equityRatio", "dso", "dio", "dpo", "ccc"];

  /* F6 WELTLAGE: Metadaten */
  const GEO_LEVEL_META = {
    "kritisch": { color: "#ff5252", order: 4, label: "KRITISCH" },
    "hoch": { color: "#ff7a45", order: 3, label: "HOCH" },
    "mittel": { color: "#ffb000", order: 2, label: "MITTEL" },
    "niedrig": { color: "#d9c05a", order: 1, label: "NIEDRIG" },
    "keine": { color: "#8f959f", order: 0, label: "KEINE" },
    "nicht geprüft": { color: "#8f959f", order: -1, label: "N/GEPRÜFT" },
  };
  const geoLevelMeta = (level) => GEO_LEVEL_META[level] || GEO_LEVEL_META["keine"];

  return { C, mono, inp, CUR, fmtCap, fmtVol, fmtMoney, fmtRatio, pctColor, ago, METRIC_META, RATIO_SUPPRESS_FOR_FINANCIALS, GEO_LEVEL_META, geoLevelMeta };
});
