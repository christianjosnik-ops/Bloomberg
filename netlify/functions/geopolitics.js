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
const PER_REQUEST_TIMEOUT = 3500;
const TOTAL_BUDGET_MS = 7500; // Puffer unter dem 10s-Standardlimit von Netlify Functions

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// --- ReliefWeb: aktuelle Krisen je Land (ein Aufruf, appname statt Key) -----
async function fetchReliefWeb() {
  const url = "https://api.reliefweb.int/v1/disasters"
    + "?appname=terminal-app-geopolitics"
    + "&filter[field]=status&filter[value][]=alert&filter[value][]=current"
    + "&fields[include][]=name&fields[include][]=date.created&fields[include][]=type.name&fields[include][]=country.iso3&fields[include][]=country.iso2&fields[include][]=country.name"
    + "&sort[]=date.created:desc&limit=100";
  const res = await fetchWithTimeout(url, { headers: { "Accept": "application/json", "User-Agent": UA } }, 6000);
  if (!res.ok) throw new Error(`ReliefWeb HTTP ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json && json.data) ? json.data : [];
  // Pro Land die juengste Meldung behalten (Ergebnis ist bereits nach Datum sortiert)
  const byCountry = new Map();
  for (const item of items) {
    try {
      const f = item.fields || {};
      const countries = Array.isArray(f.country) ? f.country : [];
      const country = countries.find((c) => c && c.iso3) || countries[0];
      if (!country || !country.iso3) continue;
      const iso3 = String(country.iso3).toUpperCase();
      if (byCountry.has(iso3)) continue; // erste (=juengste) Meldung je Land behalten
      const typeName = Array.isArray(f.type) && f.type[0] ? f.type[0].name : null;
      byCountry.set(iso3, {
        iso3, iso2: country.iso2 ? String(country.iso2).toUpperCase() : null, name: country.name || iso3,
        reliefwebActive: true, reliefwebType: typeName, reliefwebHeadline: f.name || null,
        reliefwebDate: f.date && f.date.created ? String(f.date.created).slice(0, 10) : null,
      });
    } catch (_) { /* einzelnen kaputten Eintrag ueberspringen, Rest verarbeiten */ }
  }
  return byCountry;
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
  let rwByCountry = new Map(); let rwError = null;
  try { rwByCountry = await fetchReliefWeb(); } catch (e) { rwError = String(e && e.message || e); }

  const watchlist = buildWatchlist(Array.from(rwByCountry.values()));
  const out = {};
  const deadline = Date.now() + TOTAL_BUDGET_MS;

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
