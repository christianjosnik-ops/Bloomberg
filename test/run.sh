#!/bin/sh
# run.sh — fuehrt alle Tests aus. Kein Test-Framework, nur Node-Bordmittel:
#   sh test/run.sh
# Jede *.test.js ist ein eigenstaendiges Node-Skript, das bei einem
# fehlgeschlagenen assert mit Exit-Code != 0 abbricht. Dieses Skript sammelt
# die Ergebnisse und endet selbst mit != 0, sobald eine Datei fehlschlaegt -
# damit es sich in CI oder einem Pre-Push-Hook verwenden laesst.

set -u
dir=$(dirname "$0")
status=0

for f in "$dir"/*.test.js; do
  name=$(basename "$f")
  if out=$(node "$f" 2>&1); then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    echo "$out" | sed 's/^/      /'
    status=1
  fi
done

exit $status
