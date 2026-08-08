// Netlify Function: /.netlify/functions/geopolitics
//
// Weltlage-Uebersicht (F6) aus zwei komplementaeren, kostenlosen Quellen
// OHNE API-Key:
//   - ReliefWeb (UN OCHA): aktuelle offizielle Krisenmeldungen je Land
//     (ein Aufruf, liefert gleichzeitig die dynamische Laenderliste)
//   - GDELT: Nachrichtenvolumen zu Konflikt-Schlagwoertern je Beobachtungsland
//     (mehrere Aufrufe, gestaffelt in Wellen mit hartem Zeitbudget)
//
// UNGETESTET gegen die echten APIs (kein Netzwerkzugriff in der Entwicklungs-
// umgebung). Beide Antwortformate werden defensiv geparst - unerwartete Formen
// fuehren zu leeren/neutralen Werten, nie zum Absturz.
//
// Lektion aus dem Makro-Tab (F4) direkt angewendet: NICHT alle Laender in
// einem Promise.all gleichzeitig abfragen (dann sieht keine Anfrage die
// Fehler der anderen, und ein haengender Anbieter blockiert alles gleich
// lang). Stattdessen Wellen + hartes Gesamt-Zeitbudget - was bis zum Budget
// nicht fertig ist, wird als "nicht geprueft" markiert statt zu haengen.

const { fetchWithTimeout } = require("./lib/providers");
const { flagEmoji, buildWatchlist } = require("./lib/geo-countries");

const CACHE = new Map(); const TTL = 20 * 60 * 1000; // 20 Min - Weltlage aendert sich nicht sekuendlich
const WAVE = 5;
const PER_REQUEST_TIMEOUT = 3000; // GDELT je Land
const RELIEFWEB_TIMEOUT = 3000;   // ReliefWeb-Sammelabruf (ein Aufruf fuer alle Laender)
// Deckt ReliefWeb UND alle GDELT-Wellen ZUSAMMEN ab, mit Sicherheitsabstand
// unter Netlifys 10s-Standardlimit fuer synchrone Functions. Vorher wurde die
// Frist erst NACH dem ReliefWeb-Aufruf gesetzt - dadurch konnte die Gesamtlaufzeit
// (bis zu RELIEFWEB_TIMEOUT + das alte GDELT-Budget) das Funktionslimit reissen,
// Netlify hat die Function dann hart abgebrochen und der Client sah nur einen
// generischen Fetch-Fehler ("ReliefWeb nie erreichbar" wirkte wie ein API-Ausfall,
// war aber ein serverseitiges Timeout).
const FUNCTION_BUDGET_MS = 8500;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// --- ReliefWeb: aktuelle Krisen je Land (ein Aufruf, appname statt Key) -----
async function fetchReliefWebOnce(url) {
  const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": UA } }, RELIEFWEB_TIMEOUT);
  if (!res.ok) {
    // Den Antwortkoerper mitnehmen: ReliefWeb schickt bei 4xx eine konkrete
    // Begruendung ("Invalid value ... for filter[value]" o.ae.). Ohne die stand
    // im UI nur "ReliefWeb HTTP 400" - was nicht sagt, WAS falsch ist.
    let detail = "";
    try { detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim(); } catch (_) {}
    const err = new Error(`ReliefWeb HTTP ${res.status}${detail ? " – " + detail : ""}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // v1 liefert {data:[...]}. Sollte v2 den Umschlag anders benennen, hier die
  // gaengigen Varianten mitnehmen, statt stillschweigend eine leere Liste
  // zurueckzugeben (was wie "keine Krisen weltweit" ausgesehen haette).
  if (Array.isArray(json && json.data)) return json.data;
  if (Array.isArray(json && json.results)) return json.results;
  if (Array.isArray(json && json.items)) return json.items;
  if (Array.isArray(json)) return json;
  throw new Error("ReliefWeb: unerwartetes Antwortformat, Schlüssel: " + (json && typeof json === "object" ? Object.keys(json).slice(0, 8).join(",") : typeof json));
}

function parseReliefWebItems(items) {
  // Pro Land die juengste Meldung behalten (Ergebnis ist bereits nach Datum sortiert)
  const byCountry = new Map();
  for (const item of items) {
    try {
      // v1 verpackt die Nutzdaten in item.fields. Falls v2 sie flach liefert,
      // faellt das hier auf item selbst zurueck - so funktioniert derselbe
      // Parser fuer beide Antwortformen.
      const f = item.fields || item || {};
      // country kann Objekt oder Array sein - beides zulassen.
      const rawCountry = f.country;
      const countries = Array.isArray(rawCountry) ? rawCountry : (rawCountry ? [rawCountry] : []);
      const country = countries.find((c) => c && c.iso3) || countries[0];
      if (!country || !country.iso3) continue;
      const iso3 = String(country.iso3).toUpperCase();
      if (byCountry.has(iso3)) continue; // erste (=juengste) Meldung je Land behalten
      const rawType = f.type;
      const types = Array.isArray(rawType) ? rawType : (rawType ? [rawType] : []);
      const typeName = types[0] ? (types[0].name || null) : null;
      const created = f.date && (f.date.created || f.date.changed);
      byCountry.set(iso3, {
        iso3, iso2: country.iso2 ? String(country.iso2).toUpperCase() : null, name: country.name || iso3,
        reliefwebActive: true, reliefwebType: typeName, reliefwebHeadline: f.name || null,
        reliefwebDate: created ? String(created).slice(0, 10) : null,
      });
    } catch (_) { /* einzelnen kaputten Eintrag ueberspringen, Rest verarbeiten */ }
  }
  return byCountry;
}

// API-VERSION: v1 ist abgeschaltet.
// Live-Beleg aus dem Diagnose-Endpunkt auf der echten Netlify-Instanz:
//   HTTP 410 – {"error":{"type":"Exception","message":"The API version 'v1' has
//   been decommissioned. Please use version 'v2' instead."}}
// Deshalb v2 als Hauptpfad. v1 wird NICHT mehr angefragt - ein 410 ist endgueltig
// und ein weiterer Versuch waere reine Zeitverschwendung.
// Live-Beleg aus dem Diagnose-Endpunkt: "country.iso2" wurde mit HTTP 400
// "Unrecognized field 'country.iso2' in parameter 'fields'" abgelehnt - dieses
// Feld gibt es im ReliefWeb-v2-Schema nicht (nur country.iso3). War der Grund,
// warum sowohl der gefilterte als auch der ungefilterte Pfad scheiterten -
// beide enthielten dasselbe ungueltige Feld.
const RELIEFWEB_FIELDS =
  "&fields[include][]=name&fields[include][]=date.created&fields[include][]=type.name"
  + "&fields[include][]=country.iso3&fields[include][]=country.name";
// Live-Beleg: die feldlose Rueckfallebene (RELIEFWEB_MINIMAL) lieferte HTTP 403
// "You are not using an approved appname. Kindly request an approved appname
// here: https://apidoc.reliefweb.int/apidoc" - ReliefWeb v2 verlangt inzwischen
// einen VORAB REGISTRIERTEN Appnamen (anders als v1, wo ein beliebiger String
// genuegte). Das ist kein Fehler in unserer Anfrageform, sondern eine externe
// Registrierung, die kein Code-Fix umgehen kann. Ueber Umgebungsvariable
// konfigurierbar, damit ein spaeter genehmigter Appname per Netlify-Env ohne
// Redeploy eingetragen werden kann.
const RELIEFWEB_APPNAME = process.env.RELIEFWEB_APPNAME || "terminal-app-geopolitics";
const RELIEFWEB_BASE = "https://api.reliefweb.int/v2/disasters"
  + "?appname=" + encodeURIComponent(RELIEFWEB_APPNAME)
  + RELIEFWEB_FIELDS
  + "&sort[]=date.created:desc&limit=100";
// Statuswerte des disasters-Endpunkts: "alert", "ongoing", "past".
const RELIEFWEB_FILTERED = RELIEFWEB_BASE + "&filter[field]=status&filter[value][]=alert&filter[value][]=ongoing";
// Ohne fields[include]: falls v2 die Feldauswahl anders benennt, liefert die
// nackte Abfrage immer noch verwertbare Datensaetze (nur groesser).
const RELIEFWEB_MINIMAL = "https://api.reliefweb.int/v2/disasters?appname=" + encodeURIComponent(RELIEFWEB_APPNAME) + "&limit=100";

async function fetchReliefWeb() {
  const attempts = [];
  // Reihenfolge: praezise gefiltert -> ungefiltert -> ohne Feldauswahl.
  // Jede Stufe ist etwas schlechter als die vorige, aber jede ist deutlich
  // besser als gar keine ReliefWeb-Daten.
  for (const url of [RELIEFWEB_FILTERED, RELIEFWEB_BASE, RELIEFWEB_MINIMAL]) {
    try {
      return parseReliefWebItems(await fetchReliefWebOnce(url));
    } catch (e) {
      attempts.push(String((e && e.message) || e));
      // Nur bei Problemen mit der ANFRAGEFORM lohnt eine andere Abfrageform.
      // Ausdruecklich NICHT bei:
      //   410 - Version endgueltig abgeschaltet: gilt fuer jede Abfrageform
      //         derselben Version, ein weiterer Versuch ist reine Zeitverschwendung
      //   401/403 - Berechtigung fehlt: aendert sich durch andere Parameter nicht
      //   Timeouts/5xx - Gegenstelle ist das Problem, nicht die Anfrage
      const s = e && e.status;
      const retryable = s === 400 || s === 404 || s === 422;
      if (!retryable) break;
    }
  }
  throw new Error(attempts.join(" | "));
}

// --- GDELT: Nachrichtenvolumen zu Konflikt-Schlagwoertern je Land ----------
const CONFLICT_KEYWORDS = "(war OR conflict OR military OR clashes OR offensive OR strikes OR ceasefire OR attack)";
async function fetchGdeltFor(country) {
  const q = `"${country.name}" ${CONFLICT_KEYWORDS}`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=10&timespan=3d&format=json&sort=datedesc`;
  const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": UA } }, PER_REQUEST_TIMEOUT);
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const json = await res.json();
  const articles = (Array.isArray(json && json.articles) ? json.articles : []).filter((a) => a && a.title && a.url);
  // count = tatsaechliches Artikelvolumen (fuer die Risikostufe), headlines =
  // nur die ersten 3 zur Anzeige - beide bewusst getrennt, damit das Kappen
  // der Anzeige nicht versehentlich auch die Score-Berechnung deckelt.
  return {
    count: articles.length,
    headlines: articles.slice(0, 3).map((a) => ({ title: a.title, url: a.url, date: a.seendate ? String(a.seendate).slice(0, 8) : null, source: a.domain || "" })),
  };
}

function computeLevel(gdeltCount, reliefwebActive) {
  if (reliefwebActive && gdeltCount >= 5) return "kritisch";
  if (reliefwebActive || gdeltCount >= 5) return "hoch";
  if (gdeltCount >= 2) return "mittel";
  if (gdeltCount >= 1) return "niedrig";
  return "keine";
}

async function buildReport() {
  // Ab Funktionsstart, nicht erst nach ReliefWeb - siehe Kommentar bei FUNCTION_BUDGET_MS.
  const deadline = Date.now() + FUNCTION_BUDGET_MS;

  let rwByCountry = new Map(); let rwError = null;
  try { rwByCountry = await fetchReliefWeb(); } catch (e) { rwError = String(e && e.message || e); }

  const watchlist = buildWatchlist(Array.from(rwByCountry.values()));
  const out = {};

  for (let i = 0; i < watchlist.length; i += WAVE) {
    // Nicht nur pruefen ob das Budget JETZT schon ueberschritten ist, sondern ob
    // eine weitere Welle (die selbst bis zu PER_REQUEST_TIMEOUT dauern darf) noch
    // hineinpasst - sonst startet die letzte Welle knapp vor der Deadline und
    // reisst das Gesamtbudget trotzdem.
    if (Date.now() + PER_REQUEST_TIMEOUT > deadline) {
      for (const c of watchlist.slice(i)) {
        const rw = rwByCountry.get(c.iso3) || null;
        out[c.iso3] = baseEntry(c, rw, null, "nicht geprüft (Zeitbudget erreicht)");
      }
      break;
    }
    const wave = watchlist.slice(i, i + WAVE);
    const settled = await Promise.all(wave.map(async (c) => {
      const rw = rwByCountry.get(c.iso3) || null;
      try { return { c, rw, gdelt: await fetchGdeltFor(c) }; }
      catch (e) { return { c, rw, gdelt: null, err: String(e && e.message || e) }; }
    }));
    for (const r of settled) out[r.c.iso3] = baseEntry(r.c, r.rw, r.gdelt, r.err || null);
  }

  return { countries: out, reliefwebError: rwError, generatedAt: new Date().toISOString() };
}

function baseEntry(c, rw, gdelt, error) {
  const reliefwebActive = !!(rw && rw.reliefwebActive);
  const gdeltCount = gdelt ? gdelt.count : 0;
  return {
    iso3: c.iso3, iso2: c.iso2 || (rw && rw.iso2) || null, name: c.name || (rw && rw.name) || c.iso3,
    flag: flagEmoji(c.iso2 || (rw && rw.iso2)),
    level: gdelt === null && error ? "nicht geprüft" : computeLevel(gdeltCount, reliefwebActive),
    gdeltCount, headlines: gdelt ? gdelt.headlines : [],
    reliefwebActive, reliefwebType: rw ? rw.reliefwebType : null, reliefwebHeadline: rw ? rw.reliefwebHeadline : null, reliefwebDate: rw ? rw.reliefwebDate : null,
    error: error || null,
  };
}

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const cached = CACHE.get("report");
  if (cached && Date.now() - cached.ts < TTL) return { statusCode: 200, headers: { ...cors, "X-Cache": "hit" }, body: JSON.stringify(cached.data) };

  try {
    const data = await buildReport();
    CACHE.set("report", { ts: Date.now(), data });
    return { statusCode: 200, headers: { ...cors, "X-Cache": "miss" }, body: JSON.stringify(data) };
  } catch (e) {
    if (cached) return { statusCode: 200, headers: { ...cors, "X-Cache": "stale" }, body: JSON.stringify(cached.data) };
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};

// Fuer Tests: Einzelfunktionen ohne HTTP-Handler-Wrapper zugaenglich machen.
exports._internal = { computeLevel, baseEntry, buildReport };
