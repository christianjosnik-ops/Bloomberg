// fundamentals.test.js — Tests fuer den Zeitreihen-Endpunkt (Yahoo
// fundamentals-timeseries). Ohne Test-Framework:  node test/fundamentals.test.js
//
// Anlass: Die Abschluesse kamen ueber quoteSummary (aeltere Schnittstelle) fuer
// viele Titel ohne Kapitalflussrechnung an. Damit fehlten operativer Cashflow
// und Investitionen - und ohne die stehen sowohl die FCF-Marge (F5 RATIO) als
// auch die Monte-Carlo-Bewertung (F7) ohne Zahlen da. Diese Tests sichern die
// Aufbereitung der neuen Quelle und das Zusammenfuehren beider.
//
// Die Antwortform stammt aus der oeffentlich beobachtbaren Struktur des
// Endpunkts; live pruefen laesst sie sich hier nicht (kein Netzzugriff).
// Deshalb wird durchgehend DEFENSIV geparst und genau das hier getestet:
// unerwartete Formen duerfen zu fehlenden Feldern fuehren, nie zum Absturz.

const assert = require("assert");
const F = require("../netlify/functions/lib/fundamentals.js");

// Baut einen Antwort-Eintrag fuer genau einen Typ ueber mehrere Jahre.
function reihe(typ, punkte) {
  const eintrag = { meta: { type: [typ] } };
  eintrag[typ] = punkte.map((p) => ({
    asOfDate: p.datum,
    periodType: p.periodType || "12M",
    reportedValue: p.wert == null ? null : { raw: p.wert },
  }));
  return eintrag;
}
function antwort(eintraege) { return { timeseries: { result: eintraege } }; }

// ---------------------------------------------------------------------------
// 1. URL: enthaelt Symbol, Typen und einen sinnvollen Zeitraum
// ---------------------------------------------------------------------------
{
  const jetzt = Date.UTC(2026, 7, 30);
  const u = F.timeseriesUrl("query1", "0700.HK", jetzt, 6);
  assert.ok(u.indexOf("query1.finance.yahoo.com") > -1, "Host muss eingesetzt werden");
  assert.ok(u.indexOf("0700.HK") > -1 || u.indexOf("0700.HK".replace(".", "%2E")) > -1, "Symbol muss vorkommen");
  assert.ok(u.indexOf("annualOperatingCashFlow") > -1, "der operative Cashflow ist der Anlass - er MUSS angefragt werden");
  assert.ok(u.indexOf("annualCapitalExpenditure") > -1, "Investitionen ebenso");
  assert.ok(u.indexOf("annualFreeCashFlow") > -1, "den fertigen freien Cashflow mitnehmen, wenn Yahoo ihn hat");

  const p1 = +/period1=(\d+)/.exec(u)[1];
  const p2 = +/period2=(\d+)/.exec(u)[1];
  assert.strictEqual(p2, Math.floor(jetzt / 1000), "period2 ist jetzt");
  const jahre = (p2 - p1) / (365 * 24 * 3600);
  assert.ok(jahre > 5.5 && jahre < 6.5, "der Zeitraum muss etwa sechs Jahre umfassen, gemessen: " + jahre.toFixed(2));

  // Ein zu enges Fenster wuerde beim Jahreswechsel stillschweigend eine Zeile
  // weniger liefern - ratios.js braucht fuer Durchschnitte immer das Vorjahr.
  const kurz = F.timeseriesUrl("query1", "AAPL", jetzt, 1);
  assert.ok(+/period1=(\d+)/.exec(kurz)[1] > p1, "der Zeitraum muss parametrisierbar sein");
  console.log("Block 1/6 (URL: Symbol, Cashflow-Typen, Zeitraum): OK");
}

// ---------------------------------------------------------------------------
// 2. Normalfall: mehrere Typen, mehrere Jahre -> Jahreszeilen absteigend
// ---------------------------------------------------------------------------
{
  const json = antwort([
    reihe("annualTotalRevenue", [{ datum: "2023-12-31", wert: 1000 }, { datum: "2024-12-31", wert: 1200 }]),
    reihe("annualOperatingCashFlow", [{ datum: "2023-12-31", wert: 300 }, { datum: "2024-12-31", wert: 360 }]),
    reihe("annualCapitalExpenditure", [{ datum: "2023-12-31", wert: -80 }, { datum: "2024-12-31", wert: -100 }]),
  ]);
  const rows = F.parseTimeseries(json);

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].year, 2024, "neuestes Jahr zuerst - ratios.js verlaesst sich darauf");
  assert.strictEqual(rows[1].year, 2023);
  assert.strictEqual(rows[0].revenue, 1200);
  assert.strictEqual(rows[0].operatingCashflow, 360, "genau das Feld, das vorher gefehlt hat");
  assert.strictEqual(rows[0].capex, -100);
  // Nicht gelieferte Felder muessen null sein, nicht undefined - sonst haetten
  // Zeilen je nach Quelle unterschiedliche Form.
  assert.strictEqual(rows[0].inventory, null, "fehlendes Feld -> null, nicht undefined");
  console.log("Block 2/6 (Normalfall: Jahreszeilen absteigend, Cashflow kommt an): OK");
}

// ---------------------------------------------------------------------------
// 3. TTM-Punkte duerfen NICHT unter die Geschaeftsjahre gemischt werden
// ---------------------------------------------------------------------------
{
  // Genau der Fehler, den normalizer.js ausdruecklich vermeidet: ein TTM-Wert
  // neben Jahreswerten wuerde eine Kennzahl erzeugen, die zwei verschiedene
  // Zeitraeume vermischt.
  const json = antwort([
    reihe("annualTotalRevenue", [
      { datum: "2024-12-31", wert: 1200 },
      { datum: "2025-06-30", wert: 1300, periodType: "TTM" },
    ]),
  ]);
  const rows = F.parseTimeseries(json);
  assert.strictEqual(rows.length, 1, "der TTM-Punkt darf keine eigene Jahreszeile erzeugen");
  assert.strictEqual(rows[0].year, 2024);
  assert.strictEqual(rows[0].revenue, 1200);
  console.log("Block 3/6 (TTM-Werte werden nicht unter die Geschaeftsjahre gemischt): OK");
}

// ---------------------------------------------------------------------------
// 4. Abgeleitete Felder und Vorrang bei mehreren Quellnamen
// ---------------------------------------------------------------------------
{
  const json = antwort([
    reihe("annualOperatingIncome", [{ datum: "2024-12-31", wert: 200 }]),
    reihe("annualEBIT", [{ datum: "2024-12-31", wert: 210 }]),
    reihe("annualDepreciationAndAmortization", [{ datum: "2024-12-31", wert: 50 }]),
    reihe("annualCurrentDebt", [{ datum: "2024-12-31", wert: 30 }]),
    reihe("annualLongTermDebt", [{ datum: "2024-12-31", wert: 120 }]),
  ]);
  const r = F.parseTimeseries(json)[0];
  assert.strictEqual(r.operatingIncome, 210, "EBIT steht in der Liste vor OperatingIncome und muss gewinnen");
  assert.strictEqual(r.ebitda, 260, "EBITDA = EBIT + Abschreibungen, wie in normalizer.js");
  assert.strictEqual(r.totalDebt, 150, "Gesamtschulden = kurz + langfristig");

  // Nur eine Schuldenart vorhanden -> trotzdem eine Summe, nicht null.
  const nurLang = F.parseTimeseries(antwort([
    reihe("annualLongTermDebt", [{ datum: "2024-12-31", wert: 120 }]),
  ]))[0];
  assert.strictEqual(nurLang.totalDebt, 120);
  // Gar keine Schuldenangabe -> null, keine 0 (0 hiesse "schuldenfrei").
  const keine = F.parseTimeseries(antwort([
    reihe("annualTotalRevenue", [{ datum: "2024-12-31", wert: 100 }]),
  ]))[0];
  assert.strictEqual(keine.totalDebt, null, "ohne Angabe null, nicht 0 - 0 hiesse schuldenfrei");
  console.log("Block 4/6 (abgeleitete Felder, Vorrang der genaueren Quellnamen): OK");
}

// ---------------------------------------------------------------------------
// 5. Kaputte und unerwartete Antworten
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(F.parseTimeseries(null), [], "keine Antwort -> leer, kein Absturz");
  assert.deepStrictEqual(F.parseTimeseries({}), []);
  assert.deepStrictEqual(F.parseTimeseries({ timeseries: {} }), []);
  assert.deepStrictEqual(F.parseTimeseries({ timeseries: { result: [] } }), []);
  assert.deepStrictEqual(F.parseTimeseries({ timeseries: { result: [null, 42, "x"] } }), [],
    "Muell im Ergebnis-Array darf nicht werfen");

  // Punkte ohne verwertbaren Wert erzeugen keine Zeile.
  assert.deepStrictEqual(
    F.parseTimeseries(antwort([reihe("annualTotalRevenue", [{ datum: "2024-12-31", wert: null }])])), [],
    "eine Zeile, die ausser dem Jahr nichts enthaelt, waere eine leere Spalte in der Anzeige");

  // Fehlendes asOfDate wird uebersprungen, der Rest bleibt erhalten.
  const gemischt = F.parseTimeseries(antwort([{
    meta: { type: ["annualTotalRevenue"] },
    annualTotalRevenue: [
      { periodType: "12M", reportedValue: { raw: 999 } },              // kein Datum
      { asOfDate: "2024-12-31", periodType: "12M", reportedValue: { raw: 1200 } },
    ],
  }]));
  assert.strictEqual(gemischt.length, 1, "der brauchbare Punkt muss trotzdem durchkommen");
  assert.strictEqual(gemischt[0].revenue, 1200);
  console.log("Block 5/6 (kaputte Antworten: leer statt Absturz, Brauchbares bleibt): OK");
}

// ---------------------------------------------------------------------------
// 6. Zusammenfuehren beider Quellen
// ---------------------------------------------------------------------------
{
  // Der reale Fall: die Zeitreihe bringt den Cashflow, quoteSummary die Bilanz.
  const zeitreihe = [{ year: 2024, operatingCashflow: 360, capex: -100, revenue: null, equity: null }];
  const quoteSummary = [{ year: 2024, revenue: 1200, equity: 800, operatingCashflow: null, capex: null }];

  const zusammen = F.mergeRows(zeitreihe, quoteSummary);
  assert.strictEqual(zusammen.length, 1, "dasselbe Jahr darf nicht doppelt erscheinen");
  assert.strictEqual(zusammen[0].operatingCashflow, 360, "der Cashflow kommt aus der Zeitreihe");
  assert.strictEqual(zusammen[0].revenue, 1200, "der Umsatz aus quoteSummary - beide Quellen tragen bei");
  assert.strictEqual(zusammen[0].equity, 800);

  // Vorrang: liefern beide dasselbe Feld, gewinnt die bevorzugte Quelle.
  const beide = F.mergeRows(
    [{ year: 2024, revenue: 1200 }],
    [{ year: 2024, revenue: 999 }]);
  assert.strictEqual(beide[0].revenue, 1200, "die bevorzugte Quelle gewinnt je Feld");

  // Jahre, die nur eine Quelle kennt, bleiben erhalten - absteigend sortiert.
  const jahre = F.mergeRows(
    [{ year: 2024, revenue: 1200 }],
    [{ year: 2023, revenue: 1000 }, { year: 2022, revenue: 900 }]);
  assert.deepStrictEqual(jahre.map((z) => z.year), [2024, 2023, 2022], "alle Jahre, neuestes zuerst");

  // Entartete Eingaben
  assert.deepStrictEqual(F.mergeRows([], []), []);
  assert.deepStrictEqual(F.mergeRows(null, null), []);
  const nurEine = F.mergeRows([{ year: 2024, revenue: 5 }], null);
  assert.strictEqual(nurEine[0].revenue, 5, "faellt eine Quelle aus, traegt die andere allein");

  // Die Eingaben duerfen nicht veraendert werden.
  const original = [{ year: 2024, revenue: 1200 }];
  F.mergeRows(original, [{ year: 2024, revenue: 999, equity: 1 }])[0].revenue = 0;
  assert.strictEqual(original[0].revenue, 1200, "die Eingabe darf nicht ueberschrieben werden");
  console.log("Block 6/6 (Zusammenfuehren: feldweise, Vorrang, alle Jahre, keine Mutation): OK");
}

console.log("\nAlle fundamentals.js-Tests erfolgreich.");
