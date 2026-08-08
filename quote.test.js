// quote.test.js — Tests fuer die Kurs-Function, Schwerpunkt Tagesveraenderung.
//   node quote.test.js
//
// Anlass: Im Laufband standen Werte wie "S&P 500 +11.91%" und "Nasdaq +15.89%".
// Das sind keine Tagesveraenderungen, sondern Halbjahres-Veraenderungen - die
// Function hat meta.chartPreviousClose (Schlusskurs VOR dem angefragten
// Zeitraum, Standard 6mo) statt meta.previousClose (Vortagesschluss) benutzt.

const assert = require("assert");
const path = "/home/user/Bloomberg/netlify/functions/quote.js";
function fresh() { delete require.cache[require.resolve(path)]; return require(path); }

// Baut eine Yahoo-Chart-Antwort nach: Kurs 110, Vortagesschluss 109 (= +0.92%),
// aber der Schlusskurs vor dem 6-Monats-Fenster lag bei 80 (= +37.5%).
function yahooChart({ previousClose, chartPreviousClose, regularMarketPrice }) {
  return {
    chart: {
      chart: {
        result: [{
          meta: {
            symbol: "^GSPC", longName: "S&P 500", currency: "USD", fullExchangeName: "SNP",
            regularMarketPrice, previousClose, chartPreviousClose,
          },
          timestamp: [1735689600, 1735776000, 1735862400],
          indicators: { quote: [{ close: [80, 109, regularMarketPrice], volume: [1, 2, 3] }] },
        }],
      },
    },
  };
}

(function run() {
  const { _internal } = fresh();
  assert.ok(_internal && _internal.shape, "shape() muss fuer Tests exportiert sein");
  const { shape } = _internal;

  // --- Der eigentliche Fehler: previousClose muss gewinnen ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: 109, chartPreviousClose: 80 }), "^GSPC");
    assert.strictEqual(out.prevClose, 109, "prevClose MUSS der Vortagesschluss sein, nicht der Kurs vor dem Chart-Zeitraum");
    assert.strictEqual(out.chg, 1, "Tagesveraenderung 110-109 = 1");
    assert.strictEqual(out.chgPct, 0.92, "Tagesveraenderung in Prozent, nicht die 37.5% des Halbjahres");
    console.log("Block 1/4 (previousClose hat Vorrang vor chartPreviousClose): OK");
  }

  // --- Rueckfallebene: fehlt previousClose, darf chartPreviousClose einspringen ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: null, chartPreviousClose: 80 }), "^GSPC");
    assert.strictEqual(out.prevClose, 80, "ohne previousClose ist chartPreviousClose besser als gar nichts");
    console.log("Block 2/4 (Rueckfall auf chartPreviousClose wenn noetig): OK");
  }

  // --- Letzte Rueckfallebene: gar keine Meta-Angabe -> vorletzter Punkt der Reihe ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: null, chartPreviousClose: null }), "^GSPC");
    assert.strictEqual(out.prevClose, 109, "ohne Meta-Angaben zaehlt der vorletzte Kurs der Zeitreihe");
    console.log("Block 3/4 (Rueckfall auf die Zeitreihe): OK");
  }

  // --- Bei range=1d sind beide Werte gleich - das Ergebnis darf sich nicht aendern ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: 109, chartPreviousClose: 109 }), "^GSPC");
    assert.strictEqual(out.chgPct, 0.92, "bei kurzem Zeitraum sind beide Felder identisch, das Ergebnis bleibt korrekt");
    console.log("Block 4/4 (kurzer Zeitraum: unveraendert korrekt): OK");
  }

  console.log("\nAlle quote.js-Tests erfolgreich.");
})();
