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
  indicators.js              Chart-Indikatoren (SMA, RSI)
  theme.js                   Farben, Formatierung, Anzeige-Metadaten
  market-data.js             Presets/Konstanten + Datenbeschaffungs-Helfer

netlify/functions/           Serverseitige Proxys (CommonJS, nur Node)
  quote.js                   Yahoo-Finance-Proxy (Kurse, Kennzahlen, Profil)
  fred.js                    Makrodaten (F4)
  geopolitics.js             Weltlage aus GDELT/UCDP/ReliefWeb (F6)
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
| `UCDP_ACCESS_TOKEN` | Konfliktdaten fuer die Weltlage (UCDP)        | ja, sonst faellt F6 auf weniger Quellen zurueck |
| `RELIEFWEB_APPNAME` | ReliefWeb-Quelle in der Weltlage              | nein; ohne Appname wird ReliefWeb gar nicht erst angefragt |

Der FRED-Schluessel laesst sich alternativ im Startbildschirm der App
eingeben - dann bleibt er im Browser und die Server-Variable ist entbehrlich.

Finnhub- und Groq-Schluessel werden ausschliesslich in der App eingegeben und
liegen im Browser, nie auf dem Server.
