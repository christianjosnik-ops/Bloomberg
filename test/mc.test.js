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
  console.log("Block 1/10 (DCF gegen Handrechnung, Nettoschulden wirken vorzeichenrichtig): OK");
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
  console.log("Block 2/10 (unbrauchbare Annahmen liefern null statt einer Scheinzahl): OK");
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
  console.log("Block 3/10 (Generator ist reproduzierbar und liegt im gueltigen Bereich): OK");
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
  console.log("Block 4/10 (Dreiecksverteilung: begrenzt, richtig gewichtet, kein NaN bei Breite 0): OK");
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
  console.log("Block 5/10 (stapelweise Ausfuehrung liefert identisches Ergebnis wie ein Lauf am Stueck): OK");
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
  console.log("Block 6/10 (verworfene Durchlaeufe werden gezaehlt statt verschluckt): OK");
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
  console.log("Block 7/10 (Statistik exakt, fehlender Boersenwert unterdrueckt nur die Bewertungsaussage): OK");
}

// ---------------------------------------------------------------------------
// 8. Freier Cashflow: Rueckfallkette
// ---------------------------------------------------------------------------
{
  // Stufe 1: operativer Cashflow vorhanden -> genauer Wert.
  const ocf = MC.freeCashflow({ operatingCashflow: 900, capex: -200 });
  closeTo(ocf.wert, 700, 1e-9, "operativer Cashflow minus Investitionen");
  assert.strictEqual(ocf.basis, "ocf");
  assert.strictEqual(ocf.genau, true, "diese Stufe ist keine Naeherung");

  // capex kann je nach Quelle positiv ODER negativ ankommen. Beide Vorzeichen
  // muessen dasselbe ergeben - sonst wuerde ein positiv geliefertes capex
  // addiert statt abgezogen und der Cashflow um das Doppelte zu hoch stehen.
  // Genau diese Rechnung macht auch fcfMargin in ratios.js (Math.abs).
  closeTo(MC.freeCashflow({ operatingCashflow: 900, capex: 200 }).wert, 700, 1e-9,
    "positiv geliefertes capex muss ebenfalls ABGEZOGEN werden");

  // Stufe 2: kein operativer Cashflow -> EBIT nach Steuern + Abschreibungen.
  // Steuerquote 60/300 = 20% -> 800*0.8 + 300 - 200 = 740
  const fcff = MC.freeCashflow({ operatingIncome: 800, depreciationAmortization: 300, capex: -200, taxExpense: 60, pretaxIncome: 300 });
  closeTo(fcff.wert, 740, 1e-9, "EBIT x (1-t) + Abschreibungen - Investitionen");
  assert.strictEqual(fcff.basis, "fcff");
  assert.strictEqual(fcff.genau, false, "die Naeherung MUSS als solche gekennzeichnet sein");
  closeTo(fcff.steuerquote, 0.2, 1e-9, "Steuerquote aus der GuV");

  // Unbrauchbare Steuerquote (Sondereffekt) -> Standardwert 25%, nicht der Ausreisser.
  const wild = MC.freeCashflow({ operatingIncome: 800, depreciationAmortization: 300, capex: -200, taxExpense: 900, pretaxIncome: 300 });
  closeTo(wild.steuerquote, 0.25, 1e-9, "eine Quote von 300% darf nicht uebernommen werden");
  const negativ = MC.freeCashflow({ operatingIncome: 800, depreciationAmortization: 300, capex: -200, taxExpense: -50, pretaxIncome: 300 });
  closeTo(negativ.steuerquote, 0.25, 1e-9, "eine negative Quote ebenso wenig");

  // Ohne Investitionen gibt es keinen FREIEN Cashflow - nur einen Zufluss.
  assert.strictEqual(MC.freeCashflow({ operatingCashflow: 900 }), null,
    "ohne capex darf kein Wert geliefert werden, der etwas anderes misst als sein Name sagt");
  assert.strictEqual(MC.freeCashflow({ capex: -200 }), null, "ohne jede Ertragsgroesse -> null");
  assert.strictEqual(MC.freeCashflow(null), null, "fehlende Zeile darf nicht werfen");

  // Der Vorrang muss stimmen: ist der operative Cashflow da, gewinnt er.
  const beides = MC.freeCashflow({ operatingCashflow: 900, operatingIncome: 800, depreciationAmortization: 300, capex: -200 });
  assert.strictEqual(beides.basis, "ocf", "die genauere Stufe hat Vorrang");
  console.log("Block 8/10 (freier Cashflow: Rueckfallkette, capex-Vorzeichen, Steuerquote gedeckelt): OK");
}

// ---------------------------------------------------------------------------
// 9. Negativer freier Cashflow: einmaliger Ausreisser vs. dauerhaft
// ---------------------------------------------------------------------------
{
  // Der DCF selbst lehnt einen negativen Ausgangswert ab (Block 2). Entscheidend
  // ist aber die Frage dahinter: Ist EIN Jahr negativ (Uebernahme,
  // Investitionszyklus) oder verbrennt die Firma dauerhaft Geld? Ohne diese
  // Unterscheidung wuerde ein einziges schlechtes Jahr eine ansonsten
  // ertragsstarke Firma unbewertbar machen.

  // --- Fall A: ein Investitionsjahr, sonst gesund ---
  const ausreisser = [
    { year: 2025, freeCashflowReported: -5e9 },
    { year: 2024, freeCashflowReported: 8e9 },
    { year: 2023, freeCashflowReported: 7e9 },
    { year: 2022, freeCashflowReported: 6e9 },
  ];
  const a = MC.freeCashflowLage(ausreisser);
  assert.strictEqual(a.jahre, 4);
  assert.strictEqual(a.positiveJahre, 3);
  assert.strictEqual(a.neuestes.wert, -5e9, "das neueste Jahr steht vorn");
  closeTo(a.schnitt, 4e9, 1e-6, "Schnitt = (-5+8+7+6)/4 = 4 - die negativen Jahre zaehlen mit");
  assert.strictEqual(a.schnittTaugt, true, "Mehrheit positiv und Schnitt positiv -> als Ausgangswert vertretbar");

  // --- Fall B: verbrennt dauerhaft Geld ---
  const dauerhaft = MC.freeCashflowLage([
    { year: 2025, freeCashflowReported: -5e9 },
    { year: 2024, freeCashflowReported: -4e9 },
    { year: 2023, freeCashflowReported: -6e9 },
  ]);
  assert.strictEqual(dauerhaft.positiveJahre, 0);
  assert.ok(dauerhaft.schnitt < 0);
  assert.strictEqual(dauerhaft.schnittTaugt, false, "hier ist ein DCF unanwendbar, nicht bloss ungenau");

  // --- Fall C: EIN sehr gutes Jahr zieht den Schnitt hoch ---
  // Der Schnitt ist positiv, aber nur wegen eines Ausreissers nach oben. Ihn
  // als Ausgangswert zu nehmen waere Rosinenpickerei - genau das muss die
  // Mehrheitsbedingung verhindern.
  const rosinen = MC.freeCashflowLage([
    { year: 2025, freeCashflowReported: -3e9 },
    { year: 2024, freeCashflowReported: -2e9 },
    { year: 2023, freeCashflowReported: 20e9 },
  ]);
  assert.ok(rosinen.schnitt > 0, "der Schnitt ist hier positiv …");
  assert.strictEqual(rosinen.positiveJahre, 1);
  assert.strictEqual(rosinen.schnittTaugt, false, "… darf aber trotzdem nicht als Ausgangswert taugen");

  // --- Genau die Haelfte positiv reicht nicht ---
  const haelfte = MC.freeCashflowLage([
    { year: 2025, freeCashflowReported: -1e9 },
    { year: 2024, freeCashflowReported: 5e9 },
  ]);
  assert.strictEqual(haelfte.positiveJahre, 1);
  assert.strictEqual(haelfte.schnittTaugt, false, "bei 1 von 2 Jahren ist die Mehrheitsbedingung nicht erfuellt");

  // --- Die Reihe ueberspringt Jahre ohne ableitbaren Cashflow ---
  const mitLuecke = MC.freeCashflowSeries([
    { year: 2025, freeCashflowReported: 3e9 },
    { year: 2024, revenue: 100 },                       // nichts ableitbar
    { year: 2023, operatingCashflow: 5e9, capex: -1e9 },
  ]);
  assert.deepStrictEqual(mitLuecke.map((x) => x.year), [2025, 2023],
    "Jahre ohne ableitbaren Cashflow duerfen nicht als 0 in den Schnitt eingehen");
  closeTo(mitLuecke[1].wert, 4e9, 1e-6, "das dritte Jahr wird aus OCF - |capex| abgeleitet");

  assert.strictEqual(MC.freeCashflowLage([]), null, "keine Zeilen -> null");
  assert.strictEqual(MC.freeCashflowLage(null), null, "fehlende Zeilen duerfen nicht werfen");
  assert.strictEqual(MC.freeCashflowLage([{ year: 2025, revenue: 1 }]), null,
    "nur unableitbare Zeilen -> null, keine leere Scheinauswertung");
  console.log("Block 9/10 (negativer Cashflow: Ausreisser von Dauerzustand getrennt, keine Rosinenpickerei): OK");
}

// ---------------------------------------------------------------------------
// 10. Startannahmen aus echten Bilanzzeilen
// ---------------------------------------------------------------------------
{
  // capex negativ (Yahoo-Konvention) -> FCF = 500 + (-200) = 300
  const rows = [
    { year: 2025, revenue: 1200, operatingCashflow: 500, capex: -200 },
    { year: 2024, revenue: 1000, operatingCashflow: 450, capex: -180 },
  ];
  const p = MC.suggestParams(rows);
  closeTo(p.fcf0, 300, 1e-9, "FCF = operativer Cashflow - |capex|");
  assert.strictEqual(p.fcfBasis, "ocf", "die Herkunft des Ausgangswerts muss mitgeliefert werden");
  assert.strictEqual(p.fcfGenau, true);
  assert.ok(p.fcfLabel && p.fcfLabel.length > 5, "fuer die Anzeige braucht es einen Klartext");
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
    "ohne Cashflow UND ohne capex darf keine Annahme erfunden werden");
  // Fehlt nur der operative Cashflow, greift jetzt die Rueckfallebene statt
  // die ganze Bewertung ausfallen zu lassen - genau der gemeldete Fall.
  const ersatz = MC.suggestParams([
    { year: 2025, revenue: 1200, operatingIncome: 800, depreciationAmortization: 300, capex: -200, taxExpense: 60, pretaxIncome: 300 },
    { year: 2024, revenue: 1000, operatingIncome: 700, depreciationAmortization: 280, capex: -180 },
  ]);
  assert.ok(ersatz, "ohne operativen Cashflow muss die Naeherung einspringen");
  assert.strictEqual(ersatz.fcfBasis, "fcff");
  assert.strictEqual(ersatz.fcfGenau, false, "die Naeherung muss als solche erkennbar bleiben");
  assert.strictEqual(MC.suggestParams([]), null, "leere Historie -> null");
  assert.strictEqual(MC.suggestParams(null), null, "fehlende Historie darf nicht werfen");

  // Nur ein Jahr: kein historisches Wachstum ableitbar -> Standardwert, kein Absturz.
  const einJahr = MC.suggestParams([{ year: 2025, revenue: 1200, operatingCashflow: 500, capex: -200 }]);
  assert.strictEqual(einJahr.histGrowth, null, "aus einem einzigen Jahr laesst sich kein Wachstum ableiten");
  closeTo(einJahr.growth.mode, 0.03, 1e-9, "dann greift der konservative Standardwert");
  console.log("Block 10/10 (Startannahmen: gedeckelt, vorzeichenrichtig, kein Erfinden bei Luecken): OK");
}

console.log("\nAlle mc.js-Tests erfolgreich.");
