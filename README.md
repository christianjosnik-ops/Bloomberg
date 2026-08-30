# Bloomberg-Terminal (Eigenbau)

Finanz-Terminal als **statische Seite**: eine einzelne `index.html` mit React
(per CDN, Babel kompiliert den App-Quelltext im Browser), dazu ein paar
Netlify-Functions als serverseitige Proxys zu externen Datenquellen.

Es gibt **keinen Build-Schritt** und **keine npm-Abhaengigkeiten**. Was im
Repository liegt, ist genau das, was ausgeliefert wird.

## Aufbau

```
index.html                   App-Huelle: CSS, Boot-Code und der komplette
                             React-Quelltext (JSX, wird zur Laufzeit von
                             Babel kompiliert)

assets/js/                   Reine Rechenlogik, ohne JSX und ohne Babel.
                             Dual-Export (CommonJS + globales Objekt): laeuft
                             unveraendert im Browser (<script src>) UND in den
                             Node-Tests.
  ratios.js                  Kennzahlen aus normalisierten Jahresabschluessen
  peers.js                   Peer-Vergleich: Median + Perzentil-Rang
  indicators.js              Chart-Indikatoren (SMA, RSI) + Zusammenfassen
                             von Balken zu groesseren Kerzen
  mc.js                      Monte-Carlo-Simulation der Bewertungs-Bandbreite
  geo-quakes.js              USGS-Erdbeben als Punktdaten fuer die Weltkarte
  theme.js                   Farben, Formatierung, Anzeige-Metadaten
  market-data.js             Presets/Konstanten + Datenbeschaffungs-Helfer

netlify/functions/           Serverseitige Proxys (CommonJS, nur Node)
  quote.js                   Yahoo-Finance-Proxy (Kurse, Kennzahlen, Profil)
  fred.js                    Makrodaten (F4)
  geopolitics.js             Weltlage aus UCDP + GDELT (F6)
  diag.js                    Diagnose: probiert jede Quelle einzeln an
  lib/
    providers.js             Fallback-Ketten + Circuit Breaker
    normalizer.js            Yahoo-Rohfelder -> einheitliches Bilanz-Schema
                             (quoteSummary, aeltere Schnittstelle)
    fundamentals.js          Jahresabschluesse ueber fundamentals-timeseries
                             (aktuelle Schnittstelle) + Zusammenfuehren beider
    geo-countries.js         Laenderreferenz fuer das Weltlage-Modul

test/                        Tests, eine Datei je Modul
```

Warum die Trennung `index.html` / `assets/js`: alles in `assets/js` ist frei von
JSX und DOM-Zugriffen. Das haelt die Menge an Code klein, die Babel bei jedem
Seitenaufruf live kompilieren muss, und macht die Logik in Node testbar.

## Tests

Kein Test-Framework, nur Node-Bordmittel (`assert`). Alle externen HTTP-Aufrufe
sind in den Tests gefakt, es wird also kein Netzwerkzugriff gebraucht.

```sh
sh test/run.sh          # alle Tests, Exit-Code != 0 bei Fehlschlag
node test/ratios.test.js   # einzelne Datei
```

## Lokal ansehen

Ein beliebiger statischer Server im Repository-Wurzelverzeichnis reicht:

```sh
python3 -m http.server 8000
```

Die Seite laedt dann unter `http://localhost:8000`. Die Netlify-Functions
laufen so allerdings nicht mit - dafuer die Netlify-CLI benutzen
(`netlify dev`), sonst bleiben die Panels ohne Daten.

## Umgebungsvariablen

In den Netlify-Einstellungen der Seite zu hinterlegen, nicht im Repository:

| Variable            | Wofuer                                        | Pflicht |
| ------------------- | --------------------------------------------- | ------- |
| `FRED_API_KEY`      | Makrodaten (FRED verlangt seit 11/2025 einen Schluessel) | ja, sonst bleibt F4 leer |
| `UCDP_ACCESS_TOKEN` | Konfliktdaten fuer die Weltlage (UCDP)        | nein, aber ohne ihn laeuft F6 stark eingeschraenkt (siehe unten) |

Der FRED-Schluessel laesst sich alternativ im Startbildschirm der App
eingeben - dann bleibt er im Browser und die Server-Variable ist entbehrlich.

Finnhub- und Groq-Schluessel werden ausschliesslich in der App eingegeben und
liegen im Browser, nie auf dem Server.

### UCDP-Zugangstoken beantragen

UCDP liefert die dynamische Liste aktiver Konfliktlaender. Der Zugang ist
kostenlos, verlangt aber seit Kurzem einen Token (ohne ihn antwortet die API
mit `HTTP 401 – API token required`).

Der Token wird **nicht automatisch** vergeben, es gibt kein Web-Formular. Man
schreibt eine Mail:

- **An:** `mertcan.yilmaz@pcr.uu.se` (allgemeine Rueckfragen: `ucdp@pcr.uu.se`)
- **Betreff:** `UCDP API Access Request`
- **Inhalt:** vollstaendiger Name, Zugehoerigkeit (Universitaet/Firma/privat),
  Rolle (z.B. Studierender, Journalist, Analyst) und eine kurze Beschreibung,
  wozu die Daten genutzt werden sollen

Antwort kommt laut UCDP innerhalb von 3-5 Werktagen. Das Kontingent liegt bei
5000 Anfragen/Tag - fuer diese App bei 20 Minuten Cache weit mehr als genug.

Doku: https://ucdp.uu.se/apidocs/

Danach in Netlify unter *Site configuration → Environment variables* als
`UCDP_ACCESS_TOKEN` hinterlegen. Die App schickt ihn als Header
`x-ucdp-access-token`.

**Ohne Token** faellt F6 auf die handgepflegte 20-Laender-Liste in
`netlify/functions/lib/geo-countries.js` zurueck, und die Risikoeinstufung
haengt allein am GDELT-Nachrichtenvolumen - die Stufe "kritisch" ist dann
rechnerisch nicht mehr erreichbar, weil sie eine offizielle Konfliktquelle
voraussetzt.

## Monte Carlo (Bewertungs-Bandbreite)

Ein DCF liefert immer genau eine Zahl und taeuscht damit eine Genauigkeit vor,
die es nicht gibt: das Ergebnis haengt an Wachstum, Kapitalkosten und ewigem
Wachstum, und kleine Verschiebungen dort bewegen den fairen Wert zweistellig.

Der Reiter **F7 MONTE CARLO** spielt die Rechnung 4000 Mal mit zufaellig
gezogenen Annahmen durch. Jeder Durchlauf erscheint waehrend des Rechnens
als einzelner Punkt; die gestrichelte Linie ist der heutige Boersenwert.

Die eigentliche Aussage steht unter dem Bild: **in wie viel Prozent der
Durchlaeufe** lag der errechnete Wert ueber dem Boersenwert. "Bei fast jeder
Annahme guenstig" ist etwas voellig anderes als "guenstig nur, wenn man
optimistisch rechnet" - und genau diese Unterscheidung ist der Grund, ueberhaupt
zu simulieren. Keine Prognose, keine Anlageberatung.

Technisches:

- `assets/js/mc.js` enthaelt nur Simulation und Statistik, keine eigene
  Finanzlogik: Free Cashflow kommt aus den Bilanzzeilen, `netDebt` aus
  `ratios.js`, der Boersenwert aus den Kursdaten (gleiche Arbeitsteilung wie
  `peers.js`).
- **Woher der freie Cashflow kommt**, ist nicht selbstverstaendlich: Yahoo
  liefert die Kapitalflussrechnung nicht fuer jeden Titel. `freeCashflow()`
  arbeitet deshalb eine Kette ab und meldet mit, worauf das Ergebnis beruht -
  der Reiter zeigt das an, damit eine Naeherung nicht wie der echte Cashflow
  aussieht:
  1. `ocf` - operativer Cashflow minus Investitionen (der echte freie Cashflow)
  2. `fcff` - EBIT nach Steuern + Abschreibungen minus Investitionen
     (Naeherung, mit ⚠ gekennzeichnet)
  3. `hand` - von Hand eingetragen. Faellt beides aus, gibt es ein Eingabefeld
     statt einer Sackgasse; es ueberschreibt auch sonst jederzeit den
     Bilanzwert. Beim Wechsel des Wertes wird es zurueckgesetzt - sonst gaelte
     ein fuer Firma A eingetragener Cashflow stillschweigend auch fuer Firma B.
- **Negativer freier Cashflow**: Ein DCF braucht einen positiven Ausgangswert;
  ein negativer wird durch das Wachstum nur negativer. Statt bloss abzulehnen,
  unterscheidet der Reiter zwei Faelle - `freeCashflowLage()` wertet dafuer ALLE
  vorhandenen Jahre aus:
  - **Einzelnes Investitions-/Sonderjahr** (Mehrheit der Jahre positiv und
    Mehrjahresschnitt positiv): Der Schnitt wird als Ausgangswert angeboten,
    die negativen Jahre eingerechnet. Ein Knopf uebernimmt ihn.
  - **Dauerhaft negativ**: Dann ist ein DCF unanwendbar, nicht bloss ungenau -
    das wird gesagt, samt Hinweis auf Umsatzmultiplikatoren als ueblichen Weg.
  Die Mehrheitsbedingung verhindert Rosinenpickerei: ein einzelnes sehr gutes
  Jahr, das den Schnitt allein ins Positive zieht, taugt nicht als Grundlage.
- Eigener Zufallsgenerator mit **Startwert** statt `Math.random()`. Nur so sind
  die Tests reproduzierbar - und derselbe Startwert liefert denselben Lauf.
- Gerechnet wird **stapelweise** ueber `requestAnimationFrame`, damit der
  Browser waehrenddessen nicht einfriert. Ein Test sichert, dass viele kleine
  Stapel Wert fuer Wert dasselbe ergeben wie ein Lauf am Stueck.
- Annahmen, bei denen die Formel nicht definiert ist (Kapitalkosten unter dem
  ewigen Wachstum), werden **verworfen und gezaehlt**, nie stillschweigend
  ersetzt. Die Zahl steht im Fenster.

## Kerzencharts

Der Chart im Marktreiter laesst sich zwischen **LINIE** und **KERZEN**
umschalten. Yahoo und Stooq liefern Open/Hoch/Tief je Balken bereits mit; sie
werden in `quote.js` je Balken uebernommen (`o`/`h`/`l` neben `p`/`v`).

- Liefert eine Quelle keine Open/Hoch/Tief-Werte, bleibt die Linie stehen und
  sagt warum - statt einer leeren Flaeche.
- Bei langen Zeitraeumen wird zusammengefasst (5 Jahre = ~1250 Tagesbalken ->
  etwa Wochenkerzen), sonst waere jede Kerze unter einem Pixel breit. Die Regel
  steckt in `indicators.js` (`groupSizeFor`/`aggregateOHLC`) und ist getestet:
  Open vom ersten Balken, Close vom letzten, Hoch/Tief aus der ganzen Gruppe.
- Einzelne Balken ohne Open/Hoch/Tief (Yahoo-Luecken an Feiertagen) entfallen
  als Kerze, bleiben aber als Linienpunkt erhalten - sie erfinden kein
  Hoch/Tief und heben auch das Gruppen-Hoch nicht an.

## Suchvorschlaege

Vorschlaege erscheinen ab **drei** eingetippten Zeichen (`SUGGEST_MIN` in
`index.html` - eine Konstante fuer beide Stellen, die die Schwelle brauchen).

Die Liste kommt zweistufig: Treffer aus den lokalen Presets stehen sofort da,
die Yahoo-Suche wird nachtraeglich dazugemischt. Das ist wichtig, weil die
Netzsuche im schlechten Fall bis zum Suchbudget von 5 Sekunden braucht -
solange darf ein bereits bekannter Vorschlag nicht zurueckgehalten werden.
Waehrend das Netz noch antwortet, steht "sucht…"; "Keine Treffer" erscheint
erst, wenn auch die Netzsuche durch ist.

## Fundamentaldaten: zwei Quellen

Die Jahresabschluesse kamen urspruenglich nur ueber
`quoteSummary?modules=balanceSheetHistory,incomeStatementHistory,cashflowStatementHistory`.
Das ist Yahoos **aeltere** Schnittstelle; sie antwortet fuer viele Titel
inzwischen ohne Kapitalflussrechnung. Sichtbar wurde das daran, dass operativer
Cashflow und Investitionen fehlten - und ohne die stehen sowohl die FCF-Marge
(F5 RATIO) als auch die Bewertung (F7 MONTE CARLO) ohne Zahlen da.

`quote.js` fragt deshalb **beide** Schnittstellen im selben Parallelblock ab
(kostet keine zusaetzliche Wartezeit) und fuehrt sie **feldweise** zusammen:

- Vorrang hat `fundamentals-timeseries` - der Weg, den Yahoos eigene Oberflaeche
  heute geht. Sie liefert auch Felder, die die alte Schnittstelle nicht kennt,
  darunter den fertigen freien Cashflow (`annualFreeCashFlow`).
- `quoteSummary` fuellt nur noch Luecken. Feldweise statt "ganzer Satz oder gar
  nicht", weil in der Praxis oft Bilanz und GuV aus der einen und die
  Kapitalflussrechnung aus der anderen Quelle kommt.
- TTM-Punkte werden **nicht** unter die Geschaeftsjahre gemischt - dieselbe
  Regel wie in `normalizer.js`.
- `out.fundamentalsQuellen` meldet, wie viele Jahreszeilen jede Quelle
  beigesteuert hat. Faellt eine aus, sieht man das, statt zu raten.

Ob die Quellen live liefern, zeigt die **F9-Diagnose**: die Proben
`yahoo-fundamentals-timeseries` (mit inhaltlicher Pruefung, ob der operative
oder freie Cashflow tatsaechlich dabei ist) und `yahoo-fundamentals-quotesummary`
als Vergleich.

## Geodaten: warum USGS

Die Weltlage (F6) hatte bis dahin **keine einzige Quelle mit Koordinaten**:
UCDP nennt Laendernamen, GDELT zaehlt Nachrichtenartikel je Land. Auf der Karte
liess sich damit nur flaechig einfaerben.

Die USGS-Erdbeben schliessen diese Luecke - und zwar als eine der wenigen
Quellen, die **ohne Zugangstoken, ohne registrierten Appnamen und ohne Antrag
per Mail** auskommen. Nach UCDP (Token, 3-5 Werktage Bearbeitung) und ReliefWeb
(genehmigter Appname, deshalb entfernt) war genau das das Auswahlkriterium: eine
Quelle, die nicht eines Tages eine Registrierung nachschiebt.

Technisches:

- Abgerufen wird die **feste Zusammenfassungsdatei**
  `.../summary/4.5_week.geojson`, nicht die Abfrage-Schnittstelle mit
  `starttime=`. Damit entfaellt jede Datumsrechnerei in der URL - eine falsch
  gebildete Zeitangabe liefert sonst stillschweigend ein leeres Fenster.
- **Aus dem Browser**, nicht aus der Netlify-Function: `geopolitics.js` laeuft
  bereits am Anschlag seines Zeitbudgets (UCDP 2500 ms + drei GDELT-Wellen a
  2500 ms = 8500 ms unter Netlifys 10-s-Grenze). Der USGS setzt CORS-Kopfzeilen,
  und die Laendergrenzen der Karte werden ohnehin schon direkt von einem CDN
  geladen. Nebeneffekt: Die Beben erscheinen auch dann, wenn die
  geopolitics-Function komplett ausfaellt.
- **Ab Staerke 4.5, letzte 7 Tage**: weltweit rund 100-250 Beben - genug fuer
  ein Bild, wenig genug, dass die Karte lesbar bleibt. Bei 2.5 waeren es mehrere
  tausend und die Punktwolke saehe ueberall gleich dicht aus.
- Der Punktradius waechst **ueberproportional** zur Magnitude. Die Skala ist
  logarithmisch: ein M7 setzt rund 1000-mal so viel Energie frei wie ein M5 -
  ein linearer Radius liesse schwere Beben wie eine Randnotiz aussehen.
- Sprengungen und Steinbrucharbeiten stehen mit im Feed (`type` != `earthquake`)
  und werden **nicht** als Erdbeben gezeigt.
- Faellt der Abruf aus, bleibt die Karte vollstaendig funktionsfaehig und sagt
  warum. Die Beben sind eine Ergaenzung, keine Voraussetzung.

Ob die Quelle live liefert, zeigt die F9-Diagnose: die Probe `usgs-erdbeben`
prueft **inhaltlich**, ob verwertbare Punkte mit Koordinaten herauskommen - eine
Antwort mit HTTP 200 und leerer Liste waere sonst faelschlich gruen.

## GDELT: Fehler nennen die Ursache

Im Betrieb stand in der Laenderliste ueberall "0 Meldungen". Das Problem war
weniger die Zahl als die Ununterscheidbarkeit: ein AUSFALL und ein echtes
Leerergebnis sahen identisch aus.

Zwei Ursachen dafuer, beide behoben:

1. `geopolitics.js` las die Antwort mit `res.json()`. GDELT meldet Fehler aber
   im **Klartext** und dabei haeufig mit **HTTP 200** ("Your query was too short
   or too long", Drosselungsmeldungen). `res.json()` warf dann nur "Unexpected
   token" - eine Aussage ueber die Antwortform, keine ueber die Ursache. Jetzt
   wird erst der Text gelesen, dann geparst, und im Fehlerfall steht der Anfang
   der Antwort im Wortlaut in der Meldung. Dieselbe Lehre, die fuer ReliefWeb
   schon gezogen war - fuer GDELT war sie nie angewandt worden.

2. Die Function ermittelte den Fehler **je Land** korrekt, das Frontend warf ihn
   aber weg und zeigte pauschal "Zeitbudget erreicht". Jetzt steht der echte
   Fehlertext im Detailpanel, und ueber der Karte erscheint eine Sammelmeldung
   ("GDELT: 18 von 20 Laendern ohne Ergebnis - ..."), sobald ueberhaupt ein Land
   fehlschlaegt. Faellt die Mehrheit aus, klappt zusaetzlich die Diagnose auf.

Ebenfalls getrennt: eine Antwort **ohne** `articles`-Feld ist ein Fehler
(Antwortform unerwartet), ein **leeres** `articles`-Feld ist ein gueltiges
Ergebnis (nichts gefunden). Beides als "0 Meldungen" zu zeigen verwischt genau
den Unterschied, der bei der Fehlersuche zaehlt.
