// geo-quakes.test.js — Tests fuer die USGS-Erdbebenquelle.
//   node test/geo-quakes.test.js
//
// Das Antwortformat konnte in dieser Umgebung nicht live geprueft werden (die
// Egress-Richtlinie blockt earthquake.usgs.gov). Es stammt aus der oeffentlichen
// GeoJSON-Spezifikation des USGS-Feeds. Genau deshalb liegt der Schwerpunkt
// hier auf DEFENSIVEM Verhalten: unerwartete Formen duerfen zu weniger Punkten
// fuehren, aber niemals zu einem Absturz und niemals zu einem Punkt mit
// erfundenen Koordinaten - der laege auf der Karte an willkuerlicher Stelle und
// saehe dabei voellig echt aus.

const assert = require("assert");
const Q = require("../assets/js/geo-quakes.js");

// Baut ein Feature wie im USGS-Feed.
function beben(o) {
  return {
    id: o.id || "us0001",
    properties: {
      mag: o.mag, place: o.ort || "irgendwo", time: o.zeit || 1735689600000,
      tsunami: o.tsunami ? 1 : 0, type: o.type || "earthquake", url: o.url || "https://example.invalid",
    },
    geometry: { type: "Point", coordinates: [o.lon, o.lat, o.tiefe == null ? 10 : o.tiefe] },
  };
}
const antwort = (fs) => ({ type: "FeatureCollection", features: fs });

// ---------------------------------------------------------------------------
// 1. URL-Bau
// ---------------------------------------------------------------------------
{
  assert.strictEqual(Q.feedUrl(), Q.FEED_BASIS + "4.5_week.geojson", "Standard: ab Staerke 4.5, letzte Woche");
  assert.strictEqual(Q.feedUrl("2.5", "day"), Q.FEED_BASIS + "2.5_day.geojson");
  assert.strictEqual(Q.feedUrl("significant", "month"), Q.FEED_BASIS + "significant_month.geojson");
  assert.ok(Q.feedUrl().indexOf("earthquake.usgs.gov") > -1, "der Host muss stimmen");
  // Keine Abfrageparameter: die festen Zusammenfassungsdateien brauchen keine
  // Datumsrechnerei - genau deshalb wurden sie gewaehlt.
  assert.strictEqual(Q.feedUrl().indexOf("?"), -1, "die Feed-Datei darf keine Parameter brauchen");
  console.log("Block 1/6 (URL: feste Feed-Dateien, kein Datum in der URL): OK");
}

// ---------------------------------------------------------------------------
// 2. Normalfall: Punkte kommen an, staerkste zuerst
// ---------------------------------------------------------------------------
{
  const r = Q.parseQuakes(antwort([
    beben({ id: "a", mag: 4.8, lon: 140.1, lat: 35.7, ort: "Japan", tiefe: 30 }),
    beben({ id: "b", mag: 6.9, lon: -70.2, lat: -33.4, ort: "Chile", tiefe: 55, tsunami: true }),
    beben({ id: "c", mag: 5.5, lon: 28.9, lat: 41.0, ort: "Türkei" }),
  ]));

  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r.map((x) => x.id), ["b", "c", "a"],
    "absteigend nach Staerke - die schweren Beben sind die interessanten");
  assert.strictEqual(r[0].mag, 6.9);
  assert.strictEqual(r[0].lon, -70.2, "Laenge steht in coordinates[0]");
  assert.strictEqual(r[0].lat, -33.4, "Breite in coordinates[1] - die Reihenfolge ist die Falle bei GeoJSON");
  assert.strictEqual(r[0].tiefe, 55, "Tiefe in coordinates[2]");
  assert.strictEqual(r[0].tsunami, true, "das Tsunami-Kennzeichen muss durchkommen");
  assert.strictEqual(r[2].tsunami, false, "0 muss zu false werden, nicht zu einer 0");
  console.log("Block 2/6 (Normalfall: Koordinatenreihenfolge, Sortierung, Tsunami-Kennzeichen): OK");
}

// ---------------------------------------------------------------------------
// 3. Was NICHT als Erdbeben durchgehen darf
// ---------------------------------------------------------------------------
{
  const r = Q.parseQuakes(antwort([
    beben({ id: "echt", mag: 5.0, lon: 10, lat: 50 }),
    beben({ id: "sprengung", mag: 2.9, lon: 11, lat: 51, type: "quarry blast" }),
    beben({ id: "explosion", mag: 3.1, lon: 12, lat: 52, type: "explosion" }),
  ]));
  assert.deepStrictEqual(r.map((x) => x.id), ["echt"],
    "Sprengungen und Steinbrucharbeiten stehen im Feed, sind aber keine Erdbeben - sie so zu beschriften waere schlicht falsch");
  console.log("Block 3/6 (Sprengungen werden nicht als Erdbeben gezeigt): OK");
}

// ---------------------------------------------------------------------------
// 4. Kaputte und unmoegliche Eintraege
// ---------------------------------------------------------------------------
{
  const r = Q.parseQuakes(antwort([
    beben({ id: "gut", mag: 5.0, lon: 10, lat: 50 }),
    beben({ id: "ohneMag", mag: null, lon: 11, lat: 51 }),
    beben({ id: "lonFalsch", mag: 5.0, lon: 999, lat: 51 }),
    beben({ id: "latFalsch", mag: 5.0, lon: 11, lat: -200 }),
    { id: "ohneGeometrie", properties: { mag: 5.0, type: "earthquake" } },
    { id: "leereKoordinaten", properties: { mag: 5.0, type: "earthquake" }, geometry: { coordinates: [] } },
    { id: "textKoordinaten", properties: { mag: 5.0, type: "earthquake" }, geometry: { coordinates: ["a", "b"] } },
    null, 42, "kaputt",
  ]));
  assert.deepStrictEqual(r.map((x) => x.id), ["gut"],
    "jeder unbrauchbare Eintrag wird uebersprungen, der brauchbare bleibt");

  // Grenzwerte sind gueltig und muessen durchkommen.
  const rand = Q.parseQuakes(antwort([
    beben({ id: "datumsgrenze", mag: 5, lon: 180, lat: 90 }),
    beben({ id: "gegenueber", mag: 5, lon: -180, lat: -90 }),
  ]));
  assert.strictEqual(rand.length, 2, "genau -180/180 und -90/90 sind gueltige Koordinaten");

  // Fehlende Tiefe -> null, nicht 0 (0 km waere "direkt an der Oberflaeche").
  const ohneTiefe = Q.parseQuakes(antwort([
    { id: "x", properties: { mag: 5, type: "earthquake" }, geometry: { coordinates: [10, 50] } },
  ]));
  assert.strictEqual(ohneTiefe[0].tiefe, null, "fehlende Tiefe -> null, keine 0");

  assert.deepStrictEqual(Q.parseQuakes(null), [], "keine Antwort -> leer");
  assert.deepStrictEqual(Q.parseQuakes({}), []);
  assert.deepStrictEqual(Q.parseQuakes({ features: "nichts" }), []);
  console.log("Block 4/6 (kaputte Eintraege werden uebersprungen, Grenzwerte bleiben, keine erfundenen Werte): OK");
}

// ---------------------------------------------------------------------------
// 5. Obergrenze
// ---------------------------------------------------------------------------
{
  const viele = [];
  for (let i = 0; i < 500; i++) viele.push(beben({ id: "n" + i, mag: 4 + (i % 40) / 10, lon: (i % 360) - 180, lat: (i % 180) - 90 }));
  const r = Q.parseQuakes(antwort(viele));
  assert.strictEqual(r.length, 300, "Standard-Obergrenze schuetzt die Karte vor Ueberfuellung");
  // Gekappt wird UNTEN, nicht oben: die staerksten Beben muessen erhalten bleiben.
  const alle = Q.parseQuakes(antwort(viele), 500);
  assert.strictEqual(r[0].mag, alle[0].mag, "das staerkste Beben darf durch die Kappung nicht verschwinden");
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].mag >= r[i].mag, "die Reihenfolge muss auch nach der Kappung absteigend sein");
  }
  assert.strictEqual(Q.parseQuakes(antwort(viele), 5).length, 5, "die Grenze ist einstellbar");
  console.log("Block 5/6 (Obergrenze kappt die schwachen, nicht die schweren Beben): OK");
}

// ---------------------------------------------------------------------------
// 6. Punktgroesse und Zusammenfassung
// ---------------------------------------------------------------------------
{
  // Die Magnitudenskala ist logarithmisch - der Radius darf es nicht linear
  // abbilden, sonst sehen schwere Beben wie eine Randnotiz aus.
  const r4 = Q.radius(4), r5 = Q.radius(5), r6 = Q.radius(6), r7 = Q.radius(7);
  assert.ok(r4 < r5 && r5 < r6 && r6 < r7, "der Radius muss mit der Staerke wachsen");
  assert.ok((r7 - r6) > (r5 - r4), "und zwar ueberproportional - ein M7 setzt rund 1000-mal so viel Energie frei wie ein M5");
  assert.ok(Q.radius(9) <= 9, "nach oben gedeckelt, sonst verdeckt ein schweres Beben die halbe Karte");
  assert.strictEqual(Q.radius(null), 0, "ohne Staerke kein Punkt");
  assert.ok(Q.radius(1) >= 0, "sehr schwache Beben duerfen keinen negativen Radius ergeben");

  const z = Q.zusammenfassung(Q.parseQuakes(antwort([
    beben({ id: "a", mag: 7.1, lon: 140, lat: 35, tsunami: true }),
    beben({ id: "b", mag: 6.2, lon: -70, lat: -33 }),
    beben({ id: "c", mag: 4.6, lon: 28, lat: 41 }),
  ])));
  assert.strictEqual(z.anzahl, 3);
  assert.strictEqual(z.staerkstes.mag, 7.1, "das staerkste Beben steht vorn");
  assert.strictEqual(z.abM6, 2, "ab Staerke 6 gezaehlt");
  assert.strictEqual(z.mitTsunami, 1);
  assert.strictEqual(Q.zusammenfassung([]), null, "ohne Beben keine Zusammenfassung");
  assert.strictEqual(Q.zusammenfassung(null), null);
  console.log("Block 6/6 (Radius waechst ueberproportional und gedeckelt, Zusammenfassung stimmt): OK");
}

console.log("\nAlle geo-quakes.js-Tests erfolgreich.");
