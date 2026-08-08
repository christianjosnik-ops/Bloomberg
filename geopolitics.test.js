// geopolitics.test.js — Unit-Tests fuer die Weltlage-Function.
// Kein Test-Framework, nur Node + assert:  node geopolitics.test.js
// Alle HTTP-Aufrufe hier sind gefakt - es geht um die Aggregations-, Level-
// und Zeitbudget-Logik, nicht um echte GDELT-/ReliefWeb-Antworten.

const assert = require("assert");
const path = "/home/user/Bloomberg/netlify/functions/geopolitics.js";

function freshHandler() { delete require.cache[require.resolve(path)]; return require(path); }

(async function run() {
  // --- computeLevel(): Stufenlogik isoliert pruefen ---
  {
    const { computeLevel } = freshHandler()._internal;
    assert.strictEqual(computeLevel(0, false), "keine");
    assert.strictEqual(computeLevel(1, false), "niedrig");
    assert.strictEqual(computeLevel(2, false), "mittel");
    assert.strictEqual(computeLevel(4, false), "mittel");
    assert.strictEqual(computeLevel(5, false), "hoch", "5+ Artikel allein reicht fuer hoch");
    assert.strictEqual(computeLevel(0, true), "hoch", "aktive ReliefWeb-Krise allein reicht fuer hoch");
    assert.strictEqual(computeLevel(5, true), "kritisch", "beide Signale zusammen -> kritisch");
    console.log("Block 1/12 (Stufenlogik): OK");
  }

  // --- Normalfall: ReliefWeb liefert 2 Laender, GDELT antwortet fuer alle ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        return { ok: true, status: 200, json: async () => ({
          data: [
            { fields: { name: "Sudan conflict escalation", date: { created: "2026-08-01T00:00:00" }, type: [{ name: "Complex Emergency" }], country: [{ iso3: "SDN", iso2: "SD", name: "Sudan" }] } },
            { fields: { name: "Gaza humanitarian crisis", date: { created: "2026-08-05T00:00:00" }, type: [{ name: "Complex Emergency" }], country: [{ iso3: "PSE", iso2: "PS", name: "Palestine" }] } },
          ],
        }) };
      }
      if (u.includes("gdeltproject.org")) {
        // Sudan bekommt 6 Artikel (-> hoch/kritisch kombiniert mit ReliefWeb), alle anderen 0
        const many = u.includes("Sudan");
        const articles = many ? Array.from({ length: 6 }, (_, i) => ({ title: "Sudan clash report " + i, url: "https://x/" + i, seendate: "20260807T000000Z", domain: "reuters.com" })) : [];
        return { ok: true, status: 200, json: async () => ({ articles }) };
      }
      throw new Error("unerwartete URL: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(report.reliefwebError, null);
    assert.ok(report.countries.SDN, "Sudan muss in der Watchlist sein (aus ReliefWeb)");
    assert.strictEqual(report.countries.SDN.level, "kritisch", "ReliefWeb aktiv + 6 GDELT-Artikel -> kritisch");
    assert.strictEqual(report.countries.SDN.reliefwebHeadline, "Sudan conflict escalation");
    assert.strictEqual(report.countries.SDN.flag, "🇸🇩");
    assert.ok(report.countries.PSE, "Palestine muss in der Watchlist sein");
    assert.strictEqual(report.countries.PSE.level, "hoch", "ReliefWeb aktiv, aber 0 GDELT-Treffer -> hoch (nicht kritisch)");
    // Ein Land aus der festen Liste ohne ReliefWeb-Eintrag und ohne GDELT-Treffer
    assert.ok(report.countries.RUS, "feste Watchlist muss aufgefuellt sein");
    assert.strictEqual(report.countries.RUS.level, "keine");
    assert.strictEqual(report.countries.RUS.reliefwebActive, false);
    console.log("Block 2/12 (Normalfall, kombinierte Signale): OK");
  }

  // --- ReliefWeb faellt aus -> trotzdem Bericht mit fester Watchlist, Fehler sichtbar ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) throw new Error("ReliefWeb nicht erreichbar");
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(report.reliefwebError, "ReliefWeb-Fehler muss im Bericht sichtbar sein");
    assert.ok(report.countries.RUS, "feste Watchlist funktioniert weiter ohne ReliefWeb");
    assert.strictEqual(Object.keys(report.countries).length, 14, "genau die feste Watchlist (14 Laender), keine dynamischen dazu");
    console.log("Block 3/12 (ReliefWeb-Ausfall, feste Liste als Basis): OK");
  }

  // --- Zeitbudget: haengende GDELT-Aufrufe duerfen den Bericht nicht blockieren ---
  {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (u.includes("gdeltproject.org")) {
        // haengt permanent - nur das Abort-Signal beendet den Aufruf
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
    console.log("Block 4/12 (Zeitbudget schuetzt vor Timeout-Sturm): OK");
  }

  // --- ReliefWeb: 400 auf gefilterte Anfrage -> Fallback auf ungefilterte Anfrage ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        if (u.includes("filter")) return { ok: false, status: 400, json: async () => ({ error: "invalid filter value" }) };
        // Ungefilterte Rueckfallanfrage liefert trotzdem verwertbare Daten
        return { ok: true, status: 200, json: async () => ({ data: [
          { fields: { name: "Sudan conflict escalation", date: { created: "2026-08-01T00:00:00" }, type: [{ name: "Complex Emergency" }], country: [{ iso3: "SDN", iso2: "SD", name: "Sudan" }] } },
        ] }) };
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(report.reliefwebError, null, "400 auf die gefilterte Anfrage darf dank Fallback keinen sichtbaren Fehler hinterlassen");
    assert.ok(report.countries.SDN && report.countries.SDN.reliefwebActive, "Rueckfallanfrage ohne Filter muss die Daten trotzdem liefern");
    console.log("Block 5/12 (ReliefWeb 400 -> Fallback ohne Statusfilter): OK");
  }

  // --- Zeitbudget gilt AB FUNKTIONSSTART, nicht erst nach ReliefWeb ---
  {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        // Realistisch langsam, aber kein Timeout - simuliert einen trueben aber
        // erfolgreichen ReliefWeb-Aufruf, der frueher faelschlich NICHT gegen das
        // Gesamtbudget zaehlte.
        await new Promise((r) => setTimeout(r, 1500));
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
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
    console.log("  Dauer bei langsamem ReliefWeb (1.5s) + haengendem GDELT:", (dt / 1000).toFixed(1) + "s");
    assert.ok(dt < 10000, "ReliefWeb-Zeit + GDELT-Wellen zusammen muessen unter Netlifys Funktionslimit bleiben");
    const levels = Object.values(report.countries).map((c) => c.level);
    assert.ok(levels.some((l) => l === "nicht geprüft"), "Budget muss trotz vorgelagerter ReliefWeb-Zeit greifen");
    console.log("Block 6/12 (Zeitbudget ab Funktionsstart, deckt ReliefWeb + GDELT zusammen ab): OK");
  }

  // --- ReliefWeb: Statuswerte + Fehlertext des Servers ---
  {
    const seenUrls = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        seenUrls.push(u);
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Invalid value 'bogus' for filter[value]" } }) };
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();

    // Der frueher genutzte, ungueltige Statuswert darf nicht mehr vorkommen.
    assert.ok(!seenUrls[0].includes("value%5B%5D=current") && !seenUrls[0].includes("value[]=current"),
      "der Statuswert 'current' gehoert nicht zur disasters-Taxonomie und darf nicht mehr angefragt werden");
    assert.ok(seenUrls[0].includes("ongoing"), "stattdessen muss 'ongoing' angefragt werden");
    assert.strictEqual(seenUrls.length, 3, "bei durchgehendem 400 muessen alle drei Abfrageformen probiert werden (gefiltert, ungefiltert, ohne Feldauswahl)");
    assert.ok(!seenUrls[1].includes("filter"), "der zweite Versuch muss ohne Statusfilter laufen");
    assert.ok(!seenUrls[2].includes("fields"), "der dritte Versuch muss zusaetzlich ohne Feldauswahl laufen");
    // Und die Begruendung des Servers muss bis ins UI durchkommen.
    assert.ok(/Invalid value/.test(report.reliefwebError),
      "der erklaerende Fehlertext des Servers muss in reliefwebError landen - sonst steht im UI nur 'HTTP 400'");
    console.log("Block 7/12 (ReliefWeb: korrekte Statuswerte + Fehlertext durchgereicht): OK");
  }

  // --- Timeout darf NICHT auf die ungefilterte Abfrage nachfassen (Zeitverschwendung) ---
  {
    let calls = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        calls++;
        return new Promise((_, reject) => { if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(calls, 1, "bei einer Zeitueberschreitung darf NICHT nachgefasst werden - das wuerde nur ein zweites Timeout kosten");
    assert.ok(report.reliefwebError, "der Fehler muss trotzdem sichtbar bleiben");
    assert.ok(report.countries.RUS, "die feste Watchlist muss unabhaengig davon weiter funktionieren");
    console.log("Block 8/12 (ReliefWeb: kein sinnloser zweiter Versuch nach Timeout): OK");
  }

  // --- API-Version: v1 ist abgeschaltet, es darf nur noch v2 angefragt werden ---
  {
    const seen = [];
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        seen.push(u);
        // Wie die echte API v1 antwortet - falls doch jemand v1 anfragt, faellt es auf.
        if (u.includes("/v1/")) return { ok: false, status: 410, text: async () => JSON.stringify({ status: 410, error: { type: "Exception", message: "The API version 'v1' has been decommissioned. Please use version 'v2' instead." } }) };
        return { ok: true, status: 200, json: async () => ({ data: [
          { fields: { name: "Sudan: Complex Emergency", date: { created: "2026-08-01T00:00:00" }, type: [{ name: "Complex Emergency" }], country: [{ iso3: "SDN", iso2: "SD", name: "Sudan" }] } },
        ] }) };
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(seen.length > 0, "ReliefWeb muss ueberhaupt angefragt werden");
    assert.ok(seen.every((u) => u.includes("/v2/")), "es darf ausschliesslich API v2 angefragt werden - v1 ist abgeschaltet (HTTP 410)");
    assert.strictEqual(report.reliefwebError, null);
    assert.ok(report.countries.SDN && report.countries.SDN.reliefwebActive, "v2-Daten muessen normal verarbeitet werden");
    console.log("Block 9/12 (nur API v2 wird angefragt): OK");
  }

  // --- 410 darf NICHT zu weiteren Versuchen fuehren (Version endgueltig weg) ---
  {
    let calls = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        calls++;
        return { ok: false, status: 410, text: async () => '{"error":{"message":"decommissioned"}}' };
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.strictEqual(calls, 1, "ein 410 gilt fuer jede Abfrageform derselben Version - weitere Versuche waeren Zeitverschwendung");
    assert.ok(/410/.test(report.reliefwebError), "der 410 muss sichtbar bleiben");
    console.log("Block 10/12 (410 beendet die Kette sofort): OK");
  }

  // --- Flache v2-Antwort (ohne fields-Umschlag) muss ebenfalls verarbeitet werden ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes("reliefweb.int")) {
        return { ok: true, status: 200, json: async () => ({ data: [
          // Nutzdaten flach statt unter .fields, country als Objekt statt Array
          { name: "Mali: Conflict", date: { created: "2026-07-20T00:00:00" }, type: { name: "Complex Emergency" }, country: { iso3: "MLI", iso2: "ML", name: "Mali" } },
        ] }) };
      }
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(report.countries.MLI, "auch eine flache Antwortform muss zu einem Land fuehren");
    assert.strictEqual(report.countries.MLI.reliefwebHeadline, "Mali: Conflict");
    assert.strictEqual(report.countries.MLI.reliefwebType, "Complex Emergency");
    assert.strictEqual(report.countries.MLI.reliefwebDate, "2026-07-20");
    console.log("Block 11/12 (flaches v2-Format wird ebenfalls verstanden): OK");
  }

  // --- Unbekannter Antwortumschlag: Fehler statt stiller leerer Liste ---
  {
    global.fetch = async (url) => {
      const u = String(url);
      // Antwortet mit 200, aber ohne erkennbare Datenliste
      if (u.includes("reliefweb.int")) return { ok: true, status: 200, json: async () => ({ meta: { total: 0 }, unerwartet: true }) };
      if (u.includes("gdeltproject.org")) return { ok: true, status: 200, json: async () => ({ articles: [] }) };
      throw new Error("unerwartet: " + u);
    };
    const { buildReport } = freshHandler()._internal;
    const report = await buildReport();
    assert.ok(report.reliefwebError && /unerwartetes Antwortformat/.test(report.reliefwebError),
      "ein unbekannter Umschlag darf nicht als 'keine Krisen weltweit' durchgehen, sondern muss als Fehler auffallen");
    console.log("Block 12/12 (unbekanntes Antwortformat wird gemeldet, nicht verschluckt): OK");
  }

  console.log("\nAlle geopolitics.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
