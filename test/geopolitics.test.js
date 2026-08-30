// geopolitics.test.js — Unit-Tests fuer die Weltlage-Function.
// Kein Test-Framework, nur Node + assert:  node test/geopolitics.test.js
// Alle HTTP-Aufrufe hier sind gefakt - es geht um die Aggregations-, Level-
// und Budget-Logik, nicht um echte UCDP-Antworten.
//
// Architektur: UCDP ist die einzige dynamische Quelle fuer die Laenderliste,
// UCDP ist die EINZIGE Quelle. Jeder Test muss sie mocken - jede andere
// Adresse laesst buildReport auf "unerwartete URL" werfen, und genau das ist
// gewollt: So faellt sofort auf, wenn wieder eine Quelle dazukommt, die nicht
// hierher gehoert.
//
// Frueher liefen hier zwei weitere Quellen. ReliefWeb wurde entfernt, weil es
// einen vorab genehmigten Appnamen verlangt (HTTP 403). GDELT wurde entfernt,
// weil es weder vom Netlify-Server noch aus dem Browser des Nutzers erreichbar
// war ("kein Kontakt · 6001ms") und deshalb nur noch "0 Meldungen" in jeder
// Laenderzeile stehen liess.

const assert = require("assert");
const path = require.resolve("../netlify/functions/geopolitics.js");

// Sauberer Ausgangszustand je Block. UCDP braucht seit der Token-Pflicht
// (Live-Beleg: HTTP 401 "API token required") einen Zugangstoken, sonst wird
// es gar nicht erst angefragt - fuer die meisten Bloecke soll es aber aktiv
// sein, deshalb wird hier ein Testtoken gesetzt. Bloecke, die das Verhalten
// OHNE Token pruefen, loeschen ihn ausdruecklich.
function freshHandler() {
  delete require.cache[require.resolve(path)];
  process.env.UCDP_ACCESS_TOKEN = "test-token";
  return require(path);
}

// Baut eine plausible UCDP-Antwort. Envelope per Parameter variierbar, damit
// findUcdpEvents() gegen mehrere Umschlagformen geprueft werden kann.
function ucdpBody(events, envelope) {
  const arr = events;
  if (envelope === "Result") return { Result: arr };
  if (envelope === "result") return { result: arr };
  if (envelope === "nested") return { data: { rows: arr } };
  return arr; // direktes Array
}

(async function run() {
  // --- computeLevel(): Stufenlogik isoliert pruefen ---
  //
  // Seit dem Wegfall von GDELT ist die Stufe zweiwertig: UCDP fuehrt einen
  // Konflikt oder nicht. Der dritte Zustand "unbekannt" ist der wichtigste -
  // er darf NIE mit "keine" verwechselt werden. "keine" heisst geprueft und
  // ruhig, "unbekannt" heisst gar nicht geprueft. Wer das vermischt, zeigt
  // fehlende Daten als Entwarnung an.
  {
    const { computeLevel } = freshHandler()._internal;
    assert.strictEqual(computeLevel(true, true), "hoch", "UCDP fuehrt ein Ereignis");
    assert.strictEqual(computeLevel(false, true), "keine", "geprueft, kein Ereignis");
    assert.strictEqual(computeLevel(false, false), "unbekannt", "ohne Quelle gibt es KEINE Entwarnung");
    assert.strictEqual(computeLevel(true, false), "unbekannt",
      "ohne Quelle zaehlt auch ein mitgeschlepptes Flag nicht - es kann nicht aktuell sein");
    assert.notStrictEqual(computeLevel(false, false), "keine",
      "der Unterschied zwischen 'nicht geprueft' und 'geprueft und ruhig' ist der Kern dieser Anzeige");
    console.log("Block 1/11 (Stufenlogik: unbekannt ist nicht keine): OK");
  }

  // --- UCDP liefert Laender -> Einstufung, feste Liste wird aufgefuellt ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        return { ok: true, status: 200, json: async () => ucdpBody([
          { country: "Sudan", date_start: "2026-08-01", type_of_violence: 1 },
          { country: "Palestine", date_start: "2026-08-05", type_of_violence: 2 },
        ]) };
      }
      // Seit dem Wegfall von GDELT darf die Function NUR noch UCDP anfragen.
      // Jede andere Adresse ist ein Rueckfall in einen entfernten Codepfad.
      throw new Error("unerwartete URL: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(report.ucdpError, null);
    assert.strictEqual(report.hatQuelle, true, "mit funktionierendem UCDP gibt es eine Quelle");
    assert.ok(report.countries.SDN, "Sudan muss in der Watchlist sein (aus UCDP)");
    assert.strictEqual(report.countries.SDN.level, "hoch", "UCDP fuehrt ein Ereignis");
    assert.strictEqual(report.countries.SDN.ucdpActive, true);
    assert.ok(report.countries.PSE, "Palestine muss in der Watchlist sein");
    assert.strictEqual(report.countries.PSE.level, "hoch");
    assert.ok(report.countries.RUS, "feste Watchlist muss aufgefuellt sein");
    assert.strictEqual(report.countries.RUS.level, "keine", "geprueft, kein Ereignis");
    assert.strictEqual(report.countries.RUS.ucdpActive, false);

    // Die GDELT-Felder muessen restlos verschwunden sein - ein zurueckgebliebenes
    // gdeltCount: 0 saehe in der Oberflaeche wieder wie "0 Meldungen" aus.
    const felder = Object.keys(report.countries.SDN);
    ["gdeltCount", "headlines", "gdeltTrend", "error"].forEach((f) => {
      assert.ok(felder.indexOf(f) === -1, `Feld ${f} darf nicht mehr geliefert werden`);
    });
    console.log("Block 2/11 (UCDP-Normalfall, nur noch UCDP wird angefragt): OK");
  }

  // --- UCDP faellt komplett aus -> trotzdem Bericht mit fester Watchlist ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) throw new Error("UCDP nicht erreichbar");
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(report.ucdpError, "UCDP-Fehler muss im Bericht sichtbar sein");
    assert.ok(/UCDP nicht erreichbar/.test(report.ucdpError));
    assert.strictEqual(report.hatQuelle, false, "ohne UCDP gibt es keine Quelle mehr");
    assert.ok(report.countries.RUS, "feste Watchlist funktioniert weiter ohne UCDP");
    // ENTSCHEIDEND: ohne Quelle ist jedes Land "unbekannt", nicht "keine".
    // Eine leere Weltlage als Entwarnung anzuzeigen waere schlimmer als gar
    // keine Anzeige.
    assert.strictEqual(report.countries.RUS.level, "unbekannt",
      "ohne Konfliktquelle darf kein Land als 'keine Gefahr' erscheinen");
    assert.ok(Object.values(report.countries).every((c) => c.level === "unbekannt"),
      "das gilt fuer ALLE Laender, nicht nur eines");
    // Gegen die Liste selbst pruefen, nicht gegen eine abgeschriebene Zahl:
    // die feste Watchlist ist gewachsen, seit sie ohne UCDP-Token die einzige
    // Quelle der Laenderauswahl ist.
    const { FIXED_WATCHLIST } = require("../netlify/functions/lib/geo-countries.js");
    assert.strictEqual(Object.keys(report.countries).length, FIXED_WATCHLIST.length,
      "genau die feste Watchlist, keine dynamischen dazu");
    console.log("Block 3/11 (UCDP-Ausfall, feste Liste als Basis): OK");
  }


  // --- UCDP: die neuesten Monatsversionen gibt es noch nicht (404) -> es wird
  //     rueckwaerts gelaufen, bis eine existiert. Genau das war der Kernfehler:
  //     die frueher hartkodierte Version "24.01.24" hat nie existiert. ---
  {
    let ge404 = 0, treffer = null;
    const jetzt = new Date();
    // Die drittneueste Version ist die erste, die "existiert".
    const dritte = (() => {
      const d = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), 1));
      d.setUTCMonth(d.getUTCMonth() - 2);
      return `${d.getUTCFullYear() % 100}.0.${d.getUTCMonth() + 1}`;
    })();
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        if (u.includes(`/${dritte}?`)) { treffer = u; return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Mali", date_start: "2026-07-01" }]) }; }
        ge404++;
        return { ok: false, status: 404, text: async () => "not found" };
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(ge404 >= 2, "die noch nicht veroeffentlichten neueren Versionen muessen tatsaechlich probiert worden sein");
    assert.ok(treffer, "die erste existierende Version muss gefunden werden");
    assert.strictEqual(report.ucdpError, null, "wird eine existierende Version gefunden, darf kein Fehler im Bericht stehen");
    assert.ok(report.countries.MLI && report.countries.MLI.ucdpActive, "deren Daten muessen ankommen");
    console.log("Block 4/11 (UCDP: laeuft ueber 404er rueckwaerts bis zur existierenden Monatsversion): OK");
  }


  // --- UCDP: unbekannte Laendernamen werden uebersprungen, nicht abgestuerzt ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([
        { country: "Sudan", date_start: "2026-08-01" },
        { country: "Nirgendland", date_start: "2026-08-01" }, // kein Alias bekannt
        { country: null, date_start: "2026-08-01" },
      ]) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(report.ucdpError, null, "unbekannte/fehlende Laendernamen duerfen die gesamte UCDP-Verarbeitung nicht zum Scheitern bringen");
    assert.ok(report.countries.SDN && report.countries.SDN.ucdpActive, "das bekannte Land muss trotzdem verarbeitet werden");
    console.log("Block 5/11 (UCDP: unbekannte Laendernamen werden uebersprungen): OK");
  }

  // --- UCDP: Ereignis-Array wird unabhaengig vom Antwort-Umschlag gefunden ---
  {
    for (const envelope of ["Result", "result", "nested", undefined]) {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Syria", date_start: "2026-08-01" }], envelope) };
        throw new Error("unerwartet: " + u);
      };
      const { buildReport } = freshHandler()._internal;
      const report = await buildReport();
      assert.ok(report.countries.SYR && report.countries.SYR.ucdpActive, `Umschlag "${envelope}" muss erkannt werden`);
    }
    console.log("Block 6/11 (UCDP: Ereignis-Array wird umschlagunabhaengig gefunden): OK");
  }







  // --- UCDP: ein haengender Host darf NICHT die ganze Versionsliste durchlaufen.
  //     Das ist die gefaehrlichste Fehlermoeglichkeit der neuen Suche: 15
  //     Versionen x 2.5s Timeout waeren 37s - ein Vielfaches des Funktionslimits,
  //     Nach dem ersten Timeout muss Schluss sein. ---
  {
    let ucdpVersuche = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        ucdpVersuche++;
        return new Promise((_, reject) => { if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const t0 = Date.now();
    const report = await buildReport();
    const dt = Date.now() - t0;
    console.log("  Dauer bei haengendem UCDP-Host:", (dt / 1000).toFixed(1) + "s, UCDP-Versuche:", ucdpVersuche);
    assert.strictEqual(ucdpVersuche, 1, "nach einem Timeout ist der Host nicht erreichbar - weitere Versionen zu probieren kostet nur weitere Timeouts");
    assert.ok(dt < 10000, "die Gesamtlaufzeit muss trotz haengendem UCDP unter dem Funktionslimit bleiben");
    assert.ok(report.ucdpError, "der UCDP-Fehler muss sichtbar bleiben");
    assert.ok(report.countries.RUS, "die feste Watchlist muss trotzdem durchlaufen");
    console.log("Block 7/11 (UCDP: Timeout beendet die Versionssuche sofort, statt sie durchzulaufen): OK");
  }

  // --- UCDP: eine langsame, aber antwortende Gegenstelle darf das Teilbudget
  //     nicht ueberschreiten - sonst frisst allein die Versionssuche die Zeit,
  //     Teilbudget einhalten. ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        await new Promise((r) => setTimeout(r, 600)); // langsam, aber kein Timeout
        return { ok: false, status: 404, text: async () => "not found" };
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport, UCDP_BUDGET_MS } = freshHandler()._internal;
    const t0 = Date.now();
    const report = await buildReport();
    const dt = Date.now() - t0;
    console.log("  Dauer bei langsamem UCDP (600ms je 404):", (dt / 1000).toFixed(1) + "s, Teilbudget:", UCDP_BUDGET_MS + "ms");
    assert.ok(dt < 10000, "Gesamtlaufzeit muss unter dem Funktionslimit bleiben");
    assert.ok(/Zeitbudget/.test(report.ucdpError), "die abgebrochene Versionssuche muss als Zeitbudget-Abbruch gemeldet werden, nicht als stiller Fehlschlag");
    assert.ok(report.countries.RUS, "der Bericht muss trotzdem fertig werden");
    console.log("Block 8/11 (UCDP: Versionssuche respektiert ihr eigenes Teilbudget): OK");
  }

  // --- UCDP: die gefundene Version wird gemerkt. Ohne das bezahlt JEDER
  //     Aufruf die 404-Kaskade erneut - bei 20 Minuten Cache-Laufzeit und
  //     kurzlebigen Instanzen waere das viel verschenkte Zeit. ---
  {
    const jetzt = new Date();
    const vormonat = (() => {
      const d = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), 1));
      d.setUTCMonth(d.getUTCMonth() - 1);
      return `${d.getUTCFullYear() % 100}.0.${d.getUTCMonth() + 1}`;
    })();
    let ucdpAufrufe = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        ucdpAufrufe.push(u);
        if (u.includes(`/${vormonat}?`)) return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Sudan", date_start: "2026-08-01" }]) };
        return { ok: false, status: 404, text: async () => "not found" };
      }
      throw new Error("unerwartet: " + u);
    };
    const mod = freshHandler();
    const { fetchUcdp } = mod._internal;
    await fetchUcdp(Date.now() + 5000);
    const ersterLauf = ucdpAufrufe.length;
    assert.ok(ersterLauf >= 2, "der erste Lauf muss die 404er durchlaufen, um die gueltige Version zu finden");

    ucdpAufrufe = [];
    await fetchUcdp(Date.now() + 5000);
    assert.strictEqual(ucdpAufrufe.length, 1, "der zweite Lauf muss die gemerkte Version sofort treffen, statt erneut alle 404er abzuklappern");
    assert.ok(ucdpAufrufe[0].includes(`/${vormonat}?`), "und zwar genau die zuvor erfolgreiche");
    console.log("Block 9/11 (UCDP: erfolgreiche Version wird gemerkt, zweiter Lauf spart die 404-Kaskade): OK");
  }



  // --- UCDP-Token-Pflicht (Live-Beleg: HTTP 401 "API token required. Add
  //     header: x-ucdp-access-token"). Ohne Token darf UCDP GAR NICHT
  //     angefragt werden: jeder Versuch waere ein garantierter 401 und wuerde
  //     nur Zeit kosten und nichts liefern. ---
  {
    let ucdpAngefragt = false;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) { ucdpAngefragt = true; return { ok: false, status: 401, text: async () => "API token required" }; }
      throw new Error("unerwartet: " + u);
    };
    delete require.cache[require.resolve(path)];
      delete process.env.UCDP_ACCESS_TOKEN; // ausdruecklich OHNE Token
    const { buildReport } = require(path)._internal;
    const report = await buildReport();
    process.env.UCDP_ACCESS_TOKEN = "test-token";

    assert.strictEqual(ucdpAngefragt, false,
      "ohne Zugangstoken darf UCDP nicht angefragt werden - ein garantierter 401 kostet nur Budget");
    assert.ok(/UCDP_ACCESS_TOKEN/.test(report.ucdpError), "die Meldung muss die noetige Umgebungsvariable benennen");
    assert.ok(/mertcan\.yilmaz@pcr\.uu\.se/.test(report.ucdpError),
      "und den Weg zum kostenlosen Token nennen - sonst weiss niemand, wie er die Quelle wieder aktiviert");
    assert.ok(Object.keys(report.countries).length >= 14,
      "die Laenderauswahl muss ohne UCDP weiterhin stehen - sie kommt dann komplett aus der festen Liste");
    console.log("Block 10/11 (ohne UCDP-Token wird gar nicht erst angefragt, Meldung nennt den Weg zum Token): OK");
  }

  // --- Mit Token: der Header MUSS gesetzt werden, sonst antwortet die API 401 ---
  {
    const gesehen = [];
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        gesehen.push((opts && opts.headers) || {});
        return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Sudan", date_start: "2026-08-01" }]) };
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    await buildReport();
    assert.ok(gesehen.length > 0, "mit Token muss UCDP angefragt werden");
    assert.strictEqual(gesehen[0]["x-ucdp-access-token"], "test-token",
      "der Token muss im Header x-ucdp-access-token stehen - genau so verlangt es die API laut ihrer 401-Meldung");
    console.log("Block 11/11 (mit Token wird der Header x-ucdp-access-token gesetzt): OK");
  }

  console.log("\nAlle geopolitics.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
