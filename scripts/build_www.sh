#!/bin/sh
# Copies web assets into www/ for Capacitor
set -e
cd "$(dirname "$0")/.."
rm -rf www && mkdir -p www/vendor www/safar
cp index.html app.js geofence.js indian_railways_complete.db www/
cp vendor/sql-wasm.js vendor/sql-wasm.wasm www/vendor/
cp safar/index.html safar/stations.json safar/osm-stations.json \
  safar/osm-station-routes.json safar/osm-station-route-summary.json www/safar/
