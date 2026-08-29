// geopolitics.test.js — Unit-Tests fuer die Weltlage-Function.
// Kein Test-Framework, nur Node + assert:  node test/geopolitics.test.js
// Alle HTTP-Aufrufe hier sind gefakt - es geht um die Aggregations-, Level-
// und Zeitbudget-Logik, nicht um echte GDELT-/UCDP-Antworten.
//
// Architektur: UCDP ist die einzige dynamische Quelle fuer die Laenderliste,
// GDELT liefert das Nachrichtenvolumen je Land. Jeder Test muss darum UCDP
// mocken - sonst wirft buildReport auf eine unerwartete URL.
// (ReliefWeb war frueher eine dritte Quelle und wurde entfernt, nachdem sich
// die Appname-Registrierungspflicht als dauerhafte Sperre erwiesen hat.)

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
  {
    const { computeLevel } = freshHandler()._internal;
    assert.strictEqual(computeLevel(0, false), "keine");
    assert.strictEqual(computeLevel(1, false), "niedrig");
    assert.strictEqual(computeLevel(2, false), "mittel");
    assert.strictEqual(computeLevel(4, false), "mittel");
    assert.strictEqual(computeLevel(5, false), "hoch", "5+ Artikel allein reicht fuer hoch");
    assert.strictEqual(computeLevel(0, true), "hoch", "aktive offizielle Quelle allein reicht fuer hoch");
    assert.strictEqual(computeLevel(5, true), "kritisch", "beide Signale zusammen -> kritisch");
    console.log("Block 1/18 (Stufenlogik): OK");
  }

  // --- UCDP liefert Laender, GDELT antwortet fuer alle -> kombinierte Stufe ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        return { ok: true, status: 200, json: async () => ucdpBody([
          { country: "Sudan", date_start: "2026-08-01", type_of_violence: 1 },
          { country: "Palestine", date_start: "2026-08-05", type_of_violence: 2 },
        ]) };
      }
      if (u.includes("gdeltproject.org")) {
        const many = u.includes("Sudan");
        const articles = many ? Array.from({ length: 6 }, (_, i) => ({ title: "Sudan clash report " + i, url: "https://x/" + i, seendate: "20260807T000000Z", domain: "reuters.com" })) : [];
        return { ok: true, status: 200, json: async () => ({ articles }) };
      }
      throw new Error("unerwartete URL: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(report.ucdpError, null);
    assert.ok(report.countries.SDN, "Sudan muss in der Watchlist sein (aus UCDP)");
    assert.strictEqual(report.countries.SDN.level, "kritisch", "UCDP aktiv + 6 GDELT-Artikel -> kritisch");
    assert.strictEqual(report.countries.SDN.ucdpActive, true);
    assert.ok(report.countries.PSE, "Palestine muss in der Watchlist sein");
    assert.strictEqual(report.countries.PSE.level, "hoch", "UCDP aktiv, aber 0 GDELT-Treffer -> hoch (nicht kritisch)");
    assert.ok(report.countries.RUS, "feste Watchlist muss aufgefuellt sein");
    assert.strictEqual(report.countries.RUS.level, "keine");
    assert.strictEqual(report.countries.RUS.ucdpActive, false);
    console.log("Block 2/18 (UCDP-Normalfall, kombinierte Signale): OK");
  }

  // --- UCDP faellt komplett aus -> trotzdem Bericht mit fester Watchlist ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) throw new Error("UCDP nicht erreichbar");
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(report.ucdpError, "UCDP-Fehler muss im Bericht sichtbar sein");
    assert.ok(/UCDP nicht erreichbar/.test(report.ucdpError));
    assert.ok(report.countries.RUS, "feste Watchlist funktioniert weiter ohne UCDP");
    // Gegen die Liste selbst pruefen, nicht gegen eine abgeschriebene Zahl:
    // die feste Watchlist ist gewachsen, seit sie ohne UCDP-Token die einzige
    // Quelle der Laenderauswahl ist.
    const { FIXED_WATCHLIST } = require("../netlify/functions/lib/geo-countries.js");
    assert.strictEqual(Object.keys(report.countries).length, FIXED_WATCHLIST.length,
      "genau die feste Watchlist, keine dynamischen dazu");
    console.log("Block 3/18 (UCDP-Ausfall, feste Liste als Basis): OK");
  }

  // --- Zeitbudget: haengende GDELT-Aufrufe duerfen den Bericht nicht blockieren ---
  {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([]) };
      if (u.includes("gdeltproject.org")) {
        return new Promise((_, reject) => { if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const t0 = Date.now();
    const report = await buildReport();
    const dt = Date.now() - t0;
    console.log("  Dauer bei durchgehend haengendem GDELT:", (dt / 1000).toFixed(1) + "s (muss klar unter Netlifys 10s-Limit bleiben)");
    assert.ok(dt < 10000, "Gesamtlaufzeit muss unter dem Netlify-Funktionslimit bleiben, auch wenn alles haengt");
    const levels = Object.values(report.countries).map((c) => c.level);
    assert.ok(levels.some((l) => l === "nicht geprüft"), "mindestens ein Land muss als 'nicht geprüft' markiert sein, nicht faelschlich als 'keine'");
    console.log("Block 4/18 (Zeitbudget schuetzt vor Timeout-Sturm): OK");
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
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(ge404 >= 2, "die noch nicht veroeffentlichten neueren Versionen muessen tatsaechlich probiert worden sein");
    assert.ok(treffer, "die erste existierende Version muss gefunden werden");
    assert.strictEqual(report.ucdpError, null, "wird eine existierende Version gefunden, darf kein Fehler im Bericht stehen");
    assert.ok(report.countries.MLI && report.countries.MLI.ucdpActive, "deren Daten muessen ankommen");
    console.log("Block 5/18 (UCDP: laeuft ueber 404er rueckwaerts bis zur existierenden Monatsversion): OK");
  }

  // --- Zeitbudget gilt AB FUNKTIONSSTART, nicht erst nach UCDP ---
  {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("candidateevents")) {
        await new Promise((r) => setTimeout(r, 1500));
        return { ok: true, status: 200, json: async () => ucdpBody([]) };
      }
      if (u.includes("gdeltproject.org")) {
        return new Promise((_, reject) => { if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const t0 = Date.now();
    const report = await buildReport();
    const dt = Date.now() - t0;
    console.log("  Dauer bei langsamem UCDP (1.5s) + haengendem GDELT:", (dt / 1000).toFixed(1) + "s");
    assert.ok(dt < 10000, "UCDP-Zeit + GDELT-Wellen zusammen muessen unter Netlifys Funktionslimit bleiben");
    const levels = Object.values(report.countries).map((c) => c.level);
    assert.ok(levels.some((l) => l === "nicht geprüft"), "Budget muss trotz vorgelagerter UCDP-Zeit greifen");
    console.log("Block 6/18 (Zeitbudget ab Funktionsstart, deckt UCDP + GDELT zusammen ab): OK");
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
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(report.ucdpError, null, "unbekannte/fehlende Laendernamen duerfen die gesamte UCDP-Verarbeitung nicht zum Scheitern bringen");
    assert.ok(report.countries.SDN && report.countries.SDN.ucdpActive, "das bekannte Land muss trotzdem verarbeitet werden");
    console.log("Block 7/18 (UCDP: unbekannte Laendernamen werden uebersprungen): OK");
  }

  // --- UCDP: Ereignis-Array wird unabhaengig vom Antwort-Umschlag gefunden ---
  {
    for (const envelope of ["Result", "result", "nested", undefined]) {
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Syria", date_start: "2026-08-01" }], envelope) };
        if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
        throw new Error("unerwartet: " + u);
      };
      const { buildReport } = freshHandler()._internal;
      const report = await buildReport();
      assert.ok(report.countries.SYR && report.countries.SYR.ucdpActive, `Umschlag "${envelope}" muss erkannt werden`);
    }
    console.log("Block 8/18 (UCDP: Ereignis-Array wird umschlagunabhaengig gefunden): OK");
  }

  // --- GDELT: mehr Schlagzeilen, laengerer Zeitraum, Trendverlauf wird angehaengt ---
  {
    let artUrl = null, timelineUrl = null;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Sudan", date_start: "2026-08-01" }]) };
      if (u.includes("gdeltproject.org")) {
        if (u.includes("mode=timelinevol")) {
          timelineUrl = u;
          return { ok: true, status: 200, json: async () => ({ timeline: [{ series: "Volume Intensity", data: [
            { date: "20260725000000", value: 1.2 }, { date: "20260801000000", value: 4.8 },
          ] }] }) };
        }
        artUrl = u;
        const articles = Array.from({ length: 12 }, (_, i) => ({ title: "Meldung " + i, url: "https://x/" + i, seendate: "20260807T000000Z", domain: "reuters.com" }));
        return { ok: true, status: 200, json: async () => ({ articles }) };
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(artUrl.includes("timespan=7d"), "die Schlagzeilen-Abfrage muss ueber 7 statt 3 Tage laufen");
    assert.ok(artUrl.includes("maxrecords=25"), "maxrecords muss auf 25 angehoben sein");
    assert.strictEqual(report.countries.SDN.gdeltCount, 12, "die volle Artikelanzahl muss weiter fuer die Risikostufe zaehlen");
    assert.strictEqual(report.countries.SDN.headlines.length, 8, "es duerfen bis zu 8 statt 3 Schlagzeilen angezeigt werden");
    assert.ok(timelineUrl.includes("mode=timelinevol") && timelineUrl.includes("timespan=2w"), "die Trend-Abfrage muss ueber einen eigenen, laengeren Zeitraum laufen");
    assert.deepStrictEqual(report.countries.SDN.gdeltTrend, [{ date: "20260725", value: 1.2 }, { date: "20260801", value: 4.8 }],
      "der Trendverlauf muss geparst und am Land haengen");
    console.log("Block 9/18 (GDELT: mehr Schlagzeilen, 7-Tage-Fenster, Trendverlauf angehaengt): OK");
  }

  // --- GDELT: schlaegt NUR der Trend-Abruf fehl, bleiben Schlagzeilen/Anzahl unberuehrt ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Sudan", date_start: "2026-08-01" }]) };
      if (u.includes("gdeltproject.org")) {
        if (u.includes("mode=timelinevol")) return { ok: false, status: 500, text: async () => "server error" };
        return { ok: true, status: 200, json: async () => ({ articles: [{ title: "Meldung", url: "https://x", seendate: "20260807T000000Z", domain: "reuters.com" }] }) };
      }
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(report.countries.SDN.gdeltCount, 1, "ein fehlgeschlagener Trend-Abruf darf die Artikelanzahl nicht beeintraechtigen");
    assert.strictEqual(report.countries.SDN.headlines.length, 1, "und auch nicht die Schlagzeilen");
    assert.deepStrictEqual(report.countries.SDN.gdeltTrend, [], "bei fehlgeschlagenem Trend-Abruf bleibt der Trend schlicht leer, statt das Land scheitern zu lassen");
    console.log("Block 10/18 (GDELT: Trend-Abruf ist best-effort, Schlagzeilen bleiben unberuehrt bei dessen Fehlschlag): OK");
  }

  // --- findGdeltTimelineData: erkennt die Zeitreihe unabhaengig vom Umschlag ---
  {
    const { findGdeltTimelineData } = freshHandler()._internal;
    const points = [{ date: "20260801000000", value: 3.1 }, { date: "20260802000000", value: 4.4 }];
    assert.deepStrictEqual(findGdeltTimelineData(points, 0), points, "direktes Array");
    assert.deepStrictEqual(findGdeltTimelineData({ timeline: [{ series: "x", data: points }] }, 0), points, "verschachtelt unter timeline[0].data (dokumentierte GDELT-Form)");
    assert.deepStrictEqual(findGdeltTimelineData({ irgendwas: { noch_tiefer: points } }, 0), points, "beliebig anders benannter Umschlag");
    assert.strictEqual(findGdeltTimelineData({ articles: [{ title: "x", url: "https://x" }] }, 0), null,
      "eine Artikel-Antwort (title/url, kein date/value) darf NICHT faelschlich als Zeitreihe erkannt werden");
    assert.strictEqual(findGdeltTimelineData(null, 0), null);
    console.log("Block 11/18 (findGdeltTimelineData: umschlagunabhaengig, grenzt sich von der Artikel-Form ab): OK");
  }

  // --- UCDP: ein haengender Host darf NICHT die ganze Versionsliste durchlaufen.
  //     Das ist die gefaehrlichste Fehlermoeglichkeit der neuen Suche: 15
  //     Versionen x 2.5s Timeout waeren 37s - ein Vielfaches des Funktionslimits,
  //     und GDELT kaeme nie zum Zug. Nach dem ersten Timeout muss Schluss sein. ---
  {
    let ucdpVersuche = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        ucdpVersuche++;
        return new Promise((_, reject) => { if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
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
    assert.ok(report.countries.RUS, "GDELT und die feste Watchlist muessen trotzdem durchlaufen");
    console.log("Block 12/18 (UCDP: Timeout beendet die Versionssuche sofort, statt sie durchzulaufen): OK");
  }

  // --- UCDP: eine langsame, aber antwortende Gegenstelle darf das Teilbudget
  //     nicht ueberschreiten - sonst frisst allein die Versionssuche die Zeit,
  //     die GDELT fuer die Laenderabfragen braucht. ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        await new Promise((r) => setTimeout(r, 600)); // langsam, aber kein Timeout
        return { ok: false, status: 404, text: async () => "not found" };
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport, UCDP_BUDGET_MS } = freshHandler()._internal;
    const t0 = Date.now();
    const report = await buildReport();
    const dt = Date.now() - t0;
    console.log("  Dauer bei langsamem UCDP (600ms je 404):", (dt / 1000).toFixed(1) + "s, Teilbudget:", UCDP_BUDGET_MS + "ms");
    assert.ok(dt < 10000, "Gesamtlaufzeit muss unter dem Funktionslimit bleiben");
    assert.ok(/Zeitbudget/.test(report.ucdpError), "die abgebrochene Versionssuche muss als Zeitbudget-Abbruch gemeldet werden, nicht als stiller Fehlschlag");
    assert.ok(report.countries.RUS, "GDELT muss danach noch Zeit bekommen haben");
    console.log("Block 13/18 (UCDP: Versionssuche respektiert ihr eigenes Teilbudget): OK");
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
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
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
    console.log("Block 14/18 (UCDP: erfolgreiche Version wird gemerkt, zweiter Lauf spart die 404-Kaskade): OK");
  }

  // --- Budget-Kopplung: Laenge der Versionsliste, UCDP-Teilbudget und die Zeit,
  //     die GDELT fuer seine Wellen braucht, haengen zusammen. Wer eine der drei
  //     Zahlen aendert, ohne die anderen zu pruefen, hungert eine Seite aus -
  //     entweder wird die Versionssuche abgeschnitten oder die halbe Laenderliste
  //     bleibt "nicht geprueft". Deshalb hier festgenagelt. ---
  {
    const {
      ucdpUrls, UCDP_BUDGET_MS, UCDP_ANNAHME_MS_JE_VERSUCH,
      FUNCTION_BUDGET_MS, PER_REQUEST_TIMEOUT, WAVE,
    } = freshHandler()._internal;

    const kandidaten = ucdpUrls(new Date());
    const kaltstartKosten = kandidaten.length * UCDP_ANNAHME_MS_JE_VERSUCH;
    assert.ok(kaltstartKosten <= UCDP_BUDGET_MS,
      `die komplette Versionsliste (${kandidaten.length} Aufrufe x ${UCDP_ANNAHME_MS_JE_VERSUCH}ms = ${kaltstartKosten}ms) muss in das UCDP-Teilbudget von ${UCDP_BUDGET_MS}ms passen - sonst wird sie beim Kaltstart abgeschnitten`);

    // Ohne UCDP-Token wird UCDP ohne Netzwerkaufruf uebersprungen - dann steht
    // GDELT praktisch das ganze Budget zur Verfuegung. Genau dieser Fall ist
    // seit der Token-Pflicht der Normalfall, und in ihm MUSS die komplette
    // Beobachtungsliste durchlaufen werden koennen. Sonst blieben Laender
    // dauerhaft "nicht geprueft", ohne dass jemand den Grund saehe.
    const { FIXED_WATCHLIST, MAX_WATCHLIST } = require("../netlify/functions/lib/geo-countries.js");
    const laender = Math.min(FIXED_WATCHLIST.length, MAX_WATCHLIST);
    const wellen = Math.ceil(laender / WAVE);
    const gdeltKosten = wellen * PER_REQUEST_TIMEOUT;
    assert.ok(gdeltKosten <= FUNCTION_BUDGET_MS,
      `${laender} Laender / ${WAVE} je Welle = ${wellen} Wellen x ${PER_REQUEST_TIMEOUT}ms = ${gdeltKosten}ms passen nicht in das Budget von ${FUNCTION_BUDGET_MS}ms - ein Teil der Liste bliebe ungeprueft`);

    // Und mit Token muss zumindest der Grossteil noch durchkommen.
    const restMitToken = FUNCTION_BUDGET_MS - UCDP_BUDGET_MS;
    assert.ok(restMitToken >= 2 * PER_REQUEST_TIMEOUT,
      `mit Token bleiben nur ${restMitToken}ms fuer GDELT - das reicht nicht fuer zwei Wellen a ${PER_REQUEST_TIMEOUT}ms`);
    console.log(`Block 15/18 (Budgets passen: ${laender} Laender in ${wellen} Wellen = ${gdeltKosten}ms von ${FUNCTION_BUDGET_MS}ms): OK`);
  }

  // --- GDELT-Nebenlaeufigkeit: der Trendabruf ist eine ZWEITE Anfrage je Land.
  //     Holte man ihn fuer jedes Land, waeren es bei einer Welle von fuenf
  //     zehn gleichzeitige Anfragen statt fuenf - gegen eine oeffentliche API,
  //     die bei aggressiver Nutzung drosselt. Der Trend wird deshalb nur fuer
  //     Laender geholt, die eine offizielle Quelle als Konfliktland fuehrt. ---
  {
    let maxGleichzeitig = 0, laufend = 0;
    const trendFuer = new Set(), artikelFuer = new Set();
    const landAusUrl = (u) => (decodeURIComponent(u).match(/query="([^"]+)"/) || [])[1] || "?";
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) {
        // Nur Sudan gilt als Konfliktland - fuer alle anderen darf kein Trend geholt werden.
        return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Sudan", date_start: "2026-08-01" }]) };
      }
      if (u.includes("gdeltproject.org")) {
        laufend++; maxGleichzeitig = Math.max(maxGleichzeitig, laufend);
        const land = landAusUrl(u);
        if (u.includes("mode=timelinevol")) trendFuer.add(land); else artikelFuer.add(land);
        await new Promise((r) => setTimeout(r, 20)); // Ueberlappung sichtbar machen
        laufend--;
        return { ok: true, status: 200, json: async () => (u.includes("timelinevol") ? { timeline: [{ data: [] }] } : { articles: [] }) };
      }
      throw new Error("unerwartet: " + u);
    };
    const mod = freshHandler();
    const { buildReport, WAVE } = mod._internal;
    await buildReport();

    assert.ok(maxGleichzeitig <= WAVE + 1,
      `hoechstens eine Welle (${WAVE}) plus der eine Trendabruf des Konfliktlandes duerfen gleichzeitig laufen, gemessen: ${maxGleichzeitig}`);
    assert.deepStrictEqual([...trendFuer], ["Sudan"],
      "der Trend darf nur fuer das gemeldete Konfliktland geholt werden, tatsaechlich: " + [...trendFuer].join(", "));
    assert.ok(artikelFuer.size > 5, "die Artikelliste muss weiterhin fuer ALLE beobachteten Laender geholt werden, nicht nur fuer Konfliktlaender");
    console.log(`Block 16/18 (GDELT: hoechstens ${maxGleichzeitig} gleichzeitige Anfragen, Trend nur fuer Konfliktlaender): OK`);
  }

  // --- UCDP-Token-Pflicht (Live-Beleg: HTTP 401 "API token required. Add
  //     header: x-ucdp-access-token"). Ohne Token darf UCDP GAR NICHT
  //     angefragt werden: jeder Versuch waere ein garantierter 401 und wuerde
  //     nur Zeit kosten, die GDELT fuer die Laenderabfragen braucht. ---
  {
    let ucdpAngefragt = false;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("ucdpapi.pcr.uu.se")) { ucdpAngefragt = true; return { ok: false, status: 401, text: async () => "API token required" }; }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
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
    console.log("Block 17/18 (ohne UCDP-Token wird gar nicht erst angefragt, Meldung nennt den Weg zum Token): OK");
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
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    await buildReport();
    assert.ok(gesehen.length > 0, "mit Token muss UCDP angefragt werden");
    assert.strictEqual(gesehen[0]["x-ucdp-access-token"], "test-token",
      "der Token muss im Header x-ucdp-access-token stehen - genau so verlangt es die API laut ihrer 401-Meldung");
    console.log("Block 18/18 (mit Token wird der Header x-ucdp-access-token gesetzt): OK");
  }

  console.log("\nAlle geopolitics.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
