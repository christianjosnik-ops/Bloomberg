// geo-countries.js — Laenderreferenz fuer das Weltlage-Modul (F6). Reine
// Konstanten/Hilfsfunktionen, kein Fetch. CommonJS, laeuft serverseitig in
// geopolitics.js.
//
// FESTE BEOBACHTUNGSLISTE: Ergaenzt die dynamisch aus ReliefWeb ermittelten
// Laender (aktive Krisen) um ein paar geopolitisch dauerhaft relevante
// Staaten, die nicht immer als "Katastrophe" im ReliefWeb-Sinn gefuehrt
// werden (z.B. Taiwan/China-Spannung). Das ist eine von Hand kuratierte,
// bewusst kurze Auswahl - keine erschoepfende Weltabdeckung. Wird im UI
// so kommuniziert.
const FIXED_WATCHLIST = [
  { iso2: "RU", iso3: "RUS", name: "Russia" },
  { iso2: "UA", iso3: "UKR", name: "Ukraine" },
  { iso2: "IL", iso3: "ISR", name: "Israel" },
  { iso2: "PS", iso3: "PSE", name: "Palestine" },
  { iso2: "LB", iso3: "LBN", name: "Lebanon" },
  { iso2: "SY", iso3: "SYR", name: "Syria" },
  { iso2: "TW", iso3: "TWN", name: "Taiwan" },
  { iso2: "CN", iso3: "CHN", name: "China" },
  { iso2: "KP", iso3: "PRK", name: "North Korea" },
  { iso2: "KR", iso3: "KOR", name: "South Korea" },
  { iso2: "IN", iso3: "IND", name: "India" },
  { iso2: "PK", iso3: "PAK", name: "Pakistan" },
  { iso2: "IR", iso3: "IRN", name: "Iran" },
  { iso2: "IQ", iso3: "IRQ", name: "Iraq" },
];
const MAX_WATCHLIST = 20; // Obergrenze gesamt (fest + aus ReliefWeb) - begrenzt Laufzeit/Anfragen

// Flaggen-Emoji rein rechnerisch aus dem ISO-3166-1-Alpha-2-Code (Unicode
// "Regional Indicator Symbols") - keine externe Bilddatei/Datenquelle noetig.
function flagEmoji(iso2) {
  if (!iso2 || iso2.length !== 2) return "";
  const A = 0x1f1e6; // Regional Indicator Symbol Letter A
  const up = iso2.toUpperCase();
  const c0 = up.charCodeAt(0) - 65, c1 = up.charCodeAt(1) - 65;
  if (c0 < 0 || c0 > 25 || c1 < 0 || c1 > 25) return "";
  return String.fromCodePoint(A + c0, A + c1);
}

// Fuegt ReliefWeb-Laender (mit iso3/iso2/name) zur festen Liste hinzu, ohne
// Duplikate, gedeckelt auf MAX_WATCHLIST. ReliefWeb-Laender zuerst (das ist
// das aktuellere, datengetriebene Signal), feste Liste fuellt auf.
function buildWatchlist(reliefwebCountries) {
  const seen = new Set();
  const out = [];
  const add = (c) => {
    if (!c || !c.iso3 || seen.has(c.iso3) || out.length >= MAX_WATCHLIST) return;
    seen.add(c.iso3); out.push(c);
  };
  (reliefwebCountries || []).forEach(add);
  FIXED_WATCHLIST.forEach(add);
  return out;
}

module.exports = { FIXED_WATCHLIST, MAX_WATCHLIST, flagEmoji, buildWatchlist };
