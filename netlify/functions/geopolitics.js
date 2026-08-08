// Netlify Function: /.netlify/functions/geopolitics
//
// Weltlage-Uebersicht (F6) aus mehreren kostenlosen Quellen OHNE API-Key:
//   - UCDP (Uppsala Conflict Data Program): offene, schluessellose Konflikt-
//     ereignisse je Land - liefert die dynamische Laenderliste (Hauptquelle)
//   - ReliefWeb (UN OCHA): zusaetzliche Krisenmeldungen, ABER nur aktiv, wenn
//     RELIEFWEB_APPNAME gesetzt ist (siehe Kommentar bei fetchReliefWeb)
//   - GDELT: Nachrichtenvolumen zu Konflikt-Schlagwoertern je Beobachtungsland
//     (mehrere Aufrufe, gestaffelt in Wellen mit hartem Zeitbudget)
//
// WARUM UCDP JETZT DIE HAUPTQUELLE IST: Live-Diagnose auf der echten Netlify-
// Instanz zeigte, dass ReliefWeb v2 einen VORAB REGISTRIERTEN Appnamen verlangt
// (HTTP 403 "not using an approved appname") - ohne Registrierung durch den
// Betreiber ist ReliefWeb also grundsaetzlich blockiert, unabhaengig von der
// Anfrageform. UCDP ist eine offen zugaengliche akademische Quelle ohne
// Zugangsbeschraenkung und passt inhaltlich besser (Konfliktdaten statt
// allgemeiner Katastrophenmeldungen).
//
// UNGETESTET gegen die echten APIs (kein Netzwerkzugriff in der Entwicklungs-
// umgebung). Alle Antwortformate werden defensiv geparst - unerwartete Formen
// fuehren zu leeren/neutralen Werten, nie zum Absturz. UCDPs genaues
// Versions-/Pfadschema konnte nicht live geprueft werden, deshalb zwei
// plausible Kandidaten (siehe UCDP_CANDIDATES) - der Diagnose-Endpunkt zeigt,
// welcher (falls ueberhaupt einer) traegt.
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
const UCDP_TIMEOUT = 3000;        // je Kandidat (siehe UCDP_CANDIDATES)
// Deckt ReliefWeb UND alle GDELT-Wellen ZUSAMMEN ab, mit Sicherheitsabstand
// unter Netlifys 10s-Standardlimit fuer synchrone Functions. Vorher wurde die
// Frist erst NACH dem ReliefWeb-Aufruf gesetzt - dadurch konnte die Gesamtlaufzeit
// (bis zu RELIEFWEB_TIMEOUT + das alte GDELT-Budget) das Funktionslimit reissen,
// Netlify hat die Function dann hart abgebrochen und der Client sah nur einen
// generischen Fetch-Fehler ("ReliefWeb nie erreichbar" wirkte wie ein API-Ausfall,
// war aber ein serverseitiges Timeout).
const FUNCTION_BUDGET_MS = 8500;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// --- UCDP: Konfliktereignisse je Land (Hauptquelle, kein Key/Appname noetig) ---
//
// UCDP verwendet fuer manche Staaten historisch bedingte Namensformen
// (z.B. "DR Congo (Zaire)", "Myanmar (Burma)"). Handkuratierte Alias-Tabelle,
// bewusst nicht erschoepfend (wie FIXED_WATCHLIST in geo-countries.js) -
// ein unbekannter Name wird uebersprungen statt einem falschen Land
// zugeordnet zu werden. Deckt die aktuell/dauerhaft relevanten Konfliktzonen ab.
const UCDP_COUNTRY_ALIASES = {
  "russia (soviet union)": { iso3: "RUS", iso2: "RU", name: "Russia" },
  "russia": { iso3: "RUS", iso2: "RU", name: "Russia" },
  "ukraine": { iso3: "UKR", iso2: "UA", name: "Ukraine" },
  "israel": { iso3: "ISR", iso2: "IL", name: "Israel" },
  "palestine": { iso3: "PSE", iso2: "PS", name: "Palestine" },
  "lebanon": { iso3: "LBN", iso2: "LB", name: "Lebanon" },
  "syria": { iso3: "SYR", iso2: "SY", name: "Syria" },
  "china": { iso3: "CHN", iso2: "CN", name: "China" },
  "taiwan": { iso3: "TWN", iso2: "TW", name: "Taiwan" },
  "north korea": { iso3: "PRK", iso2: "KP", name: "North Korea" },
  "south korea": { iso3: "KOR", iso2: "KR", name: "South Korea" },
  "india": { iso3: "IND", iso2: "IN", name: "India" },
  "pakistan": { iso3: "PAK", iso2: "PK", name: "Pakistan" },
  "iran": { iso3: "IRN", iso2: "IR", name: "Iran" },
  "iraq": { iso3: "IRQ", iso2: "IQ", name: "Iraq" },
  "sudan": { iso3: "SDN", iso2: "SD", name: "Sudan" },
  "south sudan": { iso3: "SSD", iso2: "SS", name: "South Sudan" },
  "yemen (north yemen)": { iso3: "YEM", iso2: "YE", name: "Yemen" },
  "yemen": { iso3: "YEM", iso2: "YE", name: "Yemen" },
  "somalia": { iso3: "SOM", iso2: "SO", name: "Somalia" },
  "ethiopia": { iso3: "ETH", iso2: "ET", name: "Ethiopia" },
  "nigeria": { iso3: "NGA", iso2: "NG", name: "Nigeria" },
  "mali": { iso3: "MLI", iso2: "ML", name: "Mali" },
  "niger": { iso3: "NER", iso2: "NE", name: "Niger" },
  "burkina faso": { iso3: "BFA", iso2: "BF", name: "Burkina Faso" },
  "dr congo (zaire)": { iso3: "COD", iso2: "CD", name: "DR Congo" },
  "congo": { iso3: "COG", iso2: "CG", name: "Congo" },
  "myanmar (burma)": { iso3: "MMR", iso2: "MM", name: "Myanmar" },
  "afghanistan": { iso3: "AFG", iso2: "AF", name: "Afghanistan" },
  "libya": { iso3: "LBY", iso2: "LY", name: "Libya" },
  "colombia": { iso3: "COL", iso2: "CO", name: "Colombia" },
  "haiti": { iso3: "HTI", iso2: "HT", name: "Haiti" },
  "cameroon": { iso3: "CMR", iso2: "CM", name: "Cameroon" },
  "chad": { iso3: "TCD", iso2: "TD", name: "Chad" },
  "central african republic": { iso3: "CAF", iso2: "CF", name: "Central African Republic" },
  "mozambique": { iso3: "MOZ", iso2: "MZ", name: "Mozambique" },
  "georgia": { iso3: "GEO", iso2: "GE", name: "Georgia" },
  "armenia": { iso3: "ARM", iso2: "AM", name: "Armenia" },
  "azerbaijan": { iso3: "AZE", iso2: "AZ", name: "Azerbaijan" },
  "venezuela": { iso3: "VEN", iso2: "VE", name: "Venezuela" },
};

function ucdpLookupCountry(rawName) {
  if (!rawName) return null;
  const key = String(rawName).trim().toLowerCase();
  return UCDP_COUNTRY_ALIASES[key] || null;
}

// Sucht rekursiv nach dem Array der eigentlichen Ereignisse, unabhaengig vom
// Umschlag der Antwort (direktes Array, {Result: [...]}, {result: [...]}, ...).
// Gleiche Taktik wie findObservations() in fred.js fuer DBnomics - die genaue
// Form der UCDP-Antwort konnte hier nicht live geprueft werden.
function findUcdpEvents(node, depth) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && ("country" in x || "country_id" in x))) return node;
    for (const item of node) { const hit = findUcdpEvents(item, (depth || 0) + 1); if (hit) return hit; }
    return null;
  }
  if (!node || typeof node !== "object" || (depth || 0) > 4) return null;
  for (const k of Object.keys(node)) { const hit = findUcdpEvents(node[k], (depth || 0) + 1); if (hit) return hit; }
  return null;
}

// Zwei Kandidaten, aeltere zuerst nicht bevorzugt - der aktuellere/naeher an
// "jetzt" liegende Datensatz (Candidate Events, woechentlich aktualisiert)
// zuerst, das jaehrlich veroeffentlichte, dafuer stabilere GED als Rueckfall.
// Versionskennungen sind Vermutungen (siehe Kommentar am Dateianfang).
const UCDP_CANDIDATES = [
  (cutoffStr) => `https://ucdpapi.pcr.uu.se/api/candidateevents/24.01.24?pagesize=1000&page=0&StartDate=${cutoffStr}`,
  (cutoffStr) => `https://ucdpapi.pcr.uu.se/api/gedevents/24.1?pagesize=1000&page=0&StartDate=${cutoffStr}`,
];

async function fetchUcdp() {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 120);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const attempts = [];
  for (const build of UCDP_CANDIDATES) {
    const url = build(cutoffStr);
    try {
      const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": UA } }, UCDP_TIMEOUT);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim(); } catch (_) {}
        attempts.push(`UCDP HTTP ${res.status}${detail ? " – " + detail : ""}`);
        continue;
      }
      const json = await res.json();
      const events = findUcdpEvents(json, 0);
      if (!events) { attempts.push("UCDP: kein Ereignis-Array in der Antwort gefunden"); continue; }
      const byCountry = new Map();
      for (const ev of events) {
        const rawName = ev.country || ev.country_name || null;
        const c = ucdpLookupCountry(rawName);
        if (!c || byCountry.has(c.iso3)) continue;
        const dateStr = ev.date_start || ev.date_end || null;
        byCountry.set(c.iso3, {
          iso3: c.iso3, iso2: c.iso2, name: c.name,
          ucdpActive: true,
          ucdpType: ev.type_of_violence != null ? String(ev.type_of_violence) : null,
          ucdpDate: dateStr ? String(dateStr).slice(0, 10) : null,
        });
      }
      if (byCountry.size) return byCountry;
      attempts.push("UCDP: keines der gemeldeten Laender konnte zugeordnet werden");
    } catch (e) {
      attempts.push(String((e && e.message) || e));
      // Timeout = Host antwortet nicht - der zweite Kandidat probiert eine
      // ANDERE URL, das ist kein sinnloses Nachfassen wie bei ReliefWebs 410.
    }
  }
  throw new Error(attempts.join(" | "));
}

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
const GDELT_HEADLINES_TIMESPAN = "7d";  // vorher 3d - mehr Kontext, nicht nur die letzten 72h
const GDELT_MAXRECORDS = 25;            // vorher 10 - genauere Artikelanzahl fuer die Risikostufe
const GDELT_HEADLINES_SHOWN = 8;        // vorher 3 - mehr Schlagzeilen im Detailpanel
const GDELT_TIMELINE_TIMESPAN = "2w";   // eigener, laengerer Zeitraum fuer den Trendverlauf

// Sucht rekursiv nach dem Array der Zeitreihenpunkte (Datum+Wert), unabhaengig
// vom Antwort-Umschlag - gleiche Taktik wie bei UCDP/DBnomics, da die genaue
// Form der GDELT-Timeline-Antwort hier nicht live geprueft werden konnte.
// Erkennungsmerkmal "date"+"value" grenzt sauber gegen die Artikel-Antwort ab
// (die hat "title"/"url", keine "date"/"value"-Paare).
function findGdeltTimelineData(node, depth) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && "date" in x && "value" in x)) return node;
    for (const item of node) { const hit = findGdeltTimelineData(item, (depth || 0) + 1); if (hit) return hit; }
    return null;
  }
  if (!node || typeof node !== "object" || (depth || 0) > 4) return null;
  for (const k of Object.keys(node)) { const hit = findGdeltTimelineData(node[k], (depth || 0) + 1); if (hit) return hit; }
  return null;
}

// Artikelvolumen als Zeitreihe (mode=timelinevol) - zeigt, ob sich eine Lage
// gerade zuspitzt oder abklingt, statt nur eine Momentaufnahme zu liefern.
// Best-effort: schlaegt diese Abfrage fehl, bekommt das Land trotzdem seine
// Schlagzeilen (siehe fetchGdeltFor) - ein leerer Trend ist kein Grund, die
// ganze Laenderauswertung scheitern zu lassen.
async function fetchGdeltTimelineFor(country) {
  const q = `"${country.name}" ${CONFLICT_KEYWORDS}`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=timelinevol&format=json&timespan=${GDELT_TIMELINE_TIMESPAN}`;
  const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": UA } }, PER_REQUEST_TIMEOUT);
  if (!res.ok) throw new Error(`GDELT-Timeline HTTP ${res.status}`);
  const json = await res.json();
  const points = findGdeltTimelineData(json, 0);
  if (!points) return [];
  return points
    .map((p) => ({ date: String(p.date || "").slice(0, 8), value: typeof p.value === "number" ? p.value : parseFloat(p.value) }))
    .filter((p) => p.date && !isNaN(p.value));
}

async function fetchGdeltFor(country) {
  const q = `"${country.name}" ${CONFLICT_KEYWORDS}`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=${GDELT_MAXRECORDS}&timespan=${GDELT_HEADLINES_TIMESPAN}&format=json&sort=datedesc`;

  // Artikelliste UND Trendverlauf gleichzeitig abrufen (nicht nacheinander) -
  // beide teilen sich PER_REQUEST_TIMEOUT, damit sich die Laufzeit je Land
  // durch die zweite Abfrage nicht verdoppelt. Der Trend ist best-effort
  // (allSettled), die Artikelliste bleibt wie bisher hart (wirft bei Fehler).
  const [articlesResult, timelineResult] = await Promise.allSettled([
    (async () => {
      const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": UA } }, PER_REQUEST_TIMEOUT);
      if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
      const json = await res.json();
      const articles = (Array.isArray(json && json.articles) ? json.articles : []).filter((a) => a && a.title && a.url);
      // count = tatsaechliches Artikelvolumen (fuer die Risikostufe), headlines =
      // nur die ersten GDELT_HEADLINES_SHOWN zur Anzeige - beide bewusst getrennt,
      // damit das Kappen der Anzeige nicht versehentlich auch die Score-Berechnung deckelt.
      return {
        count: articles.length,
        headlines: articles.slice(0, GDELT_HEADLINES_SHOWN).map((a) => ({ title: a.title, url: a.url, date: a.seendate ? String(a.seendate).slice(0, 8) : null, source: a.domain || "" })),
      };
    })(),
    fetchGdeltTimelineFor(country),
  ]);

  if (articlesResult.status === "rejected") throw articlesResult.reason;
  return {
    count: articlesResult.value.count,
    headlines: articlesResult.value.headlines,
    trend: timelineResult.status === "fulfilled" ? timelineResult.value : [],
  };
}

function computeLevel(gdeltCount, officialActive) {
  if (officialActive && gdeltCount >= 5) return "kritisch";
  if (officialActive || gdeltCount >= 5) return "hoch";
  if (gdeltCount >= 2) return "mittel";
  if (gdeltCount >= 1) return "niedrig";
  return "keine";
}

async function buildReport() {
  // Ab Funktionsstart, nicht erst nach den dynamischen Quellen - siehe
  // Kommentar bei FUNCTION_BUDGET_MS.
  const deadline = Date.now() + FUNCTION_BUDGET_MS;

  let ucdpByCountry = new Map(); let ucdpError = null;
  try { ucdpByCountry = await fetchUcdp(); } catch (e) { ucdpError = String(e && e.message || e); }

  // ReliefWeb v2 verlangt einen VORAB REGISTRIERTEN Appnamen (Live-Beleg:
  // HTTP 403 "not using an approved appname") - ohne einen ist jeder Versuch
  // ein garantierter Fehlschlag, der nur Zeit aus dem knappen Gesamtbudget
  // nimmt. Deshalb standardmaessig uebersprungen; sobald RELIEFWEB_APPNAME
  // gesetzt ist (nach Registrierung unter https://apidoc.reliefweb.int/apidoc),
  // wird ReliefWeb wieder als Zusatzquelle mitgenutzt.
  let rwByCountry = new Map(); let rwError = null;
  if (process.env.RELIEFWEB_APPNAME) {
    try { rwByCountry = await fetchReliefWeb(); } catch (e) { rwError = String(e && e.message || e); }
  } else {
    rwError = "übersprungen: kein genehmigter Appname konfiguriert (RELIEFWEB_APPNAME) – Registrierung: https://apidoc.reliefweb.int/apidoc";
  }

  // Beide dynamischen Quellen zu einer Laenderliste kombinieren. UCDP zuerst
  // (Konflikt-Hauptquelle), ReliefWeb ergaenzt bekannte Laender um seine
  // Zusatzinfo (Schlagzeile) und fuegt Laender hinzu, die UCDP nicht kennt.
  const dynamicCountries = new Map(ucdpByCountry);
  for (const [iso3, c] of rwByCountry) {
    const existing = dynamicCountries.get(iso3);
    dynamicCountries.set(iso3, existing ? Object.assign({}, existing, {
      reliefwebActive: true, reliefwebType: c.reliefwebType, reliefwebHeadline: c.reliefwebHeadline, reliefwebDate: c.reliefwebDate,
    }) : c);
  }

  const watchlist = buildWatchlist(Array.from(dynamicCountries.values()));
  const out = {};

  for (let i = 0; i < watchlist.length; i += WAVE) {
    // Nicht nur pruefen ob das Budget JETZT schon ueberschritten ist, sondern ob
    // eine weitere Welle (die selbst bis zu PER_REQUEST_TIMEOUT dauern darf) noch
    // hineinpasst - sonst startet die letzte Welle knapp vor der Deadline und
    // reisst das Gesamtbudget trotzdem.
    if (Date.now() + PER_REQUEST_TIMEOUT > deadline) {
      for (const c of watchlist.slice(i)) {
        const dyn = dynamicCountries.get(c.iso3) || null;
        out[c.iso3] = baseEntry(c, dyn, null, "nicht geprüft (Zeitbudget erreicht)");
      }
      break;
    }
    const wave = watchlist.slice(i, i + WAVE);
    const settled = await Promise.all(wave.map(async (c) => {
      const dyn = dynamicCountries.get(c.iso3) || null;
      try { return { c, dyn, gdelt: await fetchGdeltFor(c) }; }
      catch (e) { return { c, dyn, gdelt: null, err: String(e && e.message || e) }; }
    }));
    for (const r of settled) out[r.c.iso3] = baseEntry(r.c, r.dyn, r.gdelt, r.err || null);
  }

  return { countries: out, ucdpError, reliefwebError: rwError, generatedAt: new Date().toISOString() };
}

function baseEntry(c, dyn, gdelt, error) {
  const ucdpActive = !!(dyn && dyn.ucdpActive);
  const reliefwebActive = !!(dyn && dyn.reliefwebActive);
  const gdeltCount = gdelt ? gdelt.count : 0;
  return {
    iso3: c.iso3, iso2: c.iso2 || (dyn && dyn.iso2) || null, name: c.name || (dyn && dyn.name) || c.iso3,
    flag: flagEmoji(c.iso2 || (dyn && dyn.iso2)),
    level: gdelt === null && error ? "nicht geprüft" : computeLevel(gdeltCount, ucdpActive || reliefwebActive),
    gdeltCount, headlines: gdelt ? gdelt.headlines : [], gdeltTrend: gdelt ? gdelt.trend : [],
    ucdpActive, ucdpType: dyn ? dyn.ucdpType : null, ucdpDate: dyn ? dyn.ucdpDate : null,
    reliefwebActive, reliefwebType: dyn ? dyn.reliefwebType : null, reliefwebHeadline: dyn ? dyn.reliefwebHeadline : null, reliefwebDate: dyn ? dyn.reliefwebDate : null,
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
exports._internal = { computeLevel, baseEntry, buildReport, ucdpLookupCountry, findUcdpEvents, fetchUcdp, findGdeltTimelineData };
