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

  // Fasst Balken zu groesseren Kerzen zusammen (z.B. Tage -> Wochen).
  //
  // WOZU: Der 5-Jahres-Zeitraum liefert rund 1250 Tagesbalken. Als Kerzen
  // gezeichnet waere jede Kerze einen halben Pixel breit - unlesbar, und
  // nebenbei ueber 2500 SVG-Elemente. Zusammenfassen ist hier KEINE
  // Schoenrechnerei, sondern die uebliche Definition einer Wochenkerze:
  //   Open  = Open des ERSTEN Balkens der Gruppe
  //   Hoch  = hoechstes Hoch der Gruppe
  //   Tief  = tiefstes Tief der Gruppe
  //   Close = Close des LETZTEN Balkens der Gruppe
  //   Volumen = Summe
  //
  // Balken ohne o/h/l (Yahoo-Luecken an Feiertagen) tragen nur ihren
  // Schlusskurs bei: sie duerfen die Gruppe nicht entwerten, aber auch kein
  // Hoch/Tief aus dem Nichts erfinden. Enthaelt eine Gruppe KEINEN einzigen
  // vollstaendigen Balken, bleibt die Kerze ohne o/h/l - die Linie zeichnet
  // trotzdem weiter. Gleiche Regel wie ueberall: fehlt der Input, ist das
  // Ergebnis null, nie ein stillschweigender Ersatzwert.
  function aggregateOHLC(series, groupSize) {
    if (!series || !series.length) return [];
    const n = Math.max(1, Math.floor(groupSize || 1));
    if (n === 1) return series.slice();

    const out = [];
    for (let i = 0; i < series.length; i += n) {
      const gruppe = series.slice(i, i + n);
      const voll = gruppe.filter((b) => b.o != null && b.h != null && b.l != null);

      let vol = null;
      for (let k = 0; k < gruppe.length; k++) {
        if (gruppe[k].v != null) vol = (vol || 0) + gruppe[k].v;
      }

      const kerze = {
        t: gruppe[0].t,
        p: gruppe[gruppe.length - 1].p,
        v: vol,
        o: null, h: null, l: null,
      };
      if (voll.length) {
        kerze.o = voll[0].o;
        kerze.h = Math.max.apply(null, voll.map((b) => b.h));
        kerze.l = Math.min.apply(null, voll.map((b) => b.l));
      }
      out.push(kerze);
    }
    return out;
  }

  // Wie stark muss zusammengefasst werden, damit hoechstens `maxBars` Kerzen
  // uebrig bleiben? Bewusst hier und nicht in der Oberflaeche, damit die Regel
  // testbar ist und nicht als Zauberzahl im JSX steht.
  function groupSizeFor(count, maxBars) {
    const max = Math.max(1, maxBars || 160);
    if (!count || count <= max) return 1;
    return Math.ceil(count / max);
  }

  return { sma, rsi, aggregateOHLC, groupSizeFor };
});
