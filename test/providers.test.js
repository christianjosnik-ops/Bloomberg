// providers.test.js — Unit-Tests fuer die Fallback-Ketten-/Circuit-Breaker-Logik.
// Kein Test-Framework, nur Node + assert:  node test/providers.test.js
// Alle Provider hier sind Fakes - es geht ausschliesslich um die Ablauflogik,
// nicht um echte HTTP-Aufrufe.

const assert = require("assert");
const P = require("../netlify/functions/lib/providers.js");

function ok(name, value) { return { name: name, run: async () => value }; }
function fails(name, msg) { return { name: name, run: async () => { throw new Error(msg || "kaputt"); } }; }
function empty(name) { return { name: name, run: async () => null }; }

(async function run() {
  // --- Kette: erster Erfolg gewinnt ---
  P._resetBreakers();
  let r = await P.tryChain([ok("a", { v: 1 }), ok("b", { v: 2 })]);
  assert.deepStrictEqual(r.data, { v: 1 });
  assert.strictEqual(r.source, "a", "erster erfolgreicher Provider gewinnt");
  assert.strictEqual(r.attempts.length, 1, "spaetere Provider werden gar nicht erst versucht");

  // --- Kette: faellt auf den naechsten Provider zurueck ---
  P._resetBreakers();
  r = await P.tryChain([fails("a"), ok("b", { v: 2 })]);
  assert.deepStrictEqual(r.data, { v: 2 });
  assert.strictEqual(r.source, "b");
  assert.strictEqual(r.attempts[0].ok, false);
  assert.strictEqual(r.attempts[1].ok, true);

  // --- null gilt als Fehlschlag, nicht als gueltiges Ergebnis ---
  P._resetBreakers();
  r = await P.tryChain([empty("a"), ok("b", { v: 2 })]);
  assert.strictEqual(r.source, "b", "null vom ersten Provider -> weiter zum naechsten");

  // --- eigenes isValid: HTTP 200 mit unbrauchbarem Inhalt ---
  P._resetBreakers();
  r = await P.tryChain(
    [ok("a", { rows: [] }), ok("b", { rows: [1, 2] })],
    (x) => x && Array.isArray(x.rows) && x.rows.length > 0
  );
  assert.strictEqual(r.source, "b", "leeres rows-Array wird per isValid als unbrauchbar erkannt");

  // --- alle Provider tot -> data null, source null, alle Versuche protokolliert ---
  P._resetBreakers();
  r = await P.tryChain([fails("a"), fails("b")]);
  assert.strictEqual(r.data, null);
  assert.strictEqual(r.source, null);
  assert.strictEqual(r.attempts.length, 2);
  console.log("Block 1/3 (Kettenlogik): OK");

  // --- Circuit Breaker: oeffnet nach FAIL_THRESHOLD Fehlern ---
  P._resetBreakers();
  for (let i = 0; i < P.FAIL_THRESHOLD; i++) { await P.tryChain([fails("flaky"), ok("backup", 1)]); }
  assert.strictEqual(P.isOpen("flaky"), true, "nach " + P.FAIL_THRESHOLD + " Fehlern muss der Breaker offen sein");

  // --- offener Breaker wird uebersprungen, nicht erneut aufgerufen ---
  let called = 0;
  const counting = { name: "flaky", run: async () => { called++; return 1; } };
  r = await P.tryChain([counting, ok("backup", 99)]);
  assert.strictEqual(called, 0, "offener Breaker darf den Provider gar nicht erst aufrufen (spart das Timeout)");
  assert.strictEqual(r.source, "backup");
  assert.strictEqual(r.attempts[0].skipped, "circuit-open");

  // --- Erfolg setzt den Fehlerzaehler zurueck ---
  P._resetBreakers();
  await P.tryChain([fails("x"), ok("y", 1)]);
  await P.tryChain([fails("x"), ok("y", 1)]);
  assert.strictEqual(P.isOpen("x"), false, "2 Fehler < Schwelle -> noch geschlossen");
  await P.tryChain([ok("x", 1)]);
  await P.tryChain([fails("x"), ok("y", 1)]);
  await P.tryChain([fails("x"), ok("y", 1)]);
  assert.strictEqual(P.isOpen("x"), false, "zwischenzeitlicher Erfolg muss den Zaehler zurueckgesetzt haben");
  console.log("Block 2/3 (Circuit Breaker): OK");

  // --- fetchWithTimeout: bricht ab und markiert den Fehler als Timeout ---
  const origFetch = global.fetch;
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    // Antwortet nie von selbst - nur das Abort-Signal beendet den Aufruf.
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  let timedOut = false;
  try { await P.fetchWithTimeout("https://example.invalid", {}, 50); }
  catch (e) { timedOut = !!e.isTimeout; }
  finally { global.fetch = origFetch; }
  assert.strictEqual(timedOut, true, "haengender Request muss als .isTimeout markiert abbrechen");

  // --- breakerState() liefert eine inspizierbare Uebersicht ---
  P._resetBreakers();
  for (let i = 0; i < P.FAIL_THRESHOLD; i++) { await P.tryChain([fails("dead"), ok("alt", 1)]); }
  const st = P.breakerState();
  assert.strictEqual(st.dead.open, true);
  assert.strictEqual(st.alt.open, false);
  console.log("Block 3/3 (Timeout + Zustandsabfrage): OK");

  console.log("\nAlle providers.js-Tests erfolgreich.");
})().catch((e) => { console.error("FEHLGESCHLAGEN:", e.message); process.exit(1); });
