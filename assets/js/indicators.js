// indicators.js — technische Chart-Indikatoren (SMA, RSI). Reine Funktionen
// auf Zahlen-Arrays, kein Fetch, kein DOM, kein JSX. Dual-Export wie
// ratios.js/peers.js/theme.js.

(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.Indicators = mod;
})(typeof self !== "undefined" ? self : this, function () {

  function sma(vals, period) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= period) sum -= vals[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function rsi(vals, period) {
    const out = new Array(vals.length).fill(null);
    if (vals.length < period + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = vals[i] - vals[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1]; const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      gain = (gain * (period - 1) + g) / period; loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  return { sma, rsi };
});
