// diag.test.js — Tests fuer den Diagnose-Endpunkt.
//   node diag.test.js
// Der Endpunkt existiert, um echte Ausfaelle sichtbar zu machen - er muss also
// selbst dann noch ein brauchbares Ergebnis liefern, wenn die Gegenstelle
// abstuerzt, haengt oder Muell zurueckgibt. Genau das wird hier geprueft.

const assert = require("assert");
const path = "/home/user/Bloomberg/netlify/functions/diag.js";
function fresh() { delete require.cache[require.resolve(path)]; return require(path); }

(async function run() {
  // --- Erfolgsfall: Status, Dauer, JSON-Struktur und Body-Auszug werden gemeldet ---
  {
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h === "content-type" ? "application/json; charset=utf-8" : null) },
      text: async () => JSON.stringify({ data: [{ fields: { name: "Test" } }], totalCount: 1 }),
    });
    const { probe } = fresh()._internal;
    const r = await probe({ key: "x", label: "X", url: "https://example.invalid/a" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.jsonTopLevelKeys, ["data", "totalCount"], "oberste JSON-Schluessel muessen sichtbar sein");
    assert.strictEqual(r.dataArrayLength, 1, "Laenge des data-Arrays muss gemeldet werden");
    assert.ok(typeof r.ms === "number", "Dauer muss gemessen werden");
    assert.ok(r.bodySnippet.includes("Test"));
    console.log("Block 1/8 (Erfolgsfall: Status/JSON-Struktur/Dauer): OK");
  }

  // --- 400 mit Fehlertext: der Koerper ist die eigentliche Information ---
  {
    global.fetch = async () => ({
      ok: false, status: 400,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error: { message: "Invalid value 'current' for filter[value]" } }),
    });
    const { probe } = fresh()._internal;
    const r = await probe({ key: "rw", label: "ReliefWeb", url: "https://example.invalid/b" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
    assert.ok(r.bodySnippet.includes("Invalid value"), "der erklaerende Fehlertext MUSS im Auszug landen - er ist der ganze Zweck der Diagnose");
    console.log("Block 2/8 (4xx: Fehlertext des Servers bleibt erhalten): OK");
  }

  // --- Zeitueberschreitung: klare Meldung statt Haenger ---
  {
    global.fetch = async (url, opts) => new Promise((_, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const { probe } = fresh()._internal;
    const t0 = Date.now();
    const r = await probe({ key: "slow", label: "Langsam", url: "https://example.invalid/c" });
    const dt = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.ok(/Zeitueberschreitung/.test(r.error), "muss die Zeitueberschreitung benennen, statt einen rohen Abbruch zu melden");
    assert.ok(dt < 8000, "die Probe muss selbst abbrechen (gemessen: " + dt + "ms)");
    console.log("Block 3/8 (Zeitueberschreitung sauber gemeldet, " + (dt / 1000).toFixed(1) + "s): OK");
  }

  // --- Netzwerkfehler: .cause enthaelt bei fetch oft erst den echten Grund ---
  {
    global.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND api.reliefweb.int") }); };
    const { probe } = fresh()._internal;
    const r = await probe({ key: "dns", label: "DNS", url: "https://example.invalid/d" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "fetch failed");
    assert.ok(/ENOTFOUND/.test(r.errorCause), "der eigentliche Grund steckt in .cause und darf nicht verlorengehen");
    console.log("Block 4/8 (Netzwerkfehler: .cause wird mitgemeldet): OK");
  }

  // --- Kaputtes JSON trotz JSON-Content-Type darf die Diagnose nicht abschiessen ---
  {
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      text: async () => "<html>Just a moment... Cloudflare</html>",
    });
    const { probe } = fresh()._internal;
    const r = await probe({ key: "html", label: "HTML statt JSON", url: "https://example.invalid/e" });
    assert.ok(r.jsonParseError, "muss den Parse-Fehler melden statt zu werfen");
    assert.ok(r.bodySnippet.includes("Cloudflare"), "der HTML-Auszug entlarvt die Bot-Sperre");
    console.log("Block 5/8 (HTML statt JSON: Bot-Sperre wird sichtbar): OK");
  }

  // --- Handler: Gesamtantwort ist gueltiges JSON mit Zusammenfassung, auch wenn alles scheitert ---
  {
    global.fetch = async () => { throw new Error("alles kaputt"); };
    const diag = fresh();
    const res = await diag.handler({ httpMethod: "GET", queryStringParameters: { only: "reliefweb" } });
    assert.strictEqual(res.statusCode, 200, "die Diagnose selbst darf nie fehlschlagen - sonst diagnostiziert sie nichts mehr");
    const body = JSON.parse(res.body);
    // 4 Proben: der v1-Beleg (erwartet 410) + die drei v2-Abfrageformen.
    assert.strictEqual(body.proben.length, 4, "only=reliefweb muss alle ReliefWeb-Proben auswaehlen (v1-Beleg + drei v2-Formen)");
    assert.strictEqual(body.zusammenfassung.fehlgeschlagen.length, 4);
    assert.ok(body.laufzeitumgebung.node, "Node-Version gehoert in den Bericht");
    // Sicherheitsnetz: es darf nichts Geheimes im Bericht landen
    const asText = JSON.stringify(body);
    assert.ok(!/token=|apikey=|api_key=|Cookie/i.test(asText), "der Bericht darf keine Schluessel oder Cookies enthalten");
    console.log("Block 6/8 (Handler: robust + keine Geheimnisse im Bericht): OK");
  }

  // --- expectStatus: eine Probe, die fehlschlagen SOLL, gilt als bestanden ---
  {
    // Der v1-Endpunkt ist abgeschaltet und antwortet mit 410. Diese Probe ist
    // ein bewusster Beleg dafuer - sie darf die Zusammenfassung nicht rot faerben.
    global.fetch = async () => ({
      ok: false, status: 410,
      headers: { get: () => "application/json" },
      text: async () => '{"error":{"message":"The API version \'v1\' has been decommissioned. Please use version \'v2\' instead."}}',
    });
    const { probe } = fresh()._internal;
    const r = await probe({ key: "v1", label: "v1 abgeschaltet", url: "https://example.invalid/v1", expectStatus: 410 });
    assert.strictEqual(r.status, 410);
    assert.strictEqual(r.wieErwartet, true, "410 war genau der erwartete Status");
    assert.strictEqual(r.ok, true, "eine Probe mit erwartetem Fehlstatus darf nicht als Ausfall gezaehlt werden");
    assert.ok(/decommissioned/.test(r.bodySnippet), "die Begruendung bleibt trotzdem sichtbar");
    console.log("Block 7/8 (erwarteter Fehlstatus zaehlt als bestanden): OK");
  }

  // --- expectStatus: abweichender Status faellt auf ---
  {
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      text: async () => '{"data":[]}',
    });
    const { probe } = fresh()._internal;
    const r = await probe({ key: "v1", label: "v1 abgeschaltet", url: "https://example.invalid/v1", expectStatus: 410 });
    assert.strictEqual(r.wieErwartet, false, "wenn v1 ploetzlich wieder antwortet, muss das auffallen");
    assert.strictEqual(r.ok, false);
    console.log("Block 8/8 (abweichender Status wird als Abweichung gemeldet): OK");
  }

  console.log("\nAlle diag.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
