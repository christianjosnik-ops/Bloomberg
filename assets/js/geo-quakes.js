// geo-quakes.js — Erdbeben des USGS als Live-Geodaten fuer die Weltkarte (F6).
//
// WARUM DIESE QUELLE
// Die uebrige Geo-Quelle des Weltlage-Moduls liefert KEINE Koordinaten: UCDP
// nennt nur Laendernamen. Auf der Karte laesst sich damit nur flaechig
// einfaerben. Der USGS
// liefert dagegen echte Punktdaten mit Laenge/Breite - und zwar ohne
// Zugangstoken, ohne registrierten Appnamen, ohne Antrag per Mail. Nach den
// Erfahrungen mit UCDP (Token, 3-5 Werktage) und ReliefWeb (genehmigter
// Appname, deshalb entfernt) ist genau das der ausschlaggebende Punkt: eine
// Quelle, die nicht eines Tages eine Registrierung nachschiebt.
//
// WARUM IM BROWSER UND NICHT IN DER NETLIFY-FUNCTION
// Der USGS setzt CORS-Kopfzeilen, ist also direkt aus dem Browser abrufbar -
// genauso wie die Laendergrenzen der Karte schon heute direkt von einem CDN
// geladen werden. Das haelt die Netlify-Function frei von einem weiteren Abruf
// und hat einen wichtigen Nebeneffekt: Die Erdbeben erscheinen auch dann, wenn
// die geopolitics-Function ganz ausfaellt. In der Live-Diagnose antwortete der
// USGS in 246ms - er ist die zuverlaessigste Quelle dieses Reiters.
//
// Dual-Export wie die uebrigen Logikdateien: laeuft unveraendert in Node
// (test/geo-quakes.test.js) und im Browser. Kein Fetch, kein DOM - nur URL-Bau
// und Auswertung der Antwort.

(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.Quakes = mod;
})(typeof self !== "undefined" ? self : this, function () {

  function isNum(x) { return typeof x === "number" && isFinite(x); }

  // Feste Zusammenfassungs-Dateien statt der Abfrage-Schnittstelle
  // (/fdsnws/event/1/query?starttime=...). Gruende:
  //   1. Keine Datumsrechnerei in der URL - eine falsch gebildete Zeitangabe
  //      liefert stillschweigend ein leeres oder falsches Fenster.
  //   2. Der USGS erzeugt diese Dateien im Minutentakt vor und liefert sie ueber
  //      seinen Cache aus. Das ist schneller und belastet die Abfrage-
  //      Schnittstelle nicht.
  // Erlaubte Staerken: significant, 4.5, 2.5, 1.0, all
  // Erlaubte Zeitraeume: hour, day, week, month
  var FEED_BASIS = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";

  // 4.5 und "week" als Standard: Ab Staerke 4.5 sind es weltweit gut 100-250
  // Beben pro Woche - genug fuer ein aussagekraeftiges Bild, aber wenig genug,
  // dass die Karte nicht zugekleistert wird. Bei 2.5 waeren es mehrere tausend,
  // und die Punktwolke saehe ueberall gleich dicht aus.
  function feedUrl(staerke, zeitraum) {
    var s = staerke == null ? "4.5" : String(staerke);
    var z = zeitraum == null ? "week" : String(zeitraum);
    return FEED_BASIS + s + "_" + z + ".geojson";
  }

  /**
   * Wandelt die GeoJSON-Antwort in schlanke Punkte um.
   *
   * Defensiv, weil das Format nicht live geprueft werden konnte: unerwartete
   * Formen fuehren zu weniger Punkten, nie zum Absturz und nie zu einem Punkt
   * mit erfundenen Koordinaten.
   *
   * @returns {Array<{id,mag,lon,lat,tiefe,ort,zeit,tsunami,url}>} absteigend
   *          nach Staerke - die staerksten zuerst, weil genau die interessieren.
   */
  function parseQuakes(json, grenze) {
    var out = [];
    var features = json && Array.isArray(json.features) ? json.features : null;
    if (!features) return out;

    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (!f || typeof f !== "object") continue;
      var p = f.properties || {};
      var g = f.geometry || {};
      var c = Array.isArray(g.coordinates) ? g.coordinates : null;
      if (!c || c.length < 2) continue;

      var lon = c[0], lat = c[1];
      if (!isNum(lon) || !isNum(lat)) continue;
      // Ausserhalb des gueltigen Bereichs waere der Punkt auf der Karte an einer
      // willkuerlichen Stelle - lieber gar nicht zeichnen als falsch.
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;

      // Der USGS-Feed enthaelt auch Sprengungen und Steinbrucharbeiten
      // ("quarry blast", "explosion"). Die als Erdbeben zu zeigen waere
      // schlicht falsch beschriftet.
      if (p.type && p.type !== "earthquake") continue;

      // Ohne Staerke laesst sich der Punkt weder einordnen noch skalieren.
      if (!isNum(p.mag)) continue;

      out.push({
        id: f.id || (lon + "," + lat + "," + p.time),
        mag: p.mag,
        lon: lon, lat: lat,
        tiefe: isNum(c[2]) ? c[2] : null,     // km, kann fehlen
        ort: p.place || null,
        zeit: isNum(p.time) ? p.time : null,  // Millisekunden seit 1970
        tsunami: p.tsunami === 1,
        url: p.url || null,
      });
    }

    out.sort(function (a, b) { return b.mag - a.mag; });
    var max = grenze == null ? 300 : grenze;
    return out.length > max ? out.slice(0, max) : out;
  }

  // Punktgroesse auf der Karte. BEWUSST NICHT LINEAR: Die Magnitudenskala ist
  // logarithmisch - ein Beben der Staerke 7 setzt rund 1000-mal so viel Energie
  // frei wie eines der Staerke 5. Ein linearer Radius liesse die schweren Beben
  // wie eine Randnotiz aussehen. Der Exponent 1.7 spreizt sichtbar, ohne dass
  // ein Beben der Staerke 8 den halben Pazifik verdeckt.
  function radius(mag) {
    if (!isNum(mag)) return 0;
    var m = Math.max(0, mag - 3.5);
    return Math.min(1.2 + Math.pow(m, 1.7) * 0.55, 9);
  }

  // Kurzfassung fuer die Anzeige ueber der Karte.
  function zusammenfassung(quakes) {
    if (!quakes || !quakes.length) return null;
    var staerkstes = quakes[0];       // parseQuakes sortiert absteigend
    var abM6 = 0, mitTsunami = 0;
    for (var i = 0; i < quakes.length; i++) {
      if (quakes[i].mag >= 6) abM6++;
      if (quakes[i].tsunami) mitTsunami++;
    }
    return { anzahl: quakes.length, staerkstes: staerkstes, abM6: abM6, mitTsunami: mitTsunami };
  }

  return {
    FEED_BASIS: FEED_BASIS,
    feedUrl: feedUrl,
    parseQuakes: parseQuakes,
    radius: radius,
    zusammenfassung: zusammenfassung,
  };
});
