// mc.test.js — Unit-Tests fuer mc.js. Wie im Rest des Projekts ohne
// Test-Framework, nur Node-Bordmittel:  node test/mc.test.js
//
// Eine Simulation zu testen klingt zunaechst widerspruechlich ("das Ergebnis ist
// doch zufaellig"). Es geht hier deshalb um zwei Dinge, die sehr wohl exakt
// pruefbar sind:
//   1. Die Barwertrechnung selbst - die ist deterministisch und wird gegen von
//      Hand nachgerechnete Werte geprueft.
//   2. Die Reproduzierbarkeit - mit demselben Startwert muss exakt dieselbe
//      Zahlenfolge herauskommen. Genau dafuer gibt es den eigenen Generator
//      statt Math.random().

const assert = require("assert");
const MC = require("../assets/js/mc.js");

function closeTo(actual, expected, eps, msg) {
  eps = eps == null ? 1e-9 : eps;
  assert.ok(actual != null && Math.abs(actual - expected) < eps,
    (msg || "") + " - erwartet ~" + expected + ", erhalten " + actual);
}

// ---------------------------------------------------------------------------
// 1. Barwertrechnung: von Hand nachgerechnet
// ---------------------------------------------------------------------------
{
  // Bewusst winziger Fall, damit er sich vollstaendig per Hand nachvollziehen
  // laesst: 2 Jahre, FCF 100, Wachstum 0%, Abzinsung 10%, ewiges Wachstum 0%,
  // keine Nettoschulden.
  //   Jahr 1: 100 / 1.1            = 90.909090...
  //   Jahr 2: 100 / 1.21           = 82.644628...
  //   Fortfuehrung: 100 / 0.10     = 1000, abgezinst 1000/1.21 = 826.446280...
  //   Summe                        = 999.999999... = 1000 (exakt: 100/0.1 * 1)
  const v = MC.dcfEquityValue({
    fcf0: 100, growth: 0, years: 2, discountRate: 0.10, terminalGrowth: 0, netDebt: 0,
  });
  closeTo(v, 90.9090909090909 + 82.6446280991736 + 826.4462809917355, 1e-6,
    "zweistufiges DCF muss der Handrechnung entsprechen");

  // Nettoschulden gehen 1:1 vom Firmenwert ab.
  const mitSchulden = MC.dcfEquityValue({
    fcf0: 100, growth: 0, years: 2, discountRate: 0.10, terminalGrowth: 0, netDebt: 250,
  });
  closeTo(mitSchulden, v - 250, 1e-6, "Nettoschulden muessen den Eigenkapitalwert genau um ihren Betrag senken");

  // Nettoguthaben (negative Nettoschulden) erhoehen ihn entsprechend.
  const mitCash = MC.dcfEquityValue({
    fcf0: 100, growth: 0, years: 2, discountRate: 0.10, terminalGrowth: 0, netDebt: -250,
  });
  closeTo(mitCash, v + 250, 1e-6, "ein Nettoguthaben muss den Eigenkapitalwert erhoehen");
  console.log("Block 1/8 (DCF gegen Handrechnung, Nettoschulden wirken vorzeichenrichtig): OK");
}

// ---------------------------------------------------------------------------
// 2. Unbrauchbare Annahmen -> null, nie ein Ersatzwert
// ---------------------------------------------------------------------------
{
  const basis = { fcf0: 100, growth: 0.03, years: 10, netDebt: 0 };

  assert.strictEqual(
    MC.dcfEquityValue(Object.assign({}, basis, { discountRate: 0.03, terminalGrowth: 0.03 })), null,
    "Abzinsung == ewiges Wachstum -> Fortfuehrungswert unendlich, muss null liefern");
  assert.strictEqual(
    MC.dcfEquityValue(Object.assign({}, basis, { discountRate: 0.02, terminalGrowth: 0.04 })), null,
    "Abzinsung < ewiges Wachstum -> negativer Fortfuehrungswert, muss null liefern statt einer sinnlosen Zahl");
  assert.strictEqual(
    MC.dcfEquityValue({ fcf0: -50, growth: 0.03, years: 10, discountRate: 0.09, terminalGrowth: 0.02, netDebt: 0 }), null,
    "negativer Free Cashflow -> DCF ist das falsche Werkzeug, nicht bloss ungenau");
  assert.strictEqual(
    MC.dcfEquityValue({ fcf0: 0, growth: 0.03, years: 10, discountRate: 0.09, terminalGrowth: 0.02, netDebt: 0 }), null,
    "FCF von 0 muss ebenfalls abgelehnt werden");
  assert.strictEqual(MC.dcfEquityValue(null), null, "fehlende Parameter duerfen nicht werfen");
  console.log("Block 2/8 (unbrauchbare Annahmen liefern null statt einer Scheinzahl): OK");
}

// ---------------------------------------------------------------------------
// 3. Reproduzierbarkeit: gleicher Startwert -> exakt gleiche Folge
// ---------------------------------------------------------------------------
{
  const a = MC.mulberry32(12345);
  const b = MC.mulberry32(12345);
  const c = MC.mulberry32(99999);
  const fa = [], fb = [], fc = [];
  for (let i = 0; i < 50; i++) { fa.push(a()); fb.push(b()); fc.push(c()); }

  assert.deepStrictEqual(fa, fb, "gleicher Startwert muss exakt dieselbe Folge liefern - sonst sind die Tests wertlos");
  assert.notDeepStrictEqual(fa, fc, "verschiedene Startwerte muessen verschiedene Folgen liefern");
  assert.ok(fa.every((x) => x >= 0 && x < 1), "alle Werte muessen im Intervall [0,1) liegen");
  console.log("Block 3/8 (Generator ist reproduzierbar und liegt im gueltigen Bereich): OK");
}

// ---------------------------------------------------------------------------
// 4. Dreiecksverteilung: begrenzt und um den wahrscheinlichsten Wert zentriert
// ---------------------------------------------------------------------------
{
  const rng = MC.mulberry32(7);
  const vals = [];
  for (let i = 0; i < 20000; i++) vals.push(MC.triangular(rng, 0, 0.25, 1));

  assert.ok(vals.every((v) => v >= 0 && v <= 1),
    "die Verteilung muss BEGRENZT sein - das ist der Grund fuer Dreieck statt Normalverteilung");

  // Erwartungswert der Dreiecksverteilung = (min+mode+max)/3 = 0.41666...
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  closeTo(mean, (0 + 0.25 + 1) / 3, 0.01, "Mittelwert muss (min+mode+max)/3 entsprechen");

  // Bei mode=0.25 muss die linke Haelfte deutlich dichter besetzt sein als die rechte.
  const links = vals.filter((v) => v < 0.25).length;
  const rechts = vals.filter((v) => v > 0.75).length;
  assert.ok(links > rechts, "der wahrscheinlichste Wert muss die Verteilung tatsaechlich verschieben");

  // Entarteter Fall: min == max darf nicht NaN erzeugen (Division durch 0).
  assert.strictEqual(MC.triangular(rng, 0.05, 0.05, 0.05), 0.05,
    "eine Spanne der Breite 0 muss den Wert selbst liefern, nicht NaN");
  console.log("Block 4/8 (Dreiecksverteilung: begrenzt, richtig gewichtet, kein NaN bei Breite 0): OK");
}

// ---------------------------------------------------------------------------
// 5. Stapelweise Ausfuehrung == ein grosser Lauf
// ---------------------------------------------------------------------------
{
  // Das ist die entscheidende Zusicherung fuer die Live-Anzeige: Das Fenster
  // rechnet in vielen kleinen Stapeln, damit der Browser nicht einfriert. Das
  // Ergebnis muss aber exakt dasselbe sein wie bei einem Lauf am Stueck -
  // sonst haenge das Resultat an der Bildwiederholrate des Geraets.
  const params = {
    fcf0: 1000, netDebt: 200, years: 10,
    growth: { min: 0.00, mode: 0.03, max: 0.06 },
    discountRate: { min: 0.07, mode: 0.09, max: 0.11 },
    terminalGrowth: { min: 0.005, mode: 0.02, max: 0.03 },
  };

  const amStueck = MC.runBatch(600, params, MC.mulberry32(42));

  const rngB = MC.mulberry32(42);
  let inStapeln = [];
  let skipped = 0;
  for (let i = 0; i < 6; i++) {
    const r = MC.runBatch(100, params, rngB);
    inStapeln = inStapeln.concat(r.values);
    skipped += r.skipped;
  }

  assert.deepStrictEqual(inStapeln, amStueck.values,
    "6x100 muss Wert fuer Wert dasselbe liefern wie 1x600 - sonst haengt das Ergebnis an der Stapelgroesse");
  assert.strictEqual(skipped, amStueck.skipped, "auch die Zahl der verworfenen Durchlaeufe muss uebereinstimmen");
  console.log("Block 5/8 (stapelweise Ausfuehrung liefert identisches Ergebnis wie ein Lauf am Stueck): OK");
}

// ---------------------------------------------------------------------------
// 6. Verworfene Durchlaeufe werden gezaehlt, nicht stillschweigend geschluckt
// ---------------------------------------------------------------------------
{
  // Annahmebaender, die sich ueberlappen: die Abzinsung kann unter das ewige
  // Wachstum rutschen. Solche Ziehungen MUESSEN auffallen, sonst sieht der
  // Nutzer eine Verteilung aus 3000 statt 10000 Durchlaeufen und merkt nichts.
  const params = {
    fcf0: 1000, netDebt: 0, years: 10,
    growth: { min: 0.02, mode: 0.03, max: 0.04 },
    discountRate: { min: 0.02, mode: 0.04, max: 0.06 },
    terminalGrowth: { min: 0.02, mode: 0.04, max: 0.06 },
  };
  const r = MC.runBatch(1000, params, MC.mulberry32(3));
  assert.ok(r.skipped > 0, "ueberlappende Baender muessen zu verworfenen Durchlaeufen fuehren");
  assert.strictEqual(r.values.length + r.skipped, 1000, "jeder Durchlauf muss entweder zaehlen oder als verworfen gemeldet werden");

  // Gegenprobe: saubere, nicht ueberlappende Baender verwerfen nichts.
  const sauber = MC.runBatch(1000, {
    fcf0: 1000, netDebt: 0, years: 10,
    growth: { min: 0.00, mode: 0.03, max: 0.06 },
    discountRate: { min: 0.08, mode: 0.09, max: 0.10 },
    terminalGrowth: { min: 0.01, mode: 0.02, max: 0.03 },
  }, MC.mulberry32(3));
  assert.strictEqual(sauber.skipped, 0, "bei sauber getrennten Baendern darf nichts verworfen werden");
  console.log("Block 6/8 (verworfene Durchlaeufe werden gezaehlt statt verschluckt): OK");
}

// ---------------------------------------------------------------------------
// 7. Statistik: Perzentile, Anteil ueber Boersenwert, fehlender marketCap
// ---------------------------------------------------------------------------
{
  const werte = [];
  for (let i = 1; i <= 100; i++) werte.push(i); // 1..100, gleichverteilt

  const s = MC.summarize(werte, 50);
  assert.strictEqual(s.n, 100);
  assert.strictEqual(s.min, 1);
  assert.strictEqual(s.max, 100);
  closeTo(s.p50, 50.5, 1e-9, "Median von 1..100");
  closeTo(s.mean, 50.5, 1e-9, "Mittelwert von 1..100");
  // 50 Werte (51..100) liegen ueber 50 -> genau die Haelfte
  closeTo(s.shareAboveMarket, 0.5, 1e-9, "Anteil ueber dem Boersenwert muss exakt stimmen");
  closeTo(s.upsideP50, 50.5 / 50 - 1, 1e-9, "Aufschlag am Median gegenueber dem Boersenwert");

  // Reihenfolge darf keine Rolle spielen - summarize sortiert selbst.
  const gemischt = MC.summarize(werte.slice().reverse(), 50);
  closeTo(gemischt.p50, s.p50, 1e-9, "unsortierte Eingabe muss dasselbe Ergebnis liefern");

  // Ohne marketCap: Verteilung ja, Bewertungsaussage nein (null, nicht 0).
  const ohne = MC.summarize(werte, null);
  assert.strictEqual(ohne.p50, s.p50, "die Wertverteilung steht auch ohne Boersenwert");
  assert.strictEqual(ohne.shareAboveMarket, null, "ohne Boersenwert darf es KEINE Bewertungsaussage geben");
  assert.strictEqual(ohne.upsideP50, null, "fehlender Input -> null, nie ein stillschweigender Ersatzwert");
  assert.strictEqual(MC.summarize([], 50), null, "leere Eingabe -> null");
  console.log("Block 7/8 (Statistik exakt, fehlender Boersenwert unterdrueckt nur die Bewertungsaussage): OK");
}

// ---------------------------------------------------------------------------
// 8. Startannahmen aus echten Bilanzzeilen
// ---------------------------------------------------------------------------
{
  // capex negativ (Yahoo-Konvention) -> FCF = 500 + (-200) = 300
  const rows = [
    { year: 2025, revenue: 1200, operatingCashflow: 500, capex: -200 },
    { year: 2024, revenue: 1000, operatingCashflow: 450, capex: -180 },
  ];
  const p = MC.suggestParams(rows);
  closeTo(p.fcf0, 300, 1e-9, "FCF = operativer Cashflow + capex (capex kommt negativ an)");
  closeTo(p.histGrowth, 0.2, 1e-9, "historisches Wachstum 1200/1000-1 = 20%");
  // 20% werden auf 15% gedeckelt - eine Firma waechst nicht zehn Jahre lang so.
  closeTo(p.growth.mode, 0.15, 1e-9, "das Wachstum muss gedeckelt in die Annahme eingehen");
  assert.ok(p.discountRate.min < p.discountRate.mode && p.discountRate.mode < p.discountRate.max,
    "die Kapitalkosten-Spanne muss aufsteigend sein");
  assert.ok(p.terminalGrowth.max < p.discountRate.min,
    "ewiges Wachstum muss unter der niedrigsten Abzinsung liegen, sonst verwirft die Simulation staendig");

  // Schrumpfender Umsatz wird nach unten gedeckelt (-5%), nicht durchgereicht.
  const schrumpf = MC.suggestParams([
    { year: 2025, revenue: 500, operatingCashflow: 500, capex: -200 },
    { year: 2024, revenue: 1000, operatingCashflow: 450, capex: -180 },
  ]);
  closeTo(schrumpf.growth.mode, -0.05, 1e-9, "-50% historisch muessen auf -5% gedeckelt werden");

  // Fehlende Pflichtfelder -> null statt einer erfundenen Annahme.
  assert.strictEqual(MC.suggestParams([{ year: 2025, revenue: 100 }]), null,
    "ohne Cashflow/capex darf keine Annahme erfunden werden");
  assert.strictEqual(MC.suggestParams([]), null, "leere Historie -> null");
  assert.strictEqual(MC.suggestParams(null), null, "fehlende Historie darf nicht werfen");

  // Nur ein Jahr: kein historisches Wachstum ableitbar -> Standardwert, kein Absturz.
  const einJahr = MC.suggestParams([{ year: 2025, revenue: 1200, operatingCashflow: 500, capex: -200 }]);
  assert.strictEqual(einJahr.histGrowth, null, "aus einem einzigen Jahr laesst sich kein Wachstum ableiten");
  closeTo(einJahr.growth.mode, 0.03, 1e-9, "dann greift der konservative Standardwert");
  console.log("Block 8/8 (Startannahmen: gedeckelt, vorzeichenrichtig, kein Erfinden bei Luecken): OK");
}

console.log("\nAlle mc.js-Tests erfolgreich.");
