// fred.test.js — Unit-Tests fuer die Makrodaten-Function (F4 MAKRO).
// Kein Test-Framework, nur Node + assert:  node fred.test.js
// Alle HTTP-Aufrufe hier sind gefakt - es geht um die Fallback-Kette und das
// Zeitbudget, nicht um echte FRED-/DBnomics-Antworten (dafuer fehlt in dieser
// Umgebung der Netzwerkzugriff).

const assert = require("assert");
const path = "/home/user/Bloomberg/netlify/functions/fred.js";
const providers = require("./netlify/functions/lib/providers.js");

function freshHandler() { delete require.cache[require.resolve(path)]; return require(path); }

(async function run() {
  // Der Circuit Breaker in providers.js ist modul-globaler Zustand und bleibt
  // ueber Testbloecke hinweg bestehen (freshHandler laedt nur fred.js neu, nicht
  // seine Abhaengigkeiten) - vor jedem Block zuruecksetzen, sonst faerbt ein
  // Fehlschlag-Block (z.B. "alle Provider haengen") auf einen spaeteren
  // Erfolgs-Block ab, weil der Breaker noch offen ist.
  providers._resetBreakers();
  // --- fromFredCsv: gueltiges CSV -> letzter Wert + Veraenderung zum Vortag ---
  {
    providers._resetBreakers();
    global.fetch = async (url, opts) => {
      assert.ok(String(url).includes("fredgraph.csv"), "muss den CSV-Endpunkt treffen");
      return { ok: true, status: 200, text: async () => "DATE,UNRATE\n2026-05-01,4.0\n2026-06-01,4.2\n" };
    };
    const { fromFredCsv } = freshHandler()._internal;
    const shaped = await fromFredCsv("UNRATE", 10, 3000);
    assert.strictEqual(shaped.latest, 4.2);
    assert.strictEqual(shaped.chg, 0.2);
    assert.strictEqual(shaped.latestDate, "2026-06-01");
    console.log("Block 1/13 (fromFredCsv: CSV korrekt geparst): OK");
  }

  // --- fromDbnomics: erster Kandidat 404, dritter (Query-Form) liefert das Ergebnis ---
  {
    providers._resetBreakers();
    let calls = 0;
    global.fetch = async (url) => {
      calls++;
      const u = String(url);
      // Die zweisegmentige Form darf gar nicht mehr vorkommen - genau die hat im
      // Livebetrieb HTTP 400 geliefert ("series_ids":["FRED/UNRATE"]).
      assert.ok(!/series_ids=FRED%2FUNRATE&|series_ids=FRED\/UNRATE&/.test(u),
        "die zweisegmentige series_ids-Form ist ungueltig und darf nicht mehr angefragt werden: " + u);
      if (u.includes("/v22/series/FRED/UNRATE/UNRATE")) return { ok: false, status: 404, json: async () => ({}) };
      if (u.includes("series_ids=FRED%2FUNRATE%2FUNRATE") || u.includes("series_ids=FRED/UNRATE/UNRATE")) return { ok: false, status: 404, json: async () => ({}) };
      if (u.includes("/v22/search")) {
        return { ok: true, status: 200, json: async () => ({ results: { docs: [{ period: ["2026-05", "2026-06"], value: [4.0, 4.2] }] } }) };
      }
      throw new Error("unerwartete URL: " + u);
    };
    const { fromDbnomics } = freshHandler()._internal;
    const shaped = await fromDbnomics("UNRATE", 10, Date.now() + 8000);
    assert.strictEqual(calls, 3, "muss alle drei Kandidaten-Formen durchprobieren, wenn die ersten beiden 404 liefern");
    assert.ok(shaped, "der Suchweg muss als letzte Kandidatenform ein Ergebnis liefern");
    assert.strictEqual(shaped.latest, 4.2);
    console.log("Block 2/13 (fromDbnomics: nur dreisegmentige Formen + Suchweg): OK");
  }

  // --- fetchOne: Zeitbudget schon vor dem Aufruf erschoepft -> kein Netzwerkzugriff ---
  {
    providers._resetBreakers();
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; throw new Error("haette nicht aufgerufen werden duerfen"); };
    const { fetchOne } = freshHandler()._internal;
    const deadline = Date.now() - 100; // bereits abgelaufen
    const result = await fetchOne("UNRATE", null, deadline);
    assert.ok(result.error, "muss einen Fehler statt Daten liefern");
    assert.ok(!fetchCalled, "darf bei bereits abgelaufenem Budget gar nicht erst netzwerken");
    console.log("Block 3/13 (fetchOne: erschoepftes Budget -> kein Netzwerkzugriff): OK");
  }

  // --- fetchOne: Provider-Timeouts werden auf die RESTZEIT gekappt, nicht die vollen Standardwerte ---
  {
    providers._resetBreakers();
    global.fetch = async (url, opts) => new Promise((_, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const { fetchOne } = freshHandler()._internal;
    const deadline = Date.now() + 900; // deutlich unter FRED_CSV_TIMEOUT (3000) und DBNOMICS_TIMEOUT (2500)
    const t0 = Date.now();
    const result = await fetchOne("CPIAUCSL", null, deadline);
    const dt = Date.now() - t0;
    console.log("  Dauer bei haengenden Providern und 0.9s Restbudget:", (dt / 1000).toFixed(2) + "s");
    assert.ok(dt < 1400, "Provider-Timeouts muessen auf die Restzeit gekappt werden, nicht auf die vollen 3s/2.5s-Standardwerte laufen");
    assert.ok(result.error, "muss trotzdem einen Fehler statt eines Haengers liefern");
    console.log("Block 4/13 (fetchOne: Provider-Timeouts an Restbudget gekappt): OK");
  }

  // --- Handler: mehrere Serien/Wellen, alle Provider haengen -> Gesamtlaufzeit bleibt unter Netlifys Limit ---
  {
    providers._resetBreakers();
    global.fetch = async (url, opts) => new Promise((_, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const fred = freshHandler();
    const t0 = Date.now();
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE,CPIAUCSL,FEDFUNDS,DGS10,T10Y2Y,GDP,PAYEMS,UMCSENT,MORTGAGE30US,M2SL" } });
    const dt = Date.now() - t0;
    console.log("  Dauer bei 10 Serien (4 Wellen) mit durchgehend haengenden Providern:", (dt / 1000).toFixed(1) + "s (muss klar unter Netlifys 10s-Limit bleiben)");
    assert.ok(dt < 10000, "Gesamtlaufzeit ueber alle Wellen hinweg muss unter dem Netlify-Funktionslimit bleiben");
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const errors = Object.values(body).map((v) => v && v.error).filter(Boolean);
    assert.strictEqual(errors.length, 10, "alle 10 Serien muessen einen Fehler statt haengender Requests liefern");
    console.log("Block 5/13 (Handler: Zeitbudget schuetzt ueber alle Wellen hinweg): OK");
  }

  // --- Handler: Batch-Cache-Treffer braucht kein Netzwerk ---
  {
    providers._resetBreakers();
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, status: 200, text: async () => "DATE,UNRATE\n2026-05-01,4.0\n2026-06-01,4.2\n" }; };
    const fred = freshHandler();
    const first = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE" } });
    assert.strictEqual(JSON.parse(first.body).UNRATE.latest, 4.2);
    const callsAfterFirst = calls;
    const second = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE" } });
    assert.strictEqual(calls, callsAfterFirst, "zweiter Aufruf innerhalb der TTL darf nicht erneut netzwerken");
    assert.strictEqual(JSON.parse(second.body).UNRATE.latest, 4.2);
    console.log("Block 6/13 (Handler: Cache verhindert erneuten Netzwerkzugriff): OK");
  }

  // --- FRED antwortet mit HTML MIT Status 200 (Bot-Sperre) -> muss als solche benannt werden ---
  {
    providers._resetBreakers();
    global.fetch = async () => ({
      ok: true, status: 200,
      text: async () => "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>",
    });
    const { fromFredCsv } = freshHandler()._internal;
    let msg = null;
    try { await fromFredCsv("UNRATE", 10, 3000); } catch (e) { msg = e.message; }
    assert.ok(msg && /HTML statt CSV/.test(msg), "eine Sperrseite mit Status 200 darf nicht als 'leeres Ergebnis' durchrutschen, sondern muss benannt werden");
    assert.ok(/Just a moment/.test(msg), "der Auszug der Sperrseite gehoert in die Meldung");
    console.log("Block 7/13 (FRED: HTML-Sperrseite trotz Status 200 wird erkannt): OK");
  }

  // --- FRED 4xx: der Antwortkoerper ist die eigentliche Begruendung ---
  {
    providers._resetBreakers();
    global.fetch = async () => ({ ok: false, status: 403, text: async () => "Access denied for automated clients" });
    const { fromFredCsv } = freshHandler()._internal;
    let msg = null;
    try { await fromFredCsv("UNRATE", 10, 3000); } catch (e) { msg = e.message; }
    assert.ok(/403/.test(msg) && /Access denied/.test(msg), "Status UND Begruendung muessen in der Meldung stehen");
    console.log("Block 8/13 (FRED: Fehlertext des Servers bleibt erhalten): OK");
  }

  // --- CSV mit \r\n und fehlenden Werten (".") wird korrekt geparst ---
  {
    providers._resetBreakers();
    global.fetch = async () => ({
      ok: true, status: 200,
      text: async () => "DATE,UNRATE\r\n2026-04-01,.\r\n2026-05-01,4.0\r\n2026-06-01,4.2\r\n",
    });
    const { fromFredCsv } = freshHandler()._internal;
    const shaped = await fromFredCsv("UNRATE", 10, 3000);
    assert.strictEqual(shaped.series.length, 2, "die Zeile mit fehlendem Wert (.) muss uebersprungen werden");
    assert.strictEqual(shaped.latest, 4.2, "Windows-Zeilenenden duerfen den letzten Wert nicht verfaelschen");
    assert.strictEqual(shaped.chg, 0.2);
    console.log("Block 9/13 (FRED: CRLF-Zeilenenden und fehlende Werte): OK");
  }

  // --- Sammelabruf: mehrspaltiges CSV, fehlende Werte je Spalte ueberspringen ---
  {
    providers._resetBreakers();
    let urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      return {
        ok: true, status: 200,
        // Drei Serien unterschiedlicher Frequenz auf gemeinsamem Datumsraster:
        // "." markiert die Datumszeilen, an denen eine Serie keinen Wert hat.
        text: async () => [
          "DATE,UNRATE,GDP,DGS10",
          "2026-01-01,4.0,.,4.10",
          "2026-02-01,4.1,.,4.20",
          "2026-03-01,4.2,29000.5,4.30",
        ].join("\n"),
      };
    };
    const { fromFredCsvBatch } = freshHandler()._internal;
    const out = await fromFredCsvBatch(["UNRATE", "GDP", "DGS10"], 6000);
    assert.strictEqual(urls.length, 1, "der Sammelabruf muss EINE Anfrage sein, nicht eine pro Serie");
    assert.ok(/id=UNRATE%2CGDP%2CDGS10|id=UNRATE,GDP,DGS10/.test(urls[0]), "alle IDs muessen in einer URL stehen: " + urls[0]);
    assert.strictEqual(out.UNRATE.latest, 4.2);
    assert.strictEqual(out.UNRATE.series.length, 3);
    assert.strictEqual(out.GDP.latest, 29000.5);
    assert.strictEqual(out.GDP.series.length, 1, "fuer GDP darf nur die eine Zeile mit echtem Wert zaehlen, nicht die Punkte");
    assert.strictEqual(out.DGS10.latest, 4.3);
    console.log("Block 10/13 (Sammelabruf: eine Anfrage, Spalten sauber getrennt): OK");
  }

  // --- Sammelabruf: Spaltenreihenfolge wird aus der Kopfzeile gelesen, nicht angenommen ---
  {
    providers._resetBreakers();
    global.fetch = async () => ({
      ok: true, status: 200,
      // Absichtlich ANDERE Reihenfolge als angefragt
      text: async () => "DATE,GDP,UNRATE\n2026-01-01,29000.5,4.0\n2026-02-01,29100.0,4.1\n",
    });
    const { fromFredCsvBatch } = freshHandler()._internal;
    const out = await fromFredCsvBatch(["UNRATE", "GDP"], 6000);
    assert.strictEqual(out.UNRATE.latest, 4.1, "die Zuordnung muss ueber die Kopfzeile laufen, nicht ueber die Anfragereihenfolge");
    assert.strictEqual(out.GDP.latest, 29100);
    console.log("Block 11/13 (Sammelabruf: Zuordnung ueber die Kopfzeile): OK");
  }

  // --- Handler: EIN Sammelabruf deckt alle zehn Serien ab ---
  {
    providers._resetBreakers();
    let calls = 0;
    global.fetch = async () => {
      calls++;
      const ids = ["UNRATE", "CPIAUCSL", "FEDFUNDS", "DGS10", "T10Y2Y", "GDP", "PAYEMS", "UMCSENT", "MORTGAGE30US", "M2SL"];
      const rows = ["DATE," + ids.join(",")];
      for (let d = 1; d <= 3; d++) rows.push(`2026-0${d}-01,` + ids.map((_, k) => (d + k).toFixed(1)).join(","));
      return { ok: true, status: 200, text: async () => rows.join("\n") };
    };
    const fred = freshHandler();
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE,CPIAUCSL,FEDFUNDS,DGS10,T10Y2Y,GDP,PAYEMS,UMCSENT,MORTGAGE30US,M2SL" } });
    assert.strictEqual(calls, 1, "zehn Serien duerfen nur EINEN Netzwerkabruf kosten - genau das war vorher die Timeout-Ursache");
    const body = JSON.parse(res.body);
    assert.strictEqual(Object.keys(body).length, 10);
    assert.ok(Object.values(body).every((v) => v && !v.error && v.latest != null), "alle zehn Serien muessen Daten haben");
    assert.strictEqual(body.UNRATE.source, "fred");
    console.log("Block 12/13 (Handler: zehn Serien mit einem einzigen Abruf): OK");
  }

  // --- Handler: scheitert der Sammelabruf, wird der Grund sichtbar mitgeliefert ---
  {
    providers._resetBreakers();
    global.fetch = async (url, opts) => {
      if (String(url).includes("fredgraph.csv")) {
        return { ok: false, status: 403, text: async () => "Access denied for automated clients" };
      }
      return new Promise((_, reject) => { if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
    };
    const fred = freshHandler();
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE,CPIAUCSL" } });
    const body = JSON.parse(res.body);
    const texte = Object.values(body).map((v) => v.error || "").join(" ");
    assert.ok(/Sammelabruf/.test(texte), "der Grund des Sammel-Fehlschlags muss in der Meldung auftauchen, nicht nur der Einzelfehler");
    assert.ok(/403|Access denied/.test(texte), "Statuscode bzw. Servertext des Sammelabrufs muessen erhalten bleiben");
    console.log("Block 13/13 (Handler: Grund des Sammel-Fehlschlags bleibt sichtbar): OK");
  }

  console.log("\nAlle fred.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
