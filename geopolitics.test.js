// geopolitics.test.js — Unit-Tests fuer die Weltlage-Function.
// Kein Test-Framework, nur Node + assert:  node geopolitics.test.js
// Alle HTTP-Aufrufe hier sind gefakt - es geht um die Aggregations-, Level-
// und Zeitbudget-Logik, nicht um echte GDELT-/UCDP-/ReliefWeb-Antworten.
//
// Architektur seit der ReliefWeb-Appname-Sperre (Live-Beleg: HTTP 403 "not
// using an approved appname"): UCDP ist die Hauptquelle fuer die dynamische
// Laenderliste, ReliefWeb wird NUR versucht, wenn RELIEFWEB_APPNAME gesetzt
// ist. Jeder Test muss darum entweder (a) UCDP mocken und ReliefWeb
// unangetastet lassen (Appname bleibt unset), oder (b) fuer ReliefWeb-
// spezifische Tests RELIEFWEB_APPNAME setzen UND UCDP mocken (sonst wirft
// buildReport auf eine unerwartete URL).

const assert = require("assert");
const path = "/home/user/Bloomberg/netlify/functions/geopolitics.js";

function freshHandler() {
  delete require.cache[require.resolve(path)];
  delete process.env.RELIEFWEB_APPNAME; // sauberer Ausgangszustand fuer jeden Block
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
    console.log("Block 1/22 (Stufenlogik): OK");
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
    console.log("Block 2/22 (UCDP-Normalfall, kombinierte Signale): OK");
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
    assert.strictEqual(Object.keys(report.countries).length, 14, "genau die feste Watchlist (14 Laender), keine dynamischen dazu");
    assert.ok(/übersprungen/.test(report.reliefwebError), "ohne RELIEFWEB_APPNAME muss ReliefWeb als uebersprungen gemeldet werden, nicht als Fehlschlag");
    console.log("Block 3/22 (UCDP-Ausfall, feste Liste als Basis, ReliefWeb standardmaessig uebersprungen): OK");
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
    console.log("Block 4/22 (Zeitbudget schuetzt vor Timeout-Sturm): OK");
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
    console.log("Block 5/22 (UCDP: laeuft ueber 404er rueckwaerts bis zur existierenden Monatsversion): OK");
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
    console.log("Block 6/22 (Zeitbudget ab Funktionsstart, deckt UCDP + GDELT zusammen ab): OK");
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
    console.log("Block 7/22 (UCDP: unbekannte Laendernamen werden uebersprungen): OK");
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
    console.log("Block 8/22 (UCDP: Ereignis-Array wird umschlagunabhaengig gefunden): OK");
  }

  // --- ReliefWeb wird OHNE RELIEFWEB_APPNAME gar nicht erst angefragt ---
  {
    let reliefwebCalled = false;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) { reliefwebCalled = true; return { ok: true, status: 200, json: async () => ({ data: [] }) }; }
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([]) };
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(reliefwebCalled, false, "ohne genehmigten Appname darf ReliefWeb gar nicht erst angefragt werden (spart Zeitbudget fuer einen garantierten Fehlschlag)");
    assert.ok(/RELIEFWEB_APPNAME/.test(report.reliefwebError));
    console.log("Block 9/22 (ReliefWeb standardmaessig uebersprungen ohne Appname): OK");
  }

  // --- MIT RELIEFWEB_APPNAME: ReliefWeb ergaenzt ein von UCDP bereits bekanntes Land ---
  {
    process.env.RELIEFWEB_APPNAME = "mein-genehmigter-appname";
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        assert.ok(u.includes("appname=mein-genehmigter-appname"), "der genehmigte Appname muss in der URL stehen");
        return { ok: true, status: 200, json: async () => ({ data: [
          { fields: { name: "Sudan conflict escalation", date: { created: "2026-08-01T00:00:00" }, type: [{ name: "Complex Emergency" }], country: [{ iso3: "SDN", name: "Sudan" }] } },
        ] }) };
      }
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([{ country: "Sudan", date_start: "2026-08-01" }]) };
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    delete require.cache[require.resolve(path)]; // NICHT freshHandler() - die loescht RELIEFWEB_APPNAME wieder
    const { buildReport } = require(path)._internal;
    const report = await buildReport();
    delete process.env.RELIEFWEB_APPNAME;
    assert.strictEqual(report.reliefwebError, null);
    assert.ok(report.countries.SDN.ucdpActive, "die UCDP-Flags duerfen durch ReliefWeb nicht verdraengt werden");
    assert.ok(report.countries.SDN.reliefwebActive, "ReliefWeb-Flag muss zusaetzlich gesetzt sein");
    assert.strictEqual(report.countries.SDN.reliefwebHeadline, "Sudan conflict escalation");
    console.log("Block 10/22 (ReliefWeb ergaenzt ein UCDP-Land, ohne dessen Flags zu verdraengen): OK");
  }

  // --- MIT RELIEFWEB_APPNAME: ReliefWeb fuegt ein Land hinzu, das UCDP nicht kennt ---
  {
    process.env.RELIEFWEB_APPNAME = "mein-genehmigter-appname";
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) return { ok: true, status: 200, json: async () => ({ data: [
        { fields: { name: "Haiti gang violence", date: { created: "2026-08-01T00:00:00" }, type: [{ name: "Complex Emergency" }], country: [{ iso3: "HTI", name: "Haiti" }] } },
      ] }) };
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([]) };
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    delete require.cache[require.resolve(path)];
    const { buildReport } = require(path)._internal;
    const report = await buildReport();
    delete process.env.RELIEFWEB_APPNAME;
    assert.ok(report.countries.HTI, "ein nur von ReliefWeb gemeldetes Land muss trotzdem in der Watchlist landen");
    assert.strictEqual(report.countries.HTI.reliefwebActive, true);
    assert.strictEqual(report.countries.HTI.ucdpActive, false);
    console.log("Block 11/22 (ReliefWeb fuegt ein UCDP-unbekanntes Land hinzu): OK");
  }

  // --- MIT RELIEFWEB_APPNAME: 410 beendet die ReliefWeb-Kette sofort ---
  {
    process.env.RELIEFWEB_APPNAME = "mein-genehmigter-appname";
    let rwCalls = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) { rwCalls++; return { ok: false, status: 410, text: async () => '{"error":{"message":"decommissioned"}}' }; }
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([]) };
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    delete require.cache[require.resolve(path)];
    const { buildReport } = require(path)._internal;
    const report = await buildReport();
    delete process.env.RELIEFWEB_APPNAME;
    assert.strictEqual(rwCalls, 1, "ein 410 gilt fuer jede Abfrageform derselben Version - weitere Versuche waeren Zeitverschwendung");
    assert.ok(/410/.test(report.reliefwebError));
    console.log("Block 12/22 (ReliefWeb: 410 beendet die Kette sofort): OK");
  }

  // --- country.iso2 entfernt, Appname konfigurierbar (Live-Befund) ---
  {
    process.env.RELIEFWEB_APPNAME = "appname-eins";
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) { seen.push(u); return { ok: true, status: 200, json: async () => ({ data: [] }) }; }
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([]) };
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    delete require.cache[require.resolve(path)];
    await require(path)._internal.buildReport();
    assert.ok(seen.length > 0 && seen.every((u) => !u.includes("country.iso2")),
      "country.iso2 wird von ReliefWeb v2 abgelehnt (Live-Beleg: HTTP 400) und darf nicht mehr angefragt werden");
    assert.ok(seen.every((u) => u.includes("appname=appname-eins")), "der gesetzte Appname muss verwendet werden");
    delete process.env.RELIEFWEB_APPNAME;
    console.log("Block 13/22 (country.iso2 entfernt, Appname aus RELIEFWEB_APPNAME uebernommen): OK");
  }

  // --- Unbekannter GDELT-/ReliefWeb-Fehler wird sichtbar, nicht verschluckt ---
  {
    process.env.RELIEFWEB_APPNAME = "appname-eins";
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) return { ok: true, status: 200, json: async () => ({ meta: { total: 0 }, unerwartet: true }) };
      if (u.includes("ucdpapi.pcr.uu.se")) return { ok: true, status: 200, json: async () => ucdpBody([]) };
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    delete require.cache[require.resolve(path)];
    const report = await require(path)._internal.buildReport();
    delete process.env.RELIEFWEB_APPNAME;
    assert.ok(report.reliefwebError && /unerwartetes Antwortformat/.test(report.reliefwebError),
      "ein unbekannter ReliefWeb-Umschlag darf nicht als 'keine Krisen weltweit' durchgehen, sondern muss als Fehler auffallen");
    console.log("Block 14/22 (unbekanntes ReliefWeb-Antwortformat wird gemeldet, nicht verschluckt): OK");
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
    console.log("Block 15/22 (GDELT: mehr Schlagzeilen, 7-Tage-Fenster, Trendverlauf angehaengt): OK");
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
    console.log("Block 16/22 (GDELT: Trend-Abruf ist best-effort, Schlagzeilen bleiben unberuehrt bei dessen Fehlschlag): OK");
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
    console.log("Block 17/22 (findGdeltTimelineData: umschlagunabhaengig, grenzt sich von der Artikel-Form ab): OK");
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
    console.log("Block 18/22 (UCDP: Timeout beendet die Versionssuche sofort, statt sie durchzulaufen): OK");
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
    console.log("Block 19/22 (UCDP: Versionssuche respektiert ihr eigenes Teilbudget): OK");
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
    console.log("Block 20/22 (UCDP: erfolgreiche Version wird gemerkt, zweiter Lauf spart die 404-Kaskade): OK");
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

    // Was nach der Versionssuche fuer GDELT uebrig bleibt, muss noch fuer
    // mindestens zwei Wellen reichen (14 Laender = 3 Wellen; zwei davon decken
    // den Grossteil der Beobachtungsliste ab).
    const restFuerGdelt = FUNCTION_BUDGET_MS - UCDP_BUDGET_MS;
    assert.ok(restFuerGdelt >= 2 * PER_REQUEST_TIMEOUT,
      `nach der Versionssuche bleiben nur ${restFuerGdelt}ms fuer GDELT - das reicht nicht fuer zwei Wellen a ${PER_REQUEST_TIMEOUT}ms (je ${WAVE} Laender)`);
    console.log(`Block 21/22 (Budgets passen zusammen: ${kandidaten.length} UCDP-Versuche in ${UCDP_BUDGET_MS}ms, ${restFuerGdelt}ms fuer GDELT): OK`);
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
    console.log(`Block 22/22 (GDELT: hoechstens ${maxGleichzeitig} gleichzeitige Anfragen, Trend nur fuer Konfliktlaender): OK`);
  }

  console.log("\nAlle geopolitics.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
