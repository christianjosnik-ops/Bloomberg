// providers.js — geordnete Fallback-Ketten + Circuit Breaker fuer alle
// externen Datenquellen. Reine Ablauflogik, kein anbieterspezifisches Wissen.
// CommonJS, laeuft nur serverseitig in den Netlify-Functions.
//
// Warum Circuit Breaker: Der Makro-Tab hat 10 FRED-Serien parallel geladen und
// JEDE ist in einen 7s-Timeout gelaufen - bei jedem Seitenaufruf erneut. Wenn
// eine Quelle nachweislich tot ist, soll sie eine Zeit lang uebersprungen
// werden, statt jedes Mal die volle Timeout-Strafe zu zahlen.
//
// Hinweis zum Zustand: Netlify-Function-Instanzen sind kurzlebig und es gibt
// mehrere parallel. Der Breaker-Zustand gilt daher pro warmer Instanz, nicht
// global - genau wie der bestehende CACHE/SESSION-Zustand in quote.js. Das
// reicht fuer den Zweck (Timeout-Sturm daempfen), ist aber kein verteilter
// Schalter.

const BREAKERS = new Map(); // name -> { fails, openUntil }
const FAIL_THRESHOLD = 3;   // ab so vielen Fehlern in Folge wird geoeffnet
const OPEN_MS = 5 * 60 * 1000; // so lange wird der Provider uebersprungen

function breakerFor(name) {
  let b = BREAKERS.get(name);
  if (!b) { b = { fails: 0, openUntil: 0 }; BREAKERS.set(name, b); }
  return b;
}

function isOpen(name) {
  const b = breakerFor(name);
  if (b.openUntil && Date.now() < b.openUntil) return true;
  if (b.openUntil && Date.now() >= b.openUntil) { b.openUntil = 0; b.fails = 0; } // halb-offen: einen Versuch zulassen
  return false;
}

function recordSuccess(name) { const b = breakerFor(name); b.fails = 0; b.openUntil = 0; }

function recordFailure(name) {
  const b = breakerFor(name);
  b.fails += 1;
  if (b.fails >= FAIL_THRESHOLD) b.openUntil = Date.now() + OPEN_MS;
}

function breakerState() {
  const out = {};
  BREAKERS.forEach((b, name) => { out[name] = { fails: b.fails, open: !!(b.openUntil && Date.now() < b.openUntil) }; });
  return out;
}

// Nur fuer Tests: Zustand zuruecksetzen.
function _resetBreakers() { BREAKERS.clear(); }

/**
 * fetch mit hartem Timeout. Wirft bei Timeout einen Error mit .isTimeout = true,
 * damit Aufrufer Timeouts von echten HTTP-Fehlern unterscheiden koennen.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: ctrl.signal }));
  } catch (e) {
    if (ctrl.signal.aborted) { const err = new Error("Timeout nach " + (timeoutMs || 8000) + "ms"); err.isTimeout = true; throw err; }
    throw e;
  } finally {
    clearTimeout(to);
  }
}

/**
 * Probiert Provider der Reihe nach, erster Erfolg gewinnt.
 *
 * @param {Array<{name: string, run: function(): Promise<*>}>} providers - geordnete Kette
 * @param {function(*): boolean} [isValid] - entscheidet, ob ein Ergebnis brauchbar ist
 *   (default: alles ausser null/undefined). Wichtig, weil manche APIs mit HTTP 200
 *   antworten und trotzdem nichts Verwertbares liefern.
 * @returns {Promise<{data: *, source: string|null, attempts: Array<{name, ok, skipped?, error?}>}>}
 */
async function tryChain(providers, isValid) {
  const valid = isValid || ((x) => x != null);
  const attempts = [];
  for (const p of providers) {
    if (isOpen(p.name)) { attempts.push({ name: p.name, ok: false, skipped: "circuit-open" }); continue; }
    try {
      const data = await p.run();
      if (valid(data)) { recordSuccess(p.name); attempts.push({ name: p.name, ok: true }); return { data, source: p.name, attempts }; }
      recordFailure(p.name);
      attempts.push({ name: p.name, ok: false, error: "leeres/ungueltiges Ergebnis" });
    } catch (e) {
      recordFailure(p.name);
      attempts.push({ name: p.name, ok: false, error: String((e && e.message) || e) });
    }
  }
  return { data: null, source: null, attempts };
}

module.exports = { tryChain, fetchWithTimeout, isOpen, recordSuccess, recordFailure, breakerState, _resetBreakers, FAIL_THRESHOLD, OPEN_MS };
