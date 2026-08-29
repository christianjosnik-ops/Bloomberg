// fred.test.js — Unit-Tests fuer die Makrodaten-Function (F4 MAKRO).
// Kein Test-Framework, nur Node + assert:  node fred.test.js
// Alle HTTP-Aufrufe hier sind gefakt - es geht um die Fallback-Kette und das
// Zeitbudget, nicht um echte FRED-Antworten (dafuer fehlt in dieser Umgebung
// der Netzwerkzugriff).
//
// DBnomics gibt es hier nicht mehr - per Live-Diagnose nachweislich tot
// ("Could not find storage directory for provider 'FRED'", beide Pfadformen).
// Die entsprechenden Tests wurden entfernt statt an einen toten Provider
// angepasst zu werden.

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
    console.log("Block 1/19 (fromFredCsv: CSV korrekt geparst): OK");
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
    console.log("Block 2/19 (fetchOne: erschoepftes Budget -> kein Netzwerkzugriff): OK");
  }

  // --- fetchOne: Provider-Timeouts werden auf die RESTZEIT gekappt, nicht die vollen Standardwerte ---
  {
    providers._resetBreakers();
    global.fetch = async (url, opts) => new Promise((_, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const { fetchOne } = freshHandler()._internal;
    const deadline = Date.now() + 900; // deutlich unter FRED_CSV_TIMEOUT (3000)
    const t0 = Date.now();
    const result = await fetchOne("CPIAUCSL", null, deadline);
    const dt = Date.now() - t0;
    console.log("  Dauer bei haengenden Providern und 0.9s Restbudget:", (dt / 1000).toFixed(2) + "s");
    assert.ok(dt < 1400, "Provider-Timeouts muessen auf die Restzeit gekappt werden, nicht auf die vollen 3s/2.5s-Standardwerte laufen");
    assert.ok(result.error, "muss trotzdem einen Fehler statt eines Haengers liefern");
    console.log("Block 3/19 (fetchOne: Provider-Timeouts an Restbudget gekappt): OK");
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
    console.log("Block 4/19 (Handler: Zeitbudget schuetzt ueber alle Wellen hinweg): OK");
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
    console.log("Block 5/19 (Handler: Cache verhindert erneuten Netzwerkzugriff): OK");
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
    console.log("Block 6/19 (FRED: HTML-Sperrseite trotz Status 200 wird erkannt): OK");
  }

  // --- FRED 4xx: der Antwortkoerper ist die eigentliche Begruendung ---
  {
    providers._resetBreakers();
    global.fetch = async () => ({ ok: false, status: 403, text: async () => "Access denied for automated clients" });
    const { fromFredCsv } = freshHandler()._internal;
    let msg = null;
    try { await fromFredCsv("UNRATE", 10, 3000); } catch (e) { msg = e.message; }
    assert.ok(/403/.test(msg) && /Access denied/.test(msg), "Status UND Begruendung muessen in der Meldung stehen");
    console.log("Block 7/19 (FRED: Fehlertext des Servers bleibt erhalten): OK");
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
    console.log("Block 8/19 (FRED: CRLF-Zeilenenden und fehlende Werte): OK");
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
    console.log("Block 9/19 (Sammelabruf: eine Anfrage, Spalten sauber getrennt): OK");
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
    console.log("Block 10/19 (Sammelabruf: Zuordnung ueber die Kopfzeile): OK");
  }

  // --- Handler: EIN Sammelabruf JE FREQUENZGRUPPE deckt alle zehn Serien ab.
  //
  // Frueher war es ein einziger gemischter Abruf. Das war schnell, aber
  // riskant: fredgraph muss Serien unterschiedlicher Frequenz in einem
  // Diagramm auf eine gemeinsame Zeitachse bringen und koennte dabei
  // aggregieren - eine Tagesrendite kaeme dann als Quartalsmittel zurueck,
  // ohne dass irgendetwas nach Fehler aussieht. Innerhalb einer Frequenzgruppe
  // kann das nicht passieren.
  //
  // Der Test nagelt beides fest: die Gruppierung selbst UND dass sie wenige
  // Abrufe bleibt (nicht zehn einzelne, was die urspruengliche Timeout-Ursache
  // war). ---
  {
    providers._resetBreakers();
    const angefragt = ["UNRATE", "CPIAUCSL", "FEDFUNDS", "DGS10", "T10Y2Y", "GDP", "PAYEMS", "UMCSENT", "MORTGAGE30US", "M2SL"];
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      // Nur die IDs zurueckgeben, die tatsaechlich angefragt wurden - so faellt
      // auf, wenn die Gruppierung IDs verliert oder doppelt anfragt.
      const m = String(url).match(/[?&]id=([^&]+)/);
      const ids = decodeURIComponent(m[1]).split(",");
      const rows = ["DATE," + ids.join(",")];
      for (let d = 1; d <= 3; d++) rows.push(`2026-0${d}-01,` + ids.map((_, k) => (d + k).toFixed(1)).join(","));
      return { ok: true, status: 200, text: async () => rows.join("\n") };
    };
    const fred = freshHandler();
    const { freqOf } = fred._internal;
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: angefragt.join(",") } });

    // Jede URL darf nur Serien EINER Frequenz enthalten - das ist der Kern.
    const gruppenJeUrl = urls.map((u) => {
      const ids = decodeURIComponent(u.match(/[?&]id=([^&]+)/)[1]).split(",");
      return { ids, freqs: [...new Set(ids.map(freqOf))] };
    });
    for (const g of gruppenJeUrl) {
      assert.strictEqual(g.freqs.length, 1,
        `ein Sammelabruf darf nur Serien einer Frequenz buendeln, hier gemischt: ${g.ids.join(",")} (${g.freqs.join(" + ")})`);
    }
    assert.ok(urls.length <= 4, `zehn Serien duerfen hoechstens vier Abrufe kosten (je Frequenzgruppe einen), gemessen: ${urls.length}`);

    // Keine Serie darf verlorengehen oder doppelt angefragt werden.
    const alleIds = gruppenJeUrl.flatMap((g) => g.ids);
    assert.deepStrictEqual([...alleIds].sort(), [...angefragt].sort(), "die Gruppierung muss genau die angefragten Serien abdecken, ohne Verluste oder Dubletten");

    const body = JSON.parse(res.body);
    assert.strictEqual(Object.keys(body).length, 10);
    assert.ok(Object.values(body).every((v) => v && !v.error && v.latest != null), "alle zehn Serien muessen Daten haben");
    assert.strictEqual(body.UNRATE.source, "fred");
    console.log(`Block 11/19 (Handler: ${urls.length} Sammelabrufe, je Frequenzgruppe einer, keine Mischung): OK`);
  }

  // --- Teilabdeckung: FRED laesst eine unbekannte ID stillschweigend aus der
  //     Kopfzeile weg. Ohne Hinweis landeten die fehlenden Serien wortlos in
  //     den langsamen Einzelabrufen - und bei vielen davon reisst das
  //     Zeitbudget, ohne dass je klar wuerde warum. ---
  {
    providers._resetBreakers();
    // Beide Serien sind monatlich, landen also in DERSELBEN Gruppe - nur so
    // entsteht ueberhaupt eine Teilabdeckung. CPIAUCSL wird weggelassen, genau
    // wie FRED es bei einer getilgten Serie tut: Antwort gueltig, Spalte fehlt.
    global.fetch = async (url) => {
      const ids = decodeURIComponent(String(url).match(/[?&]id=([^&]+)/)[1]).split(",");
      const geliefert = ids.filter((id) => id !== "CPIAUCSL");
      if (!geliefert.length) return { ok: true, status: 200, text: async () => "DATE\n2026-01-01\n2026-02-01\n" };
      const rows = ["DATE," + geliefert.join(",")];
      for (let d = 1; d <= 3; d++) rows.push(`2026-0${d}-01,` + geliefert.map(() => "4.0").join(","));
      return { ok: true, status: 200, text: async () => rows.join("\n") };
    };
    const fred = freshHandler();
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE,CPIAUCSL" } });
    const body = JSON.parse(res.body);
    assert.ok(body.UNRATE && !body.UNRATE.error, "die gelieferte Serie derselben Gruppe muss unberuehrt durchkommen");
    const text = JSON.stringify(body);
    assert.ok(/CPIAUCSL/.test(text) && /keine Spalte/.test(text),
      "die weggelassene Serie muss namentlich benannt werden, statt wortlos in die Einzelabrufe zu rutschen: " + (body.CPIAUCSL && body.CPIAUCSL.error));
    console.log("Block 11b/19 (Teilabdeckung innerhalb einer Frequenzgruppe wird benannt): OK");
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
    console.log("Block 12/19 (Handler: Grund des Sammel-Fehlschlags bleibt sichtbar): OK");
  }

  // --- Euro-Raum-Serien (ueber FRED gespiegelte Eurostat-/EZB-Reihen) laufen
  //     durch dieselbe Sammelabruf-Pipeline wie US-Serien - keine
  //     Sonderbehandlung. Die IDs werden aus market-data.js gezogen statt hier
  //     abgeschrieben: sonst prueft der Test irgendwann Serien, die die App
  //     laengst nicht mehr abfragt (genau das war hier schon einmal der Fall). ---
  {
    providers._resetBreakers();
    const md = require("./market-data.js");
    const euroIds = md.EURO_MACRO_PRESETS.map((m) => m.id);
    // Je Serie ein eigener Wert, damit eine Vertauschung auffiele.
    const wert = { ECBDFR: 3.75, CP0000EZ19M086NEST: 132.4, IRLTLT01DEM156N: 2.48, CLVMEURSCAB1GQEA19: 3010 };
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      const ids = decodeURIComponent(String(url).match(/[?&]id=([^&]+)/)[1]).split(",");
      const zeilen = ["DATE," + ids.join(",")];
      for (const tag of ["2026-05-01", "2026-06-01"]) zeilen.push(tag + "," + ids.map((id) => wert[id]).join(","));
      return { ok: true, status: 200, text: async () => zeilen.join("\n") };
    };
    const fred = freshHandler();
    const { freqOf } = fred._internal;
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: euroIds.join(",") } });

    // Kein Abruf darf Frequenzen mischen - dieselbe Regel wie bei den US-Serien.
    for (const u of urls) {
      const ids = decodeURIComponent(u.match(/[?&]id=([^&]+)/)[1]).split(",");
      assert.strictEqual(new Set(ids.map(freqOf)).size, 1, `gemischte Frequenzen in einem Euro-Abruf: ${ids.join(",")}`);
    }
    assert.ok(urls.length <= euroIds.length, "die Gruppierung darf nicht mehr Abrufe erzeugen als es Serien gibt");

    const body = JSON.parse(res.body);
    euroIds.forEach((id) => {
      assert.ok(body[id], `Serie ${id} fehlt in der Antwort`);
      assert.strictEqual(body[id].latest, wert[id], `letzter Wert von ${id} - eine Verwechslung zwischen den Gruppen faellt hier auf`);
      assert.strictEqual(body[id].source, "fred", "Quelle bleibt einheitlich 'fred', kein separater EZB-Provider noetig");
    });
    console.log(`Block 13/19 (Euro-Serien: ${urls.length} Abrufe nach Frequenz, Werte korrekt zugeordnet): OK`);
  }

  // --- Eingestellte Serie: FRED liefert weiter HTTP 200 und gueltiges CSV,
  //     nur eben mit jahrealten Werten. Genau so ist LRHUTTTTEZM156S
  //     (Euro-Arbeitslosenquote, endet Januar 2023) monatelang als frischer
  //     Wert im UI gestanden - ohne Fehler, ohne Warnung, schlicht falsch. ---
  {
    providers._resetBreakers();
    const jetzt = Date.parse("2026-08-28T00:00:00Z");
    const { shapeSeries } = freshHandler()._internal;

    const tot = shapeSeries("UNRATE", [{ t: "2022-12-01", v: 6.6 }, { t: "2023-01-01", v: 6.7 }], jetzt);
    assert.strictEqual(tot.outdated, true, "eine seit drei Jahren stehende Monatsserie MUSS als nicht aktuell markiert sein");
    assert.ok(tot.ageDays > 1000, "das Alter gehoert in die Antwort, damit das UI es benennen kann");
    assert.ok(/eingestellt/.test(tot.outdatedNote), "die Meldung muss den Verdacht benennen, nicht nur eine Zahl liefern");
    assert.strictEqual(tot.latest, 6.7, "der Wert bleibt erhalten - er ist alt, nicht falsch");

    // Normale Veroeffentlichungsverzoegerung darf NICHT anschlagen, sonst waere
    // die Warnung wertlos, weil sie staendig erscheint - und wuerde genau den
    // einen Fall verdecken, fuer den sie gedacht ist.
    const frisch = shapeSeries("UNRATE", [{ t: "2026-06-01", v: 4.1 }, { t: "2026-07-01", v: 4.2 }], jetzt);
    assert.ok(!frisch.outdated, "US-Monatsdaten mit knapp zwei Monaten Verzug sind der Normalfall");

    // Eurostat veroeffentlicht spaeter als US-Behoerden - auch das muss ohne
    // Warnung durchgehen, sonst steht bei den Euro-Kacheln dauerhaft ein Hinweis.
    const euStat = shapeSeries("CP0000EZ19M086NEST", [{ t: "2026-04-01", v: 131.9 }, { t: "2026-05-01", v: 132.4 }], jetzt);
    assert.ok(!euStat.outdated, `Euro-HVPI vom Mai ist Ende August normal (${euStat.ageDays} Tage), darf nicht als eingestellt gelten`);

    const quartal = shapeSeries("CLVMEURSCAB1GQEA19", [{ t: "2026-01-01", v: 3000 }, { t: "2026-04-01", v: 3010 }], jetzt);
    assert.ok(!quartal.outdated, "Quartalsdaten erscheinen noch spaeter - die Schwelle muss das beruecksichtigen");

    const taeglich = shapeSeries("DGS10", [{ t: "2026-08-01", v: 4.1 }, { t: "2026-08-04", v: 4.2 }], jetzt);
    assert.strictEqual(taeglich.outdated, true, "eine Tagesserie mit 24 Tagen Luecke ist auffaellig");
    console.log("Block 14/19 (eingestellte Serien werden erkannt, normaler Verzug nicht): OK");
  }

  // --- Kein Auseinanderlaufen zwischen Presets und Aktualitaetsschwellen:
  //     wer eine Kachel ergaenzt, ohne MAX_AGE_DAYS zu pflegen, bekommt still
  //     die 400-Tage-Rueckfallschwelle - womit genau die Serien unbemerkt
  //     durchrutschen, fuer die die Pruefung gedacht ist. ---
  {
    const { MAX_AGE_DAYS, MAX_AGE_FALLBACK_DAYS } = freshHandler()._internal;
    const md = require("./market-data.js");
    const fehlend = md.MACRO_PRESETS.map((m) => m.id).filter((id) => MAX_AGE_DAYS[id] == null);
    assert.deepStrictEqual(fehlend, [],
      "fuer diese Makro-Serien fehlt eine Aktualitaetsschwelle in fred.js (sie liefen sonst still in die " + MAX_AGE_FALLBACK_DAYS + "-Tage-Rueckfallschwelle): " + fehlend.join(", "));

    // Dasselbe fuer die Frequenztabelle: eine Serie ohne Eintrag bekommt eine
    // eigene Gruppe (unbekannt:ID) und damit einen zusaetzlichen Netzwerkabruf.
    // Das ist sicher, aber verschwenderisch - und ein stiller Hinweis darauf,
    // dass jemand eine Kachel ergaenzt hat, ohne die Frequenz zu pflegen.
    const { SERIES_FREQ } = freshHandler()._internal;
    const ohneFrequenz = md.MACRO_PRESETS.map((m) => m.id).filter((id) => SERIES_FREQ[id] == null);
    assert.deepStrictEqual(ohneFrequenz, [],
      "fuer diese Makro-Serien fehlt die Frequenzangabe in SERIES_FREQ, sie kosten dadurch je einen eigenen Abruf: " + ohneFrequenz.join(", "));

    // Die Function kappt bei 20 IDs. Solange die Presets darunter bleiben, ist
    // das folgenlos - waechst die Liste darueber hinaus, muss es auffallen
    // statt in stillen "—"-Kacheln zu enden.
    assert.ok(md.MACRO_PRESETS.length <= 20,
      `es gibt ${md.MACRO_PRESETS.length} Makro-Kacheln, die Function ruft aber hoechstens 20 Serien ab - die uebrigen blieben leer`);

    assert.strictEqual(md.EURO_MACRO_PRESETS.length, 4);
    assert.ok(!md.MACRO_PRESETS.some((m) => m.id === "LRHUTTTTEZM156S"),
      "die eingestellte OECD-Arbeitslosenserie darf nicht zurueckkehren - sie endet im Januar 2023");
    console.log("Block 15/19 (jede Makro-Kachel hat gepflegte Aktualitaetsschwelle und Frequenz): OK");
  }

  // --- Ueberzaehlige IDs werden benannt, nicht stillschweigend abgeschnitten ---
  {
    providers._resetBreakers();
    global.fetch = async (url) => {
      const ids = decodeURIComponent(String(url).match(/[?&]id=([^&]+)/)[1]).split(",");
      const zeilen = ["DATE," + ids.join(",")];
      for (const t of ["2026-05-01", "2026-06-01"]) zeilen.push(t + "," + ids.map(() => "1.0").join(","));
      return { ok: true, status: 200, text: async () => zeilen.join("\n") };
    };
    const fred = freshHandler();
    // 22 Serien anfragen - zwei mehr als die Obergrenze.
    const viele = Array.from({ length: 22 }, (_, i) => "SERIE" + i);
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: viele.join(",") } });
    const body = JSON.parse(res.body);
    assert.ok(body.SERIE20 && /mehr als 20/.test(body.SERIE20.error),
      "die 21. Serie muss einen erklaerenden Eintrag bekommen statt wortlos zu fehlen");
    assert.ok(body.SERIE21 && body.SERIE21.error, "ebenso die 22.");
    assert.ok(body.SERIE0 && !body.SERIE0.error, "die ersten 20 muessen normal geliefert werden");
    console.log("Block 16/19 (ueberzaehlige Serien werden benannt statt still abgeschnitten): OK");
  }

  // --- Offizielle FRED-API als bevorzugter Weg, wenn ein Schluessel vorliegt.
  //     Anlass: im Livebetrieb lief JEDE Anfrage an fred.stlouisfed.org in einen
  //     Timeout - auch die winzige Einzelserie. Der fredgraph-Endpunkt ist die
  //     Download-Funktion der Weboberflaeche, keine Schnittstelle. Die offizielle
  //     API liegt auf einer anderen Subdomain und ist als solche ausgelegt. ---
  {
    providers._resetBreakers();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      return {
        ok: true, status: 200,
        json: async () => ({ observations: [
          { date: "2026-05-01", value: "4.0" },
          { date: "2026-06-01", value: "." },   // fehlende Werte gibt es auch hier
          { date: "2026-07-01", value: "4.2" },
        ] }),
      };
    };
    process.env.FRED_API_KEY = "test-schluessel";
    const fred = freshHandler();
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE,GDP" } });
    delete process.env.FRED_API_KEY;

    assert.ok(urls.every((u) => u.includes("api.stlouisfed.org")),
      "mit Schluessel muss die offizielle API genutzt werden, nicht der fredgraph-Endpunkt: " + urls[0]);
    assert.ok(!urls.some((u) => u.includes("fredgraph")), "der langsame Weboberflaechen-Download darf dann gar nicht mehr angefasst werden");
    const body = JSON.parse(res.body);
    assert.strictEqual(body.UNRATE.latest, 4.2, "letzter Wert aus der API-Antwort");
    assert.strictEqual(body.UNRATE.series.length, 2, 'Beobachtungen mit "." muessen uebersprungen werden');
    assert.strictEqual(body.UNRATE.source, "fred-api", "die Herkunft muss unterscheidbar bleiben");
    assert.ok(body.GDP && !body.GDP.error, "auch die zweite Serie muss kommen - die API kennt keinen Sammelabruf, also je Serie eine Anfrage");
    console.log("Block 17/19 (mit FRED_API_KEY laeuft alles ueber die offizielle API): OK");
  }

  // --- Der Schluessel gehoert in den Authorization-Header, nicht in die URL.
  //     In der URL landete er in Server-Logs, Referrern und - schlimmer noch -
  //     in unseren eigenen Fehlermeldungen, die im UI angezeigt werden. ---
  {
    providers._resetBreakers();
    const gesehen = [];
    global.fetch = async (url, opts) => {
      gesehen.push({ url: String(url), headers: (opts && opts.headers) || {} });
      return { ok: true, status: 200, json: async () => ({ observations: [{ date: "2026-07-01", value: "4.2" }, { date: "2026-08-01", value: "4.3" }] }) };
    };
    process.env.FRED_API_KEY = "geheim123";
    const fred = freshHandler();
    await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE" } });
    delete process.env.FRED_API_KEY;

    assert.strictEqual(gesehen[0].headers["Authorization"], "Bearer geheim123",
      "der Schluessel muss im Authorization-Header stehen - so verlangt es die FRED-API v2");
    assert.ok(!gesehen[0].url.includes("geheim123"),
      "und NICHT in der URL: dort landete er in Logs, Referrern und in unseren eigenen Fehlermeldungen");
    console.log("Block 18/19 (Schluessel im Authorization-Header, nicht in der URL): OK");
  }

  // --- Ohne Schluessel ist der Fehlschlag seit November 2025 der Normalfall.
  //     Dann darf im UI nicht bloss "Zeitueberschreitung" stehen - das klingt
  //     nach einem voruebergehenden Problem, obwohl es ein dauerhaftes ist,
  //     das in zwei Minuten selbst behoben werden kann. ---
  {
    providers._resetBreakers();
    delete process.env.FRED_API_KEY;
    global.fetch = async (url, opts) => new Promise((_, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const fred = freshHandler();
    const res = await fred.handler({ httpMethod: "GET", queryStringParameters: { ids: "UNRATE" } });
    const body = JSON.parse(res.body);
    assert.ok(body.UNRATE.error, "ohne Schluessel und ohne Antwort muss ein Fehler stehen");
    assert.ok(/FRED_API_KEY/.test(body.UNRATE.error),
      "die Meldung muss die noetige Umgebungsvariable benennen: " + body.UNRATE.error);
    assert.ok(/fredaccount\.stlouisfed\.org\/apikey/.test(body.UNRATE.error),
      "und den Weg zum kostenlosen Schluessel nennen - sonst weiss niemand, wie er F4 wieder zum Laufen bringt");
    console.log("Block 19/19 (ohne Schluessel nennt die Meldung Ursache und Abhilfe): OK");
  }

  console.log("\nAlle fred.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message, "\n" + e.stack); process.exit(1); });
