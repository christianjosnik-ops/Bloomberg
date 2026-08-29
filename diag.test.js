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
    console.log("Block 1/15 (Erfolgsfall: Status/JSON-Struktur/Dauer): OK");
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
    console.log("Block 2/15 (4xx: Fehlertext des Servers bleibt erhalten): OK");
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
    console.log("Block 3/15 (Zeitueberschreitung sauber gemeldet, " + (dt / 1000).toFixed(1) + "s): OK");
  }

  // --- Netzwerkfehler: .cause enthaelt bei fetch oft erst den echten Grund ---
  {
    global.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND api.reliefweb.int") }); };
    const { probe } = fresh()._internal;
    const r = await probe({ key: "dns", label: "DNS", url: "https://example.invalid/d" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "fetch failed");
    assert.ok(/ENOTFOUND/.test(r.errorCause), "der eigentliche Grund steckt in .cause und darf nicht verlorengehen");
    console.log("Block 4/15 (Netzwerkfehler: .cause wird mitgemeldet): OK");
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
    console.log("Block 5/15 (HTML statt JSON: Bot-Sperre wird sichtbar): OK");
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
    console.log("Block 6/15 (Handler: robust + keine Geheimnisse im Bericht): OK");
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
    console.log("Block 7/15 (erwarteter Fehlstatus zaehlt als bestanden): OK");
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
    console.log("Block 8/15 (abweichender Status wird als Abweichung gemeldet): OK");
  }

  // --- FRED-Sammelproben: eine je Frequenzgruppe, erzeugt aus derselben
  //     Gruppierung, die fred.js im Betrieb nutzt. Geprueft wird, dass die
  //     Proben nicht auseinanderlaufen koennen UND dass sie beides erkennen:
  //     fehlende Spalten und veraltete Daten. Letzteres ist das Wichtigere -
  //     die zuvor genutzten OECD-Serien existierten durchaus, lieferten aber
  //     Werte von 2023, die im UI wie frische Daten aussahen. ---
  {
    const { PROBES } = fresh()._internal;
    const fredIntern = require("/home/user/Bloomberg/netlify/functions/fred.js")._internal;
    const sammelProben = PROBES.filter((x) => x.key.startsWith("fred-sammel-"));
    assert.ok(sammelProben.length >= 3, "es muss je Frequenzgruppe eine Sammelprobe geben, gefunden: " + sammelProben.length);

    // Keine Probe darf Frequenzen mischen - sonst diagnostiziert sie etwas
    // anderes als das, was fred.js tatsaechlich abfragt.
    for (const p of sammelProben) {
      const ids = decodeURIComponent(p.url.match(/[?&]id=([^&]+)/)[1]).split(",");
      assert.strictEqual(new Set(ids.map(fredIntern.freqOf)).size, 1,
        `Probe ${p.key} mischt Frequenzen: ${ids.join(",")}`);
    }
    // Und zusammen muessen sie alle bekannten Serien abdecken.
    const abgedeckt = sammelProben.flatMap((p) => decodeURIComponent(p.url.match(/[?&]id=([^&]+)/)[1]).split(","));
    const fehlendeSerien = Object.keys(fredIntern.SERIES_FREQ).filter((id) => !abgedeckt.includes(id));
    assert.deepStrictEqual(fehlendeSerien, [], "diese Serien werden von keiner Probe geprueft: " + fehlendeSerien.join(", "));

    // Verhalten am Beispiel der Monatsgruppe durchspielen.
    const p = sammelProben.find((x) => x.key === "fred-sammel-monatlich");
    assert.ok(p, "die Monatsgruppe muss eine eigene Probe haben");
    const ids = decodeURIComponent(p.url.match(/[?&]id=([^&]+)/)[1]).split(",");
    const heute = new Date().toISOString().slice(0, 10);
    const zeile = (datum) => datum + "," + ids.map(() => "1.0").join(",");
    const kopf = "DATE," + ids.join(",");

    assert.strictEqual(p.expect(`${kopf}\n${zeile("2026-01-01")}\n${zeile(heute)}`), null,
      "aktuelle Daten mit allen IDs duerfen keine Warnung ergeben");

    const warnFehlt = p.expect(`DATE,${ids[0]}\n2026-01-01,1.0\n${heute},1.0`);
    assert.ok(warnFehlt && ids.slice(1).every((id) => warnFehlt.includes(id)),
      "fehlende Serien-IDs muessen einzeln benannt werden, damit klar ist, welche Spalte FRED weggelassen hat");

    // Genau das Szenario der eingestellten OECD-Serie: IDs alle da, Daten alt.
    const warnAlt = p.expect(`${kopf}\n${zeile("2022-12-01")}\n${zeile("2023-01-01")}`);
    assert.ok(warnAlt && /eingestellt/.test(warnAlt),
      "vorhandene IDs mit jahrealten Daten muessen als vermutlich eingestellt gemeldet werden - sonst wiederholt sich der LRHUTTTTEZM156S-Fall");
    console.log("Block 9a/13 (FRED-Sammelproben: je Frequenzgruppe eine, erkennen Luecken und Veraltetes): OK");
  }

  // --- Appname per Umgebungsvariable: Live-Befund HTTP 403 "not using an
  //     approved appname" bei ReliefWeb v2 - kein Code-Fix moeglich, aber die
  //     URL muss den ueber ENV gesetzten (spaeter genehmigten) Appnamen tragen ---
  {
    delete require.cache[require.resolve(path)];
    let { PROBES } = require(path)._internal;
    const rwProbesDefault = PROBES.filter((p) => p.key.startsWith("reliefweb"));
    assert.ok(rwProbesDefault.length >= 3 && rwProbesDefault.every((p) => p.url.includes("appname=terminal-app-geopolitics")),
      "ohne RELIEFWEB_APPNAME muss der bisherige Standard-Appname in allen ReliefWeb-Proben stehen");
    assert.ok(rwProbesDefault.every((p) => !p.url.includes("country.iso2")),
      "country.iso2 wird von ReliefWeb v2 abgelehnt (Live-Beleg HTTP 400) und darf in keiner Probe mehr vorkommen");

    process.env.RELIEFWEB_APPNAME = "mein-genehmigter-appname";
    delete require.cache[require.resolve(path)];
    ({ PROBES } = require(path)._internal);
    delete process.env.RELIEFWEB_APPNAME;
    const rwProbesEnv = PROBES.filter((p) => p.key.startsWith("reliefweb"));
    assert.ok(rwProbesEnv.length >= 3 && rwProbesEnv.every((p) => p.url.includes("appname=mein-genehmigter-appname")),
      "ein per Umgebungsvariable gesetzter Appname muss in ALLEN ReliefWeb-Proben ankommen (auch dem v1-Beleg)");
    console.log("Block 9b/13 (Appname konfigurierbar, country.iso2 dauerhaft entfernt): OK");
  }

  // --- UCDP: die neue Hauptquelle fuer F6 hat eigene Beleg-Proben ---
  {
    const { PROBES } = fresh()._internal;
    // Die Versionsstrings der Proben muessen dem aktuellen Datum folgen, nicht
    // hartkodiert sein - sonst diagnostiziert die Probe ab naechstem Monat eine
    // andere Version als die, die geopolitics.js tatsaechlich abfragt.
    const jetzt = new Date();
    const vAktuell = `${jetzt.getUTCFullYear() % 100}.0.${jetzt.getUTCMonth() + 1}`;
    const pAktuell = PROBES.find((x) => x.key === "ucdp-monat-aktuell");
    assert.ok(pAktuell && pAktuell.url.includes(`/gedevents/${vAktuell}?`),
      `die Probe muss die aus dem Datum erzeugte Version ${vAktuell} abfragen, nicht eine hartkodierte: ${pAktuell && pAktuell.url}`);
    // Antwortform: Result-Array mit country-Feld (aus der UCDP-Doku belegt)
    assert.strictEqual(pAktuell.expect(JSON.stringify({ TotalCount: 2, Result: [{ id: 1, country: "Sudan" }] })), null,
      "eine gueltige UCDP-Antwort darf keine Warnung ergeben");
    assert.ok(/Result-Array/.test(pAktuell.expect(JSON.stringify({ foo: 1 }))),
      "fehlt das Result-Array, muss das benannt werden");

    const res = await fresh().handler({ httpMethod: "GET", queryStringParameters: { only: "ucdp" } });
    const body = JSON.parse(res.body);
    assert.strictEqual(body.proben.length, 2, "only=ucdp muss beide Monatsproben auswaehlen (laufender Monat + Vormonat)");
    assert.ok(body.proben.some((p) => p.key === "ucdp-monat-aktuell") && body.proben.some((p) => p.key === "ucdp-monat-vormonat"));
    console.log("Block 10/15 (UCDP-Proben folgen dem aktuellen Datum und pruefen die Antwortform): OK");
  }

  // --- GDELT-Timeline-Probe: erkennt eine date/value-Zeitreihe im Antwortkoerper ---
  {
    const { PROBES } = fresh()._internal;
    const p = PROBES.find((x) => x.key === "gdelt-timeline");
    assert.ok(p, "die GDELT-Timeline-Beleg-Probe muss existieren");
    assert.strictEqual(p.expect(JSON.stringify({ timeline: [{ series: "x", data: [{ date: "20260801000000", value: 1.2 }] }] })), null,
      "eine erkennbare Zeitreihe darf keine Warnung ergeben");
    assert.ok(p.expect(JSON.stringify({ articles: [{ title: "x", url: "https://x" }] })),
      "eine Artikel-Antwort ohne date/value muss als fehlende Zeitreihe auffallen");
    assert.ok(p.expect("kein-json"), "kaputte Antwort muss ebenfalls eine Warnung ergeben");
    console.log("Block 11/15 (GDELT-Timeline-Probe erkennt die Zeitreihe, faellt sonst auf): OK");
  }

  // --- Der Fehler, den der Livebetrieb aufgedeckt hat: vier tote FRED-Proben
  //     a 6s ergaben sequenziell 24s und sprengten das interne 20s-Budget.
  //     Alles danach - UCDP, ReliefWeb, GDELT, Yahoo, Stooq, Frankfurter -
  //     wurde uebersprungen, der Bericht meldete "0 OK". Die Diagnose verschwieg
  //     also ausgerechnet die Quellen, die funktionieren. Sie MUSS parallel
  //     laufen: dann kostet der Durchlauf so viel wie die langsamste Probe. ---
  {
    const langsameHosts = ["fred.stlouisfed.org", "api.stlouisfed.org"];
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (langsameHosts.some((h) => u.includes(h))) {
        // Tot: antwortet nie, nur der Abbruch beendet den Aufruf.
        return new Promise((_, reject) => {
          if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }
      // Alle anderen antworten sofort.
      return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => '{"ok":true}' };
    };
    const diag = fresh();
    const t0 = Date.now();
    const res = await diag.handler({ httpMethod: "GET", queryStringParameters: {} });
    const dt = Date.now() - t0;
    const body = JSON.parse(res.body);

    console.log(`  Dauer mit ${langsameHosts.length} toten Hosts:`, (dt / 1000).toFixed(1) + "s bei " + body.proben.length + " Proben");
    assert.ok(dt < 12000,
      `parallel darf der Durchlauf hoechstens so lange dauern wie die langsamste Probe - sequenziell waeren es ein Vielfaches (gemessen: ${dt}ms)`);

    const uebersprungen = body.proben.filter((p) => p.skipped);
    assert.deepStrictEqual(uebersprungen, [],
      "keine Probe darf uebersprungen werden - genau dadurch blieb im Livebetrieb alles ab UCDP unbekannt");

    // Und das Entscheidende: die funktionierenden Quellen muessen sichtbar sein,
    // obwohl FRED tot ist.
    assert.ok(body.zusammenfassung.ok.length > 0,
      "die erreichbaren Quellen muessen als OK gemeldet werden, auch wenn andere haengen - im Livebetrieb stand hier faelschlich '0 OK'");
    assert.ok(body.zusammenfassung.ok.some((k) => k.startsWith("gdelt") || k === "yahoo" || k === "frankfurter"),
      "konkret: GDELT/Yahoo/Frankfurter duerfen nicht hinter toten FRED-Proben verschwinden");
    console.log("Block 12/15 (tote Quellen verdecken die funktionierenden nicht mehr): OK");
  }

  // --- Trennschaerfe-Proben fuer die FRED-Ursache: erreichbar oder nicht? ---
  {
    const { PROBES } = fresh()._internal;
    const erreichbarkeit = PROBES.find((p) => p.key === "fred-erreichbarkeit");
    assert.ok(erreichbarkeit, "es muss eine Probe geben, die reine Erreichbarkeit ohne Serverberechnung prueft");
    assert.ok(/robots\.txt/.test(erreichbarkeit.url),
      "dafuer eignet sich eine winzige statische Datei - antwortet die schnell, liegt es an der CSV-Erzeugung, nicht am Netz");

    const api = PROBES.find((p) => p.key === "fred-api-erreichbarkeit");
    assert.ok(api && api.url.includes("api.stlouisfed.org"),
      "die offizielle API liegt auf einer anderen Subdomain und kann anders erreichbar sein");
    // Bewusst KEIN erwarteter Statuscode: ob FRED ohne Schluessel 400 oder 401
    // liefert, ist nicht sicher belegt, und ein falsch erwarteter Code faerbte
    // die Probe faelschlich rot. Entscheidend ist, DASS schnell geantwortet
    // wird - der Inhalt wird geprueft, nicht die Zahl.
    assert.strictEqual(api.expectStatus, undefined,
      "die Probe darf sich nicht auf einen unbelegten Statuscode festlegen");
    assert.strictEqual(api.expect('{"error_message":"Bad Request. The value for variable api_key is not registered."}'), null,
      "eine Antwort, die den fehlenden Schluessel benennt, ist das erwartete Ergebnis");
    assert.ok(api.expect("<html>irgendwas anderes</html>"),
      "eine voellig andere Antwortform muss auffallen");
    console.log("Block 13/15 (Proben trennen 'FRED langsam' von 'FRED nicht erreichbar'): OK");
  }

  // --- Die Frage, die keine einzelne Probe beantworten kann: KOMMT der
  //     Schluessel ueberhaupt an? Ein 400 "api_key is not set" beantwortet sie
  //     nicht - die zugehoerige Probe schickt bewusst keinen Schluessel. Ohne
  //     diese Uebersicht laesst sich "Schluessel fehlt" nicht von "Schluessel
  //     ist da, wird aber abgelehnt" unterscheiden: zwei verschiedene Probleme
  //     mit zwei verschiedenen Loesungen. ---
  {
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ observations: [{ date: "2026-08-01", value: "4.3" }] }),
    });
    delete process.env.FRED_API_KEY;
    const diag = fresh();

    const ohne = JSON.parse((await diag.handler({ httpMethod: "GET", queryStringParameters: { only: "fred-api" } })).body);
    const kOhne = ohne.konfiguration.find((k) => k.name === "FRED_API_KEY");
    assert.strictEqual(kOhne.gesetzt, false, "ohne Schluessel muss das auch so gemeldet werden");
    assert.ok(/fredaccount\.stlouisfed\.org/.test(kOhne.hinweis || ""),
      "und der Hinweis muss den Weg zum Schluessel nennen, nicht nur das Fehlen feststellen");
    assert.ok(!ohne.proben.some((p) => p.key === "fred-api-mit-schluessel"),
      "ohne Schluessel darf es die Schluesselprobe nicht geben - sie koennte nur rot sein und haette keinen Aussagewert");

    const mit = JSON.parse((await diag.handler({
      httpMethod: "GET",
      headers: { "x-fred-key": "einsehrgeheimerschluessel" },
      queryStringParameters: { only: "fred-api" },
    })).body);
    const kMit = mit.konfiguration.find((k) => k.name === "FRED_API_KEY");
    assert.strictEqual(kMit.gesetzt, true);
    assert.strictEqual(kMit.laenge, "einsehrgeheimerschluessel".length, "die Laenge hilft beim Erkennen eines abgeschnittenen Schluessels");
    assert.ok(/Startbildschirm/.test(kMit.quelle), "es muss erkennbar sein, WOHER der wirksame Schluessel kommt");

    const echteProbe = mit.proben.find((p) => p.key === "fred-api-mit-schluessel");
    assert.ok(echteProbe, "mit Schluessel muss er auch wirklich getestet werden - gesetzt heisst nicht gueltig");
    assert.ok(echteProbe.ok, "bei gueltiger Antwort muss die Probe gruen sein");

    // Das Entscheidende: der Wert selbst darf NIRGENDS in der Antwort stehen.
    const alles = JSON.stringify(mit);
    assert.ok(!alles.includes("einsehrgeheimerschluessel"),
      "der Schluessel darf in keinem Feld der Diagnose auftauchen - dieser Bericht wird im UI angezeigt");
    console.log("Block 14/15 (Diagnose meldet, OB ein Schluessel wirkt, ohne ihn preiszugeben): OK");
  }

  // --- Zweite Verteidigungslinie: manche Anbieter spiegeln den gesendeten
  //     Schluessel in ihrer Fehlermeldung zurueck ("invalid key: abc..."). Der
  //     Auszug landet sonst unveraendert im UI. ---
  {
    const geheim = "zurueckgespiegelterschluessel";
    global.fetch = async () => ({
      ok: false, status: 401,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error_message: "invalid api key: " + geheim }),
    });
    const diag = fresh();
    const body = JSON.parse((await diag.handler({
      httpMethod: "GET",
      headers: { "x-fred-key": geheim },
      queryStringParameters: { only: "fred-api-mit-schluessel" },
    })).body);
    const alles = JSON.stringify(body);
    assert.ok(!alles.includes(geheim),
      "ein vom Anbieter zurueckgespiegelter Schluessel muss herausgefiltert werden, bevor der Auszug im UI landet");
    assert.ok(alles.includes("***"), "und die Stelle muss als redigiert erkennbar bleiben, statt spurlos zu verschwinden");
    console.log("Block 15/15 (zurueckgespiegelte Schluessel werden aus dem Bericht entfernt): OK");
  }

  console.log("\nAlle diag.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
