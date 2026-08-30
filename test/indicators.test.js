// indicators.test.js — Unit-Tests fuer indicators.js. Ohne Test-Framework,
// nur Node-Bordmittel:  node test/indicators.test.js
//
// Schwerpunkt ist das Zusammenfassen von Balken zu groesseren Kerzen: dort
// entscheidet sich, ob eine Wochenkerze die Woche korrekt wiedergibt oder
// stillschweigend etwas anderes zeigt als die Tagesdaten.

const assert = require("assert");
const { sma, rsi, aggregateOHLC, groupSizeFor } = require("../assets/js/indicators.js");

function bar(t, o, h, l, p, v) { return { t: t, o: o, h: h, l: l, p: p, v: v }; }

// ---------------------------------------------------------------------------
// 1. SMA
// ---------------------------------------------------------------------------
{
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.strictEqual(out[0], null, "vor dem ersten vollen Fenster gibt es keinen Wert");
  assert.strictEqual(out[1], null);
  assert.strictEqual(out[2], 2, "(1+2+3)/3");
  assert.strictEqual(out[3], 3, "(2+3+4)/3");
  assert.strictEqual(out[4], 4, "(3+4+5)/3");
  assert.strictEqual(out.length, 5, "die Laenge muss der Eingabe entsprechen");
  console.log("Block 1/6 (SMA: gleitender Durchschnitt, Vorlauf bleibt null): OK");
}

// ---------------------------------------------------------------------------
// 2. RSI
// ---------------------------------------------------------------------------
{
  // Durchgehend steigend -> kein einziger Verlusttag -> RSI 100.
  const steigend = rsi([1, 2, 3, 4, 5, 6, 7, 8], 3);
  assert.strictEqual(steigend[3], 100, "ohne Verluste ist der RSI 100 (Division durch 0 muss abgefangen sein)");

  // Der RSI muss immer im Bereich 0..100 liegen - sonst stimmt die Formel nicht.
  const gemischt = rsi([10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17], 4);
  gemischt.forEach((v, i) => {
    if (v != null) assert.ok(v >= 0 && v <= 100, `RSI an Position ${i} liegt ausserhalb 0..100: ${v}`);
  });

  // Zu wenig Daten -> lauter null statt Absturz oder Phantasiewert.
  assert.deepStrictEqual(rsi([1, 2], 14), [null, null], "zu kurze Reihe -> null, kein Absturz");
  console.log("Block 2/6 (RSI: Grenzfaelle, Wertebereich, zu kurze Reihe): OK");
}

// ---------------------------------------------------------------------------
// 3. Zusammenfassen: die Kerze muss die Gruppe korrekt wiedergeben
// ---------------------------------------------------------------------------
{
  const tage = [
    bar("2026-01-01", 10, 12, 9, 11, 100),
    bar("2026-01-02", 11, 15, 10, 14, 200),
    bar("2026-01-03", 14, 14.5, 13, 13.5, 300),
    bar("2026-01-04", 13.5, 16, 13, 15, 400),
  ];
  const wochen = aggregateOHLC(tage, 4);
  assert.strictEqual(wochen.length, 1, "vier Tage bei Gruppengroesse 4 -> eine Kerze");
  const k = wochen[0];
  assert.strictEqual(k.t, "2026-01-01", "das Datum ist das des ERSTEN Balkens der Gruppe");
  assert.strictEqual(k.o, 10, "Open = Open des ersten Balkens");
  assert.strictEqual(k.p, 15, "Close = Close des LETZTEN Balkens");
  assert.strictEqual(k.h, 16, "Hoch = hoechstes Hoch der Gruppe (nicht das des ersten/letzten)");
  assert.strictEqual(k.l, 9, "Tief = tiefstes Tief der Gruppe");
  assert.strictEqual(k.v, 1000, "Volumen wird summiert");
  console.log("Block 3/6 (Zusammenfassen: Open/Close von den Raendern, Hoch/Tief aus der ganzen Gruppe): OK");
}

// ---------------------------------------------------------------------------
// 4. Unvollstaendige Gruppen und Luecken
// ---------------------------------------------------------------------------
{
  // Letzte Gruppe kleiner als groupSize -> muss trotzdem eine Kerze ergeben,
  // sonst faellt das aktuellste (interessanteste) Stueck stillschweigend weg.
  const fuenf = [
    bar("d1", 10, 11, 9, 10.5, 10), bar("d2", 10.5, 12, 10, 11, 10),
    bar("d3", 11, 13, 11, 12, 10), bar("d4", 12, 12.5, 11, 11.5, 10),
    bar("d5", 11.5, 14, 11, 13, 10),
  ];
  const g = aggregateOHLC(fuenf, 2);
  assert.strictEqual(g.length, 3, "5 Balken bei Gruppengroesse 2 -> 3 Kerzen (die letzte halb voll)");
  assert.strictEqual(g[2].p, 13, "die angebrochene letzte Gruppe darf nicht verschluckt werden");
  assert.strictEqual(g[2].o, 11.5);

  // Luecke mitten in der Gruppe: nur der Schlusskurs zaehlt, o/h/l wird ignoriert.
  const mitLuecke = [
    bar("d1", 10, 12, 9, 11, 5),
    { t: "d2", o: null, h: null, l: null, p: 20, v: 5 },
  ];
  const kl = aggregateOHLC(mitLuecke, 2)[0];
  assert.strictEqual(kl.p, 20, "der Schlusskurs des Lueckenbalkens zaehlt weiterhin");
  assert.strictEqual(kl.h, 12, "ein Balken ohne Hoch darf das Gruppen-Hoch NICHT anheben");
  assert.strictEqual(kl.l, 9, "und das Tief nicht senken");

  // Gruppe komplett ohne o/h/l -> keine Kerze, aber die Linie bleibt.
  const nurClose = aggregateOHLC([
    { t: "d1", o: null, h: null, l: null, p: 10, v: null },
    { t: "d2", o: null, h: null, l: null, p: 11, v: null },
  ], 2)[0];
  assert.strictEqual(nurClose.o, null, "ohne einen einzigen vollstaendigen Balken gibt es keine Kerze");
  assert.strictEqual(nurClose.h, null);
  assert.strictEqual(nurClose.p, 11, "der Schlusskurs steht trotzdem");
  assert.strictEqual(nurClose.v, null, "Volumen bleibt null, wird nicht zu 0 addiert");
  console.log("Block 4/6 (angebrochene Gruppen, Luecken erfinden kein Hoch/Tief): OK");
}

// ---------------------------------------------------------------------------
// 5. Entartete Faelle
// ---------------------------------------------------------------------------
{
  const eins = [bar("d1", 10, 11, 9, 10.5, 7)];
  assert.deepStrictEqual(aggregateOHLC(eins, 1), eins, "Gruppengroesse 1 muss die Reihe unveraendert lassen");
  assert.deepStrictEqual(aggregateOHLC(eins, 0), eins, "Gruppengroesse 0 darf keine Endlosschleife ausloesen");
  assert.deepStrictEqual(aggregateOHLC([], 5), [], "leere Reihe -> leere Reihe");
  assert.deepStrictEqual(aggregateOHLC(null, 5), [], "fehlende Reihe darf nicht werfen");

  // Die Originalreihe darf nicht veraendert werden (Gruppengroesse 1 gibt eine Kopie).
  const kopie = aggregateOHLC(eins, 1);
  kopie[0] = null;
  assert.ok(eins[0] != null, "die Eingabe darf nicht ueberschrieben werden");
  console.log("Block 5/6 (entartete Eingaben: keine Endlosschleife, kein Absturz, keine Mutation): OK");
}

// ---------------------------------------------------------------------------
// 6. Gruppengroesse aus der Balkenzahl
// ---------------------------------------------------------------------------
{
  assert.strictEqual(groupSizeFor(100, 160), 1, "passt schon rein -> nicht zusammenfassen");
  assert.strictEqual(groupSizeFor(160, 160), 1, "genau an der Grenze -> noch nicht zusammenfassen");
  assert.strictEqual(groupSizeFor(320, 160), 2, "doppelt so viele -> je zwei zusammen");
  assert.strictEqual(groupSizeFor(1250, 160), 8, "5 Jahre Tagesdaten -> etwa Wochenkerzen");
  assert.strictEqual(groupSizeFor(0, 160), 1, "keine Daten -> keine Division durch 0");

  // Die abgeleitete Gruppengroesse muss die Obergrenze auch wirklich einhalten.
  [200, 500, 1250, 3000].forEach((n) => {
    const g = groupSizeFor(n, 160);
    assert.ok(Math.ceil(n / g) <= 160, `bei ${n} Balken bleiben ${Math.ceil(n / g)} Kerzen - mehr als erlaubt`);
  });
  console.log("Block 6/6 (Gruppengroesse haelt die Obergrenze in jedem Fall ein): OK");
}

console.log("\nAlle indicators.js-Tests erfolgreich.");
