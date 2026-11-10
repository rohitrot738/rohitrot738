#!/bin/sh
# Copies the app's web assets into www/ for Capacitor: the Safar tracker and its bundled station and route data.
set -e
cd "$(dirname "$0")/.."
rm -rf www && mkdir -p www
cp safar/index.html www/index.html
cp safar/stations.json safar/osm-stations.json safar/edges.json safar/osm-station-routes.json www/
