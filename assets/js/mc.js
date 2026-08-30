// mc.js — Monte-Carlo-Simulation fuer die Bewertungs-Bandbreite (Reiter F7).
//
// Kernidee: Ein DCF (abgezinster Cashflow) liefert IMMER genau eine Zahl - und
// taeuscht damit eine Genauigkeit vor, die es nicht gibt. Das Ergebnis haengt an
// drei Annahmen (Wachstum, Kapitalkosten, ewiges Wachstum), und schon kleine
// Verschiebungen dort bewegen den fairen Wert um zweistellige Prozentsaetze.
// Statt einer Scheingenauigkeit wird die Rechnung deshalb viele tausend Mal mit
// gestreuten Annahmen durchgespielt; heraus kommt eine VERTEILUNG moeglicher
// Werte. Die Aussage lautet dann nicht "fair sind 142" sondern "in 8 von 10
// Durchlaeufen lag der faire Wert 20-95% ueber dem Boersenwert".
//
// ARBEITSTEILUNG (wie bei peers.js): Dieses Modul enthaelt KEINE eigene
// Finanzlogik-Herleitung. Es bekommt fertige Groessen uebergeben, die anderswo
// berechnet wurden - fcf0 aus den normalisierten Bilanzzeilen, netDebt aus
// ratios.js, marketCap aus den Kursdaten. Hier drin steckt nur Simulation:
// Zufallsziehung, Barwertrechnung, Statistik ueber die Ergebnisse.
//
// Dual-Export wie ratios.js/peers.js/indicators.js: laeuft unveraendert in Node
// (test/mc.test.js) und im Browser (<script src="assets/js/mc.js">, ohne Babel -
// deshalb bewusst kein Optional Chaining/Nullish Coalescing, nur breit
// unterstuetztes ES6). Kein Fetch, kein DOM.

(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.MC = mod;
})(typeof self !== "undefined" ? self : this, function () {

  function isNum(x) { return typeof x === "number" && isFinite(x); }

  // ---- Zufallszahlen -------------------------------------------------------
  //
  // EIGENER GENERATOR STATT Math.random(): Math.random() laesst sich nicht mit
  // einem Startwert versehen. Ein Test koennte dann nur pruefen "das Ergebnis
  // liegt irgendwo im Plausiblen" - jede exakte Zusicherung waere zufaellig mal
  // gruen, mal rot. Mit Startwert ist derselbe Lauf reproduzierbar: die Tests
  // koennen konkrete Zahlen festnageln, und ein Nutzer kann denselben Lauf
  // wiederholen und bekommt exakt dieselbe Verteilung.
  //
  // mulberry32: kleiner, schneller 32-Bit-Generator. Fuer eine Bewertungs-
  // Bandbreite voellig ausreichend - hier wird nichts verschluesselt.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Dreiecksverteilung statt Normalverteilung. Gruende:
  //   1. Sie ist so parametrisiert, wie ein Mensch eine Annahme tatsaechlich
  //      formuliert: "mindestens X, am ehesten Y, hoechstens Z".
  //   2. Sie ist BEGRENZT. Eine Normalverteilung zieht mit kleiner
  //      Wahrscheinlichkeit auch -40% Wachstum oder 90% Kapitalkosten; solche
  //      Ausreisser wuerden die Verteilung verzerren, ohne etwas auszusagen.
  function triangular(rng, min, mode, max) {
    if (!(max > min)) return min;
    var u = rng();
    var c = (mode - min) / (max - min);
    if (u < c) return min + Math.sqrt(u * (max - min) * (mode - min));
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }

  // ---- Bewertung eines einzelnen Durchlaufs ---------------------------------
  //
  // Zweistufiges DCF: `years` Jahre explizit hochgerechnet, danach ein
  // Fortfuehrungswert (Gordon-Wachstumsformel) fuer alles Spaetere.
  //
  // Rueckgabe null statt einer Zahl, wenn die Annahmenkombination die Rechnung
  // unbrauchbar macht - NIEMALS ein Ersatzwert. Zwei Faelle:
  //   - discountRate <= terminalGrowth: der Fortfuehrungswert waere negativ oder
  //     unendlich ("die Firma waechst fuer immer schneller, als man abzinst").
  //     Das ist keine Randnotiz, sondern taucht bei breiten Annahmebaendern
  //     regelmaessig auf - deshalb wird es gezaehlt und im Fenster angezeigt.
  //   - fcf0 <= 0: eine Firma, die Geld verbrennt, laesst sich so nicht
  //     bewerten. Dann ist ein DCF das falsche Werkzeug, nicht bloss ungenau.
  function dcfEquityValue(p) {
    if (!p || !isNum(p.fcf0) || p.fcf0 <= 0) return null;
    if (!isNum(p.discountRate) || !isNum(p.terminalGrowth) || !isNum(p.growth)) return null;
    if (p.discountRate <= p.terminalGrowth) return null;

    var years = p.years || 10;
    var r = p.discountRate;
    var pv = 0;
    var fcf = p.fcf0;
    for (var t = 1; t <= years; t++) {
      fcf = fcf * (1 + p.growth);
      pv += fcf / Math.pow(1 + r, t);
    }
    // Fortfuehrungswert auf Basis des LETZTEN Prognosejahres, abgezinst auf heute.
    var terminal = (fcf * (1 + p.terminalGrowth)) / (r - p.terminalGrowth);
    var enterprise = pv + terminal / Math.pow(1 + r, years);
    // Firmenwert -> Eigenkapitalwert: Nettoschulden gehoeren den Glaeubigern.
    // netDebt kommt aus ratios.js (totalDebt - cash), wird hier nicht neu hergeleitet.
    var netDebt = isNum(p.netDebt) ? p.netDebt : 0;
    return enterprise - netDebt;
  }

  // ---- Ein Stapel Durchlaeufe ----------------------------------------------
  //
  // BEWUSST STAPELWEISE statt "alles auf einmal": Das Fenster soll die
  // Simulation live mitlaufen zeigen. Dafuer ruft die Oberflaeche diese
  // Funktion viele Male mit kleinem n auf und zeichnet zwischendurch neu.
  // Wuerde hier alles in einer Schleife durchlaufen, blockierte der Browser-
  // Hauptthread und die Seite froere ein, bis alles fertig ist - auf dem Handy
  // sekundenlang. Der Generator (rng) wird von aussen durchgereicht, damit die
  // Stapel eine EINZIGE fortlaufende Zufallsfolge bilden und das Ergebnis
  // unabhaengig von der Stapelgroesse ist.
  //
  // Rueckgabe: { values: [...], skipped: n } - values sind Eigenkapitalwerte in
  // derselben Waehrungseinheit wie fcf0/netDebt.
  function runBatch(n, params, rng) {
    var values = [];
    var skipped = 0;
    for (var i = 0; i < n; i++) {
      var draw = {
        fcf0: params.fcf0,
        netDebt: params.netDebt,
        years: params.years,
        growth: triangular(rng, params.growth.min, params.growth.mode, params.growth.max),
        discountRate: triangular(rng, params.discountRate.min, params.discountRate.mode, params.discountRate.max),
        terminalGrowth: triangular(rng, params.terminalGrowth.min, params.terminalGrowth.mode, params.terminalGrowth.max),
      };
      var v = dcfEquityValue(draw);
      if (v == null) skipped++; else values.push(v);
    }
    return { values: values, skipped: skipped };
  }

  // ---- Statistik ueber die Ergebnisse --------------------------------------

  // Perzentil mit linearer Interpolation. Erwartet ein AUFSTEIGEND sortiertes
  // Array - Sortieren ist Sache des Aufrufers, damit bei vielen Perzentilen aus
  // demselben Datensatz nicht jedes Mal neu sortiert wird.
  function percentile(sorted, p) {
    if (!sorted || !sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    var idx = (sorted.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // marketCap ist optional. Fehlt er, gibt es keine Ueber-/Unterbewertungs-
  // Aussage (upside* bleibt null) - die Wertverteilung selbst steht trotzdem.
  // Genau die Regel wie ueberall im Projekt: fehlender Input -> null, nie ein
  // stillschweigender Ersatzwert.
  function summarize(values, marketCap) {
    if (!values || !values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < sorted.length; i++) sum += sorted[i];

    var out = {
      n: sorted.length,
      mean: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p10: percentile(sorted, 0.10),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.50),
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.90),
      upsideP10: null, upsideP50: null, upsideP90: null, shareAboveMarket: null,
    };

    if (isNum(marketCap) && marketCap > 0) {
      out.upsideP10 = out.p10 / marketCap - 1;
      out.upsideP50 = out.p50 / marketCap - 1;
      out.upsideP90 = out.p90 / marketCap - 1;
      // Der eigentlich interessante Wert: in wie vielen Durchlaeufen kam ueberhaupt
      // ein Wert ueber dem Boersenwert heraus? "Billig bei fast jeder Annahme"
      // (hoher Anteil) ist eine voellig andere Aussage als "billig nur, wenn man
      // optimistisch rechnet" (Anteil um 50%) - und genau diese Unterscheidung
      // ist der Grund, warum hier ueberhaupt simuliert wird.
      var above = 0;
      for (var j = 0; j < sorted.length; j++) { if (sorted[j] > marketCap) above++; }
      out.shareAboveMarket = above / sorted.length;
    }
    return out;
  }

  // Histogramm fuer die Balkenanzeige im Fenster. Feste Grenzen (from/to) statt
  // "Bins aus den Daten ableiten", damit sich die Achse waehrend des laufenden
  // Simulierens NICHT staendig verschiebt - sonst zappelt die Anzeige und man
  // kann dem Aufbau nicht zusehen.
  function histogram(values, from, to, bins) {
    var count = new Array(bins).fill(0);
    if (!(to > from)) return count;
    var w = (to - from) / bins;
    for (var i = 0; i < values.length; i++) {
      var b = Math.floor((values[i] - from) / w);
      if (b < 0) b = 0;
      if (b >= bins) b = bins - 1;
      count[b]++;
    }
    return count;
  }

  // ---- Freier Cashflow: Rueckfallkette -------------------------------------
  //
  // WARUM EINE KETTE: Der operative Cashflow ist der sauberste Ausgangswert,
  // kommt aber nicht bei jedem Wert an. Yahoo liefert die Kapitalflussrechnung
  // nicht fuer jeden Titel und benennt ihre Felder nicht ueber alle
  // API-Generationen gleich (siehe Warnung im Kopf von normalizer.js: die
  // Feldnamen sind nicht live verifiziert). Ohne Rueckfallebene faellt die
  // ganze Bewertung wegen EINES fehlenden Feldes aus.
  //
  // Reihenfolge, von genau nach grob. Jede Stufe meldet mit, WORAUF sie beruht -
  // die Oberflaeche zeigt das an, damit eine Naeherung nicht wie der echte
  // Cashflow aussieht:
  //
  //   1. "ocf"  operativer Cashflow - |Investitionen|
  //             Der tatsaechliche freie Cashflow. Identische Rechnung wie
  //             fcfMargin in ratios.js - bewusst mit Math.abs, damit ein
  //             positiv geliefertes capex nicht faelschlich addiert wird.
  //
  //   2. "fcff" EBIT x (1 - Steuerquote) + Abschreibungen - |Investitionen|
  //             Lehrbuch-Naeherung (Free Cashflow to Firm) ohne die
  //             Veraenderung des Working Capital. Taugt als Ausgangswert,
  //             ist aber eine Schaetzung - wird als solche gekennzeichnet.
  //
  // Beide brauchen capex. Ohne Investitionen gibt es keinen FREIEN Cashflow,
  // nur einen Zufluss - dann liefert die Funktion null statt einer Zahl, die
  // etwas anderes misst als ihr Name sagt.
  function freeCashflow(row) {
    if (!row) return null;

    // Stufe 0: Yahoo liefert den freien Cashflow ueber den Zeitreihen-Endpunkt
    // fertig mit (annualFreeCashFlow). Wenn er da ist, ist er dem Selbstrechnen
    // vorzuziehen - Yahoo beruecksichtigt dabei Posten, die "operativer
    // Cashflow minus Investitionen" nicht sieht. Braucht kein capex.
    if (isNum(row.freeCashflowReported)) {
      return {
        wert: row.freeCashflowReported,
        basis: "reported",
        label: "freier Cashflow laut Jahresabschluss",
        genau: true,
      };
    }

    if (!isNum(row.capex)) return null;
    var invest = Math.abs(row.capex);

    if (isNum(row.operatingCashflow)) {
      return {
        wert: row.operatingCashflow - invest,
        basis: "ocf",
        label: "operativer Cashflow − Investitionen",
        genau: true,
      };
    }

    if (isNum(row.operatingIncome) && isNum(row.depreciationAmortization)) {
      // Steuerquote aus der GuV, sonst 25%. Gedeckelt auf 0..60%: eine aus
      // Sondereffekten entstandene Quote von 300% (oder eine negative bei
      // Verlustjahren) wuerde den Ausgangswert sonst voellig entstellen.
      var t = 0.25;
      if (isNum(row.taxExpense) && isNum(row.pretaxIncome) && row.pretaxIncome > 0) {
        var roh = row.taxExpense / row.pretaxIncome;
        if (roh > 0 && roh < 0.6) t = roh;
      }
      return {
        wert: row.operatingIncome * (1 - t) + row.depreciationAmortization - invest,
        basis: "fcff",
        label: "EBIT nach Steuern + Abschreibungen − Investitionen (Näherung, operativer Cashflow fehlt)",
        genau: false,
        steuerquote: t,
      };
    }

    return null;
  }

  // ---- Der freie Cashflow ueber mehrere Jahre ------------------------------
  //
  // WOZU: suggestParams nimmt das NEUESTE Jahr als Ausgangswert. Ist genau das
  // negativ, faellt die Bewertung aus - obwohl das oft nur ein einzelnes Jahr
  // betrifft: eine grosse Uebernahme, ein Investitionszyklus, ein Rechtsstreit.
  // Eine Firma, die neun Jahre Geld verdient und im zehnten stark investiert,
  // ist nicht unbewertbar. Ohne den Blick auf die Reihe sieht man den
  // Unterschied zwischen "einmaliger Ausreisser" und "verbrennt dauerhaft
  // Geld" aber gar nicht - und genau der entscheidet, ob ein DCF hier taugt.
  function freeCashflowSeries(rows) {
    var out = [];
    if (!rows || !rows.length) return out;
    for (var i = 0; i < rows.length; i++) {
      var f = freeCashflow(rows[i]);
      if (f) out.push({ year: rows[i].year, wert: f.wert, basis: f.basis, genau: f.genau });
    }
    return out;
  }

  // Fasst die Reihe zu dem zusammen, was fuer die Entscheidung noetig ist.
  //
  // `schnitt` ist bewusst der Durchschnitt ueber ALLE vorhandenen Jahre, die
  // negativen eingeschlossen. Nur die guten Jahre zu mitteln waere Rosinen-
  // pickerei und wuerde genau die Firmen zu teuer bewerten, bei denen der
  // Investitionsbedarf wiederkehrt.
  function freeCashflowLage(rows) {
    var serie = freeCashflowSeries(rows);
    if (!serie.length) return null;
    var summe = 0, positive = 0;
    for (var i = 0; i < serie.length; i++) {
      summe += serie[i].wert;
      if (serie[i].wert > 0) positive++;
    }
    return {
      serie: serie,
      neuestes: serie[0],
      jahre: serie.length,
      positiveJahre: positive,
      schnitt: summe / serie.length,
      // Taugt der Durchschnitt als Ersatz-Ausgangswert? Nur wenn er positiv ist
      // UND die Mehrheit der Jahre positiv war - sonst ist ein einzelnes sehr
      // gutes Jahr der einzige Grund fuer das positive Mittel.
      schnittTaugt: (summe / serie.length) > 0 && positive * 2 > serie.length,
    };
  }

  // ---- Startannahmen aus den echten Zahlen ---------------------------------
  //
  // Leitet Vorschlagswerte aus der Historie ab, damit der Nutzer nicht vor
  // leeren Feldern sitzt. BEWUSST konservativ und gedeckelt:
  //
  //   - Das historische Umsatzwachstum wird auf -5%..+15% begrenzt. Eine Firma,
  //     die letztes Jahr 60% gewachsen ist, wird das nicht zehn Jahre lang tun;
  //     ungedeckelt uebernommen wuerde daraus eine absurde Bewertung, und zwar
  //     eine, die serioes aussieht.
  //   - Die Kapitalkosten sind eine FESTE Spanne (7-11%). Sie liessen sich aus
  //     Beta/Zinsniveau herleiten, aber dafuer fehlen hier verlaessliche Daten -
  //     eine hergeleitete Zahl waere schlechter als eine offen als Annahme
  //     gekennzeichnete. Der Nutzer kann sie im Fenster aendern.
  //
  // rows: normalizer.js-Zeilen, neuestes Jahr zuerst (wie ratios.js sie erwartet).
  function suggestParams(rows) {
    if (!rows || !rows.length) return null;
    var cur = rows[0];
    if (!cur) return null;

    var f = freeCashflow(cur);
    if (!f) return null;
    var fcf0 = f.wert;

    var g = 0.03;
    var hist = null;
    if (rows.length > 1 && isNum(cur.revenue) && isNum(rows[1].revenue) && rows[1].revenue > 0) {
      hist = cur.revenue / rows[1].revenue - 1;
      g = Math.max(-0.05, Math.min(0.15, hist));
    }

    return {
      fcf0: fcf0,
      fcfBasis: f.basis,          // "ocf" | "fcff"
      fcfLabel: f.label,          // Klartext fuer die Anzeige
      fcfGenau: f.genau,          // false = Naeherung, muss sichtbar bleiben
      years: 10,
      growth: { min: Math.max(-0.10, g - 0.04), mode: g, max: g + 0.04 },
      discountRate: { min: 0.07, mode: 0.09, max: 0.11 },
      terminalGrowth: { min: 0.005, mode: 0.02, max: 0.03 },
      histGrowth: hist,   // ungedeckelt, nur zur Anzeige ("historisch: +37%")
    };
  }

  return {
    mulberry32: mulberry32,
    freeCashflow: freeCashflow,
    freeCashflowSeries: freeCashflowSeries,
    freeCashflowLage: freeCashflowLage,
    triangular: triangular,
    dcfEquityValue: dcfEquityValue,
    runBatch: runBatch,
    percentile: percentile,
    summarize: summarize,
    histogram: histogram,
    suggestParams: suggestParams,
  };
});
