// peers.js — Peer-Vergleich: Median statt Mittelwert (robuster gegen
// Ausreisser-Firmen in der Gruppe), Perzentil-Rang pro Kennzahl,
// richtungssensitiv (bei manchen Kennzahlen ist hoch gut, bei anderen niedrig).
// Importiert NUR Werte, die ratios.js bereits berechnet hat - keine eigene
// Finanz-Logik, nur Statistik ueber eine Gruppe. Kein Fetch, kein DOM.
// Dual-Export wie ratios.js (Node + Browser, kein Babel).

(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.Peers = mod;
})(typeof self !== "undefined" ? self : this, function () {

  function isNum(x) { return typeof x === "number" && !isNaN(x); }

  // Richtung pro Kennzahl: 'high' = hoeher ist besser, 'low' = niedriger ist
  // besser, 'neutral' = keine Farbaussage (siehe DPO-Kommentar unten).
  //
  // 'low' bei netDebt/netDebtToEbitda/debtToEquity/dso/dio/ccc und 'high' bei
  // den Margen/Renditen/Liquiditaets-/Coverage-Kennzahlen folgt Standard-
  // Finanzkonvention. DPO ist bewusst 'neutral': langsameres Bezahlen schont
  // die eigene Liquiditaet, kann aber Lieferantenbeziehungen belasten - keine
  // eindeutige "besser/schlechter"-Richtung, die als Farbe vertretbar waere.
  var DIRECTIONS = {
    grossMargin: "high", ebitdaMargin: "high", ebitMargin: "high", netMargin: "high", fcfMargin: "high",
    currentRatio: "high", quickRatio: "high", cashRatio: "high",
    netDebt: "low", netDebtToEbitda: "low", interestCoverage: "high", debtToEquity: "low", equityRatio: "high",
    dso: "low", dio: "low", dpo: "neutral", ccc: "low",
    roe: "high", roa: "high", roic: "high",
  };

  function median(values) {
    var valid = values.filter(isNum).slice().sort(function (a, b) { return a - b; });
    if (!valid.length) return null;
    var mid = Math.floor(valid.length / 2);
    return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
  }

  // Perzentil-Rang von `value` innerhalb `allValues` (inkl. sich selbst - Standard-
  // Definition von Perzentil-Rang in einer Verteilung). 100 = bester Wert in der
  // Gruppe, 0 = schlechtester - IMMER in dieser "gut/schlecht"-Richtung normiert,
  // unabhaengig davon ob die Kennzahl selbst 'high' oder 'low' ist. Das erlaubt der
  // UI eine einzige, richtungs-agnostische Farbskala (100=gruen, 0=rot).
  function percentileGoodness(value, allValues, direction) {
    if (!isNum(value) || direction === "neutral") return null;
    var valid = allValues.filter(isNum);
    if (!valid.length) return null;
    var betterOrEqual = valid.filter(function (v) {
      return direction === "low" ? v >= value : v <= value;
    }).length;
    return (betterOrEqual / valid.length) * 100;
  }

  /**
   * @param {Array<{id: string, ratios: object|null}>} companies - Ausgabe von
   *   ratios.computeRatios() pro Firma, unter `ratios` eingehaengt.
   * @returns {{metrics: string[], directions: object, medians: object,
   *   rows: Array<{id, ratios, percentiles}>}}
   */
  function buildPeerTable(companies) {
    var list = companies || [];
    var metrics = Object.keys(DIRECTIONS);
    var medians = {};
    metrics.forEach(function (m) {
      medians[m] = median(list.map(function (c) { return c.ratios ? c.ratios[m] : null; }));
    });
    var rows = list.map(function (c) {
      var percentiles = {};
      metrics.forEach(function (m) {
        var allValues = list.map(function (o) { return o.ratios ? o.ratios[m] : null; });
        var value = c.ratios ? c.ratios[m] : null;
        percentiles[m] = percentileGoodness(value, allValues, DIRECTIONS[m]);
      });
      return { id: c.id, ratios: c.ratios, percentiles: percentiles };
    });
    return { metrics: metrics, directions: DIRECTIONS, medians: medians, rows: rows };
  }

  return { buildPeerTable: buildPeerTable, median: median, percentileGoodness: percentileGoodness, DIRECTIONS: DIRECTIONS };
});
