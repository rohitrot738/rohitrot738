#!/bin/sh
# Copies web assets into www/ for Capacitor. Safar is the app's home screen;
# the older RailTrack timetable UI is kept as www/railtrack.html.
set -e
cd "$(dirname "$0")/.."
rm -rf www && mkdir -p www/vendor
cp app.js geofence.js indian_railways_complete.db www/
cp vendor/sql-wasm.js vendor/sql-wasm.wasm www/vendor/
sed 's#\./safar/index\.html#index.html#' index.html > www/railtrack.html
sed 's#\.\./index\.html#railtrack.html#' safar/index.html > www/index.html
cp safar/stations.json safar/osm-stations.json \
  safar/osm-station-routes.json safar/osm-station-route-summary.json www/
grep -q 'href="railtrack.html"' www/index.html
grep -q 'href="index.html"' www/railtrack.html
