// quote.test.js — Tests fuer die Kurs-Function, Schwerpunkt Tagesveraenderung.
//   node test/quote.test.js
//
// Anlass: Im Laufband standen Werte wie "S&P 500 +11.91%" und "Nasdaq +15.89%".
// Das sind keine Tagesveraenderungen, sondern Halbjahres-Veraenderungen - die
// Function hat meta.chartPreviousClose (Schlusskurs VOR dem angefragten
// Zeitraum, Standard 6mo) statt meta.previousClose (Vortagesschluss) benutzt.

const assert = require("assert");
const path = require.resolve("../netlify/functions/quote.js");
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
    console.log("Block 1/8 (previousClose hat Vorrang vor chartPreviousClose): OK");
  }

  // --- Rueckfallebene: fehlt previousClose, darf chartPreviousClose einspringen ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: null, chartPreviousClose: 80 }), "^GSPC");
    assert.strictEqual(out.prevClose, 80, "ohne previousClose ist chartPreviousClose besser als gar nichts");
    console.log("Block 2/8 (Rueckfall auf chartPreviousClose wenn noetig): OK");
  }

  // --- Letzte Rueckfallebene: gar keine Meta-Angabe -> vorletzter Punkt der Reihe ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: null, chartPreviousClose: null }), "^GSPC");
    assert.strictEqual(out.prevClose, 109, "ohne Meta-Angaben zaehlt der vorletzte Kurs der Zeitreihe");
    console.log("Block 3/8 (Rueckfall auf die Zeitreihe): OK");
  }

  // --- Bei range=1d sind beide Werte gleich - das Ergebnis darf sich nicht aendern ---
  {
    const out = shape(yahooChart({ regularMarketPrice: 110, previousClose: 109, chartPreviousClose: 109 }), "^GSPC");
    assert.strictEqual(out.chgPct, 0.92, "bei kurzem Zeitraum sind beide Felder identisch, das Ergebnis bleibt korrekt");
    console.log("Block 4/8 (kurzer Zeitraum: unveraendert korrekt): OK");
  }

  // --- Kerzendaten: Open/Hoch/Tief muessen JE BALKEN mitkommen ---
  //     Vorher enthielt die Zeitreihe nur Schlusskurs und Volumen; die
  //     Kerzendarstellung braucht o/h/l pro Balken. Yahoo liefert sie im
  //     selben quote-Objekt - sie wurden bloss nicht ausgelesen.
  {
    const roh = yahooChart({ regularMarketPrice: 110, previousClose: 109, chartPreviousClose: 80 });
    const q = roh.chart.chart.result[0].indicators.quote[0];
    q.open = [79, 108, 109.5];
    q.high = [81, 110, 111];
    q.low = [78.5, 107, 109];
    const out = shape(roh, "^GSPC");

    assert.strictEqual(out.series.length, 3);
    assert.deepStrictEqual(
      out.series.map((b) => [b.o, b.h, b.l, b.p]),
      [[79, 81, 78.5, 80], [108, 110, 107, 109], [109.5, 111, 109, 110]],
      "jeder Balken muss Open/Hoch/Tief/Schluss tragen");
    // Innere Konsistenz: sonst zeichnet die Kerze einen Docht in die falsche Richtung.
    out.series.forEach((b, i) => {
      assert.ok(b.h >= Math.max(b.o, b.p) && b.l <= Math.min(b.o, b.p),
        `Balken ${i}: Hoch/Tief muessen Open und Schluss einschliessen`);
    });
    console.log("Block 5/8 (Kerzendaten: Open/Hoch/Tief je Balken): OK");
  }

  // --- Luecken in den Kerzendaten duerfen die Zeitreihe nicht zerstoeren ---
  //     Yahoo liefert an Feiertagen/Handelspausen close, aber o/h/l = null.
  //     Solche Balken muessen als Linienpunkt erhalten bleiben (p gesetzt) und
  //     duerfen nur als Kerze fehlen - nicht die ganze Reihe abschneiden und
  //     erst recht keine Kerze aus Nullwerten erzeugen.
  {
    const roh = yahooChart({ regularMarketPrice: 110, previousClose: 109, chartPreviousClose: 80 });
    const q = roh.chart.chart.result[0].indicators.quote[0];
    q.open = [79, null, 109.5];
    q.high = [81, null, 111];
    q.low = [78.5, null, 109];
    const out = shape(roh, "^GSPC");

    assert.strictEqual(out.series.length, 3, "ein Balken ohne o/h/l darf die Zeitreihe nicht kuerzen");
    assert.strictEqual(out.series[1].p, 109, "der Schlusskurs des Lueckenbalkens bleibt erhalten");
    assert.strictEqual(out.series[1].o, null, "fehlendes Open wird null - nie 0, das waere eine erfundene Kerze");
    assert.strictEqual(out.series[1].h, null);
    assert.strictEqual(out.series[1].l, null);
    console.log("Block 6/8 (Luecken in o/h/l: Linie bleibt, Kerze entfaellt, kein Nullwert): OK");
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
    console.log("Block 7/8 (haengendes Yahoo: Abbruch im Budget, Stooq springt ein): OK");
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
    console.log("Block 8/8 (Symbolsuche bricht bei haengendem Yahoo sauber ab): OK");
  }

  console.log("\nAlle quote.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
