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
     Bilanzwert.
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
