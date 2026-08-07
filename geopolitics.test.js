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
    console.log("Block 1/4 (Stufenlogik): OK");
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
    console.log("Block 2/4 (Normalfall, kombinierte Signale): OK");
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
    console.log("Block 3/4 (ReliefWeb-Ausfall, feste Liste als Basis): OK");
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
    console.log("Block 4/4 (Zeitbudget schuetzt vor Timeout-Sturm): OK");
  }

  console.log("\nAlle geopolitics.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
