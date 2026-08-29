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

(async function run() {
  const { _internal } = fresh();
  assert.ok(_internal && _internal.shape, "shape() muss fuer Tests exportiert sein");
  const { shape } = _internal;

  // --- Der eigentliche Fehler: previousClose muss gewinnen ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: 109, chartPreviousClose: 80 }), "^GSPC");
    assert.strictEqual(out.prevClose, 109, "prevClose MUSS der Vortagesschluss sein, nicht der Kurs vor dem Chart-Zeitraum");
    assert.strictEqual(out.chg, 1, "Tagesveraenderung 110-109 = 1");
    assert.strictEqual(out.chgPct, 0.92, "Tagesveraenderung in Prozent, nicht die 37.5% des Halbjahres");
    console.log("Block 1/6 (previousClose hat Vorrang vor chartPreviousClose): OK");
  }

  // --- Rueckfallebene: fehlt previousClose, darf chartPreviousClose einspringen ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: null, chartPreviousClose: 80 }), "^GSPC");
    assert.strictEqual(out.prevClose, 80, "ohne previousClose ist chartPreviousClose besser als gar nichts");
    console.log("Block 2/6 (Rueckfall auf chartPreviousClose wenn noetig): OK");
  }

  // --- Letzte Rueckfallebene: gar keine Meta-Angabe -> vorletzter Punkt der Reihe ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: null, chartPreviousClose: null }), "^GSPC");
    assert.strictEqual(out.prevClose, 109, "ohne Meta-Angaben zaehlt der vorletzte Kurs der Zeitreihe");
    console.log("Block 3/6 (Rueckfall auf die Zeitreihe): OK");
  }

  // --- Bei range=1d sind beide Werte gleich - das Ergebnis darf sich nicht aendern ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: 109, chartPreviousClose: 109 }), "^GSPC");
    assert.strictEqual(out.chgPct, 0.92, "bei kurzem Zeitraum sind beide Felder identisch, das Ergebnis bleibt korrekt");
    console.log("Block 4/6 (kurzer Zeitraum: unveraendert korrekt): OK");
  }

  // --- Haengendes Yahoo darf die Function nicht bis zu Netlifys hartem Abbruch
  //     laufen lassen. Vorher liefen hier ALLE Aufrufe als blankes fetch() ohne
  //     Frist: getSession und yGet haengten, fetchAll wiederholte das viermal
  //     ueber zwei Hosts - der Aufrufer bekam am Ende keinen Fehlertext,
  //     sondern einen abgerissenen Aufruf. ---
  {
    const mod = fresh();
    let stooqAngefragt = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("stooq.com")) {
        stooqAngefragt = true;
        return { ok: true, status: 200, text: async () => "Date,Open,High,Low,Close,Volume\n2026-08-26,10,11,9,10.5,100\n2026-08-27,10.5,11,10,10.8,120\n" };
      }
      // Yahoo antwortet ueberhaupt nicht - nur das Abort-Signal beendet den Aufruf.
      return new Promise((_, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    };
    const t0 = Date.now();
    const res = await mod.handler({ httpMethod: "GET", queryStringParameters: { symbol: "AAPL" } });
    const dt = Date.now() - t0;
    console.log("  Dauer bei durchgehend haengendem Yahoo:", (dt / 1000).toFixed(1) + "s");
    assert.ok(dt < 10000, `die Function muss selbst abbrechen, bevor Netlify sie nach 10s hart beendet (gemessen: ${dt}ms)`);
    assert.strictEqual(res.statusCode, 200, "die Ersatzquelle Stooq muss trotzdem ein Ergebnis liefern");
    assert.ok(stooqAngefragt, "nach dem Yahoo-Abbruch MUSS Stooq noch drankommen - sonst waere die Ersatzquelle genau dann wertlos, wenn man sie braucht");
    const body = JSON.parse(res.body);
    assert.strictEqual(body.source, "stooq");
    assert.ok(body.partial, "der eingeschraenkte Datenumfang der Ersatzquelle muss benannt sein");
    console.log("Block 5/6 (haengendes Yahoo: Abbruch im Budget, Stooq springt ein): OK");
  }

  // --- Auch die Symbolsuche braucht eine Frist: sie laeuft bei jedem
  //     Tastendruck im Suchfeld. ---
  {
    const mod = fresh();
    global.fetch = async (url, opts) => new Promise((_, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const t0 = Date.now();
    const res = await mod.handler({ httpMethod: "GET", queryStringParameters: { search: "apple" } });
    const dt = Date.now() - t0;
    console.log("  Dauer der Suche bei haengendem Yahoo:", (dt / 1000).toFixed(1) + "s");
    // Deutlich strenger als das Gesamtbudget: die Suche laeuft waehrend des
    // Tippens, da waeren acht Sekunden Starre unbrauchbar - auch wenn die
    // Function damit technisch noch innerhalb von Netlifys Limit bliebe.
    assert.ok(dt < 6000, `die Suche braucht ein eigenes, knappes Budget statt des vollen Funktionsbudgets (gemessen: ${dt}ms)`);
    assert.strictEqual(res.statusCode, 200, "eine ergebnislose Suche ist kein Serverfehler");
    assert.deepStrictEqual(JSON.parse(res.body).quotes, [], "ohne Antwort gibt es eben keine Vorschlaege - aber keinen Haenger");
    console.log("Block 6/6 (Symbolsuche bricht bei haengendem Yahoo sauber ab): OK");
  }

  console.log("\nAlle quote.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
