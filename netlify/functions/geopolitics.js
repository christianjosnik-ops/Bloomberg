// Netlify Function: /.netlify/functions/geopolitics
//
// Weltlage-Uebersicht (F6). EINE Quelle:
//   - UCDP (Uppsala Conflict Data Program): Konfliktereignisse je Land.
//     Kostenlos, verlangt aber einen Zugangstoken (UCDP_ACCESS_TOKEN, siehe
//     unten). Ohne ihn liefert diese Function nur die feste Laenderliste aus
//     geo-countries.js ohne jede Einstufung - und sagt das auch.
//
// WARUM NUR NOCH UCDP - zwei Quellen wurden gemessen und entfernt:
//
//   ReliefWeb (UN OCHA) verlangt einen VORAB REGISTRIERTEN Appnamen
//   (Live-Beleg: HTTP 403 "not using an approved appname"). Externe
//   Registrierung, die kein Code-Fix umgehen kann.
//
//   GDELT lieferte das Nachrichtenvolumen je Land. In der Live-Diagnose auf der
//   echten Instanz: "kein Kontakt · 6001ms" - der Host antwortet aus der
//   Netlify-Region binnen sechs Sekunden ueberhaupt nicht, waehrend USGS in
//   246ms und Yahoo in 281ms antworteten. Kein 429, keine kaputte Antwort, und
//   die Abfragesyntax wurde gegen die GDELT-Doku geprueft und war korrekt.
//   Danach wurde derselbe Aufruf im BROWSER des Nutzers versucht - auch dort
//   ohne Antwort. Zwei unabhaengige Netze, dasselbe Ergebnis: die Quelle ist
//   fuer diese Anwendung nicht erreichbar.
//
//   Sie stand deshalb nur noch als "0 Meldungen" in jeder Laenderzeile - eine
//   Anzeige, die wie ein Ergebnis aussah und keines war. Genau das war der
//   gemeldete Fehler. Ein dauerhaft toter Codepfad, der Zahlen vortaeuscht, ist
//   schaedlicher als eine fehlende Funktion, die sich benennt.
//
// Die APIs sind aus der Entwicklungsumgebung nicht erreichbar (Egress-Richtlinie
// blockt CONNECT mit 403), deshalb wurden Versionsschema und Antwortformat aus
// der oeffentlichen UCDP-Dokumentation recherchiert statt geraten: die API
// antwortet mit {TotalCount, TotalPages, NextPageUrl, Result:[...]}, und die
// Monats-Candidate-Versionen folgen dem Muster JJ.0.M (Stand August 2026:
// 26.0.7). Alle Antwortformate werden trotzdem defensiv geparst - unerwartete
// Formen fuehren zu leeren/neutralen Werten, nie zum Absturz.
//
// Lektion aus dem Makro-Tab (F4) direkt angewendet: NICHT alle Laender in
// einem Promise.all gleichzeitig abfragen (dann sieht keine Anfrage die
// Fehler der anderen, und ein haengender Anbieter blockiert alles gleich
// lang). Stattdessen Wellen + hartes Gesamt-Zeitbudget - was bis zum Budget
// nicht fertig ist, wird als "nicht geprueft" markiert statt zu haengen.

const { fetchWithTimeout } = require("./lib/providers");
const { flagEmoji, buildWatchlist } = require("./lib/geo-countries");

const CACHE = new Map(); const TTL = 20 * 60 * 1000; // 20 Min - Weltlage aendert sich nicht sekuendlich

// Eigenes Teilbudget fuer die UCDP-Versionssuche. Die Kandidatenliste ist
// bewusst lang (die neuesten Monatsversionen existieren noch nicht und
// antworten mit billigen 404ern) - ohne diese Schranke koennte allein die Suche
// das Funktionslimit reissen.
const UCDP_TIMEOUT = 2500;        // je einzelnem Versions-Versuch
const UCDP_MIN_ATTEMPT_MS = 400;  // darunter lohnt kein weiterer Versuch mehr
const UCDP_BUDGET_MS = 2500;
const UCDP_ANNAHME_MS_JE_VERSUCH = 350; // Erfahrungswert fuer ein 404, nur fuer die Budget-Pruefung im Test

// Gesamtfrist mit Sicherheitsabstand unter Netlifys 10s-Grenze fuer synchrone
// Functions. Seit UCDP die einzige Quelle ist, bleibt davon fast alles
// ungenutzt - es ist ein einziger Aufruf. Die Frist bleibt trotzdem, damit eine
// haengende UCDP-Antwort die Function nicht in Netlifys harten Abbruch laufen
// laesst, bei dem der Aufrufer gar keinen Fehlertext mehr saehe.
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

// Sucht das Array der eigentlichen Ereignisse. Live recherchiert: die UCDP-API
// antwortet mit {TotalCount, TotalPages, PreviousPageUrl, NextPageUrl, Result:[...]}
// - deshalb wird "Result" zuerst direkt geprueft. Die rekursive Suche bleibt als
// Absicherung, falls sich der Umschlag aendert.
function findUcdpEvents(node, depth) {
  const looksLikeEvents = (arr) => Array.isArray(arr) && arr.length
    && arr.every((x) => x && typeof x === "object" && ("country" in x || "country_id" in x));
  if ((depth || 0) === 0 && node && typeof node === "object" && looksLikeEvents(node.Result)) return node.Result;
  if (Array.isArray(node)) {
    if (looksLikeEvents(node)) return node;
    for (const item of node) { const hit = findUcdpEvents(item, (depth || 0) + 1); if (hit) return hit; }
    return null;
  }
  if (!node || typeof node !== "object" || (depth || 0) > 4) return null;
  for (const k of Object.keys(node)) { const hit = findUcdpEvents(node[k], (depth || 0) + 1); if (hit) return hit; }
  return null;
}

// VERSIONSSCHEMA (recherchiert, Stand August 2026):
//   Monats-Candidate:    JJ.0.M    z.B. 26.0.7 = Julidaten 2026
//   GED (Jahresrelease): JJ.1      z.B. 25.1   - deckt nur bis 2024-12-31
//
// Zwei Lehren daraus, die die frueheren Fassungen falsch hatten:
//
// 1. Der Monatsstring WANDERT. Hartkodiert (frueher "24.01.24") bricht die
//    Weltlage jeden Monat aufs Neue - und brach hier von Anfang an, weil die
//    geratene Version nie existiert hat. Deshalb wird die Liste aus dem
//    aktuellen Datum erzeugt und rueckwaerts gelaufen: die neueste noch nicht
//    veroeffentlichte Version liefert 404 (billig und schnell), die erste
//    existierende gewinnt.
// 2. GED taugt NICHT als Rueckfall fuer die aktuelle Lage. Version 25.1 endet
//    am 2024-12-31; eine Abfrage der letzten 120 Tage liefert dort per
//    Definition null Treffer. Schlimmer noch: wuerde man den Zeitfilter
//    weglassen, stuenden Konfliktdaten von 2024 als "aktuelle Weltlage" im UI -
//    genau die Art stiller Falschauskunft, die bei den eingestellten
//    FRED-Serien behoben wurde. GED ist deshalb bewusst KEIN Kandidat mehr.
// Wie viele Monate rueckwaerts gesucht wird. Die Zahl ist an das Zeitbudget
// gekoppelt und nicht frei waehlbar: jeder Versuch kostet einen Netzwerkaufruf
// (~200-400ms fuer ein 404), und die Summe muss in UCDP_BUDGET_MS passen -
// sonst wird die Suche mittendrin abgeschnitten. 6 Monate decken auch eine
// laengere Veroeffentlichungspause ab; im Normalfall trifft ohnehin der zweite
// Versuch (der laufende Monat ist meist noch nicht veroeffentlicht, der
// Vormonat schon). Die Zahl ergibt sich aus dem Teilbudget: 7 URLs x 350ms =
// 2450ms passen in UCDP_BUDGET_MS. Ein Test prueft das nach.
const UCDP_MONTHS_BACK = 6;
function ucdpCandidateVersions(now, monthsBack) {
  const out = [];
  // Auf den Monatsersten normieren: sonst rutscht setUTCMonth() vom 31. eines
  // Monats in den uebernaechsten (31. Maerz minus 1 Monat = 3. Maerz).
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < (monthsBack || UCDP_MONTHS_BACK); i++) {
    out.push(`${d.getUTCFullYear() % 100}.0.${d.getUTCMonth() + 1}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

// Ressourcenname: das monatliche Candidate-Release laeuft laut API-Dokumentation
// ueber dieselbe Ressource wie GED ("gedevents"), nur mit einem Monats- statt
// Jahres-Versionsstring. "candidateevents" wird als zweite Schreibweise
// mitprobiert - nur fuer die neueste Version, damit eine falsche Annahme nicht
// die gesamte Liste verdoppelt.
function ucdpUrls(now, monthsBack) {
  const versions = ucdpCandidateVersions(now, monthsBack);
  const urls = [];
  versions.forEach((v, i) => {
    urls.push(`https://ucdpapi.pcr.uu.se/api/gedevents/${v}?pagesize=1000&page=0`);
    if (i === 0) urls.push(`https://ucdpapi.pcr.uu.se/api/candidateevents/${v}?pagesize=1000&page=0`);
  });
  return urls;
}

// Zuletzt erfolgreiche URL merken. Nur der erste Aufruf einer warmen Instanz
// bezahlt die Versionssuche; danach sitzt der Treffer sofort. Modul-global wie
// CACHE und der Circuit Breaker - gilt also je warmer Instanz, nicht global.
let UCDP_LAST_GOOD_URL = null;

// ZUGANGSTOKEN. Live-Beleg aus dem Betrieb:
//   HTTP 401 – "API token required. Add header: x-ucdp-access-token: <your-token>"
//
// UCDP hat den offenen Zugang geschlossen. Das ist keine Frage der Version oder
// der Anfrageform - ohne Token antwortet die API grundsaetzlich mit 401. Der
// Token ist kostenlos (5000 Anfragen/Tag), wird aber nicht automatisiert
// vergeben: man schreibt eine kurze Mail an mertcan.yilmaz@pcr.uu.se mit Name,
// Zugehoerigkeit und Verwendungszweck.
//
// Ohne Token wird UCDP gar nicht erst angefragt: ein garantierter 401 kostet
// nur Zeit und liefert nichts. Seit UCDP die einzige Quelle ist, heisst das
// zugleich, dass F6 dann ueberhaupt keine Einstufung mehr hat - die Function
// meldet das ausdruecklich (hatQuelle=false), statt "keine Gefahr" vorzugaukeln.
const UCDP_TOKEN = process.env.UCDP_ACCESS_TOKEN || "";

async function fetchUcdp(deadline) {
  if (!UCDP_TOKEN) {
    throw new Error("übersprungen: kein Zugangstoken konfiguriert (UCDP_ACCESS_TOKEN) – UCDP verlangt seit Kurzem einen kostenlosen Token, anzufragen per Mail an mertcan.yilmaz@pcr.uu.se");
  }
  const attempts = [];
  let versuche = 0;
  const urls = ucdpUrls(new Date());
  // Die gemerkte URL zuerst, ohne sie doppelt zu probieren.
  const reihenfolge = UCDP_LAST_GOOD_URL
    ? [UCDP_LAST_GOOD_URL, ...urls.filter((u) => u !== UCDP_LAST_GOOD_URL)]
    : urls;
  for (const url of reihenfolge) {
    // Hartes Zeitbudget: Die Kandidatenliste ist bewusst lang (die neuesten
    // Versionen existieren noch nicht und liefern billige 404er). Ohne diese
    // Schranke wuerde ein haengender Host die Liste durchlaufen und das
    // Gesamtbudget der Function reissen.
    const rest = deadline ? deadline - Date.now() : UCDP_TIMEOUT;
    if (rest < UCDP_MIN_ATTEMPT_MS) { attempts.push(`Zeitbudget nach ${versuche} Versuchen erreicht`); break; }
    versuche++;
    try {
      const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": UA, "x-ucdp-access-token": UCDP_TOKEN } },
        Math.max(UCDP_MIN_ATTEMPT_MS, Math.min(UCDP_TIMEOUT, rest)));
      // 401 = der Token fehlt oder gilt nicht. Weitere Versionen zu probieren
      // aendert daran nichts - jede von ihnen antwortet identisch.
      if (res.status === 401) {
        attempts.push("UCDP HTTP 401 – Zugangstoken fehlt oder ist ungueltig (UCDP_ACCESS_TOKEN pruefen)");
        break;
      }
      // 404 = diese Version gibt es (noch) nicht. Das ist der Normalfall beim
      // Rueckwaertslaufen und keine Meldung wert - sonst bestuende der Fehlertext
      // am Ende aus einem Dutzend nichtssagender 404-Zeilen.
      if (res.status === 404) continue;
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
      if (byCountry.size) { UCDP_LAST_GOOD_URL = url; return byCountry; }
      attempts.push("UCDP: keines der gemeldeten Laender konnte zugeordnet werden");
    } catch (e) {
      attempts.push(String((e && e.message) || e));
      // Ein Timeout heisst: der Host antwortet ueberhaupt nicht. Weitere
      // Versionen zu probieren kostet dann nur weitere Timeouts, ohne je etwas
      // zu liefern - dieselbe Kaskade, die den Makro-Tab lahmgelegt hatte.
      if (e && e.isTimeout) break;
    }
  }
  throw new Error(attempts.length ? attempts.join(" | ") : `keine der ${versuche} geprueften UCDP-Versionen existiert`);
}

// Einstufung. Nach dem Wegfall von GDELT bleibt UCDP als einziges Signal -
// die Stufe ist damit zweiwertig statt fuenfstufig.
//
// Das ist bewusst so und wird NICHT durch einen Ersatzwert kaschiert: Die
// frueheren Zwischenstufen (mittel/niedrig) kamen ausschliesslich aus dem
// Nachrichtenvolumen. Sie weiter anzuzeigen, ohne dass es die Quelle noch
// gibt, waere eine erfundene Genauigkeit. Ohne UCDP-Token gibt es gar kein
// Signal - dann liefert die Function "unbekannt", nicht "keine": Letzteres
// hiesse "geprueft und ruhig", Ersteres "nicht geprueft".
function computeLevel(ucdpActive, hatQuelle) {
  if (!hatQuelle) return "unbekannt";
  return ucdpActive ? "hoch" : "keine";
}

async function buildReport() {
  // Ab Funktionsstart, nicht erst nach den dynamischen Quellen - siehe
  // Kommentar bei FUNCTION_BUDGET_MS.
  const deadline = Date.now() + FUNCTION_BUDGET_MS;

  let ucdpByCountry = new Map(); let ucdpError = null;
  const ucdpDeadline = Math.min(deadline, Date.now() + UCDP_BUDGET_MS);
  try { ucdpByCountry = await fetchUcdp(ucdpDeadline); } catch (e) { ucdpError = String(e && e.message || e); }

  // Mit dem Wegfall von GDELT entfallen auch die Wellen und das Zeitbudget:
  // die brauchte es NUR fuer den Abruf je Land. UCDP ist ein einziger Aufruf,
  // danach ist der Bericht fertig. Damit verschwindet auch der Zustand
  // "nicht geprueft (Zeitbudget erreicht)" - er kann gar nicht mehr eintreten.
  const dynamicCountries = new Map(ucdpByCountry);
  const watchlist = buildWatchlist(Array.from(dynamicCountries.values()));

  // Traegt UCDP ueberhaupt? Ohne Token oder bei Ausfall gibt es kein Signal -
  // dann sind alle Laender "unbekannt" statt "keine". Der Unterschied zaehlt:
  // "keine" hiesse geprueft und ruhig.
  const hatQuelle = !ucdpError;

  const out = {};
  for (const c of watchlist) {
    const dyn = dynamicCountries.get(c.iso3) || null;
    out[c.iso3] = baseEntry(c, dyn, hatQuelle);
  }

  return { countries: out, ucdpError, hatQuelle, generatedAt: new Date().toISOString() };
}

function baseEntry(c, dyn, hatQuelle) {
  const ucdpActive = !!(dyn && dyn.ucdpActive);
  return {
    iso3: c.iso3, iso2: c.iso2 || (dyn && dyn.iso2) || null, name: c.name || (dyn && dyn.name) || c.iso3,
    flag: flagEmoji(c.iso2 || (dyn && dyn.iso2)),
    level: computeLevel(ucdpActive, hatQuelle),
    ucdpActive, ucdpType: dyn ? dyn.ucdpType : null, ucdpDate: dyn ? dyn.ucdpDate : null,
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
exports._internal = { computeLevel, baseEntry, buildReport, ucdpLookupCountry, findUcdpEvents, fetchUcdp, ucdpCandidateVersions, ucdpUrls, UCDP_BUDGET_MS, UCDP_ANNAHME_MS_JE_VERSUCH, FUNCTION_BUDGET_MS };
