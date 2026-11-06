"""Offline test: builds a fixture OSM network from real station coordinates and runs the pipeline."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

MAIN = ["MGS", "KCA", "SLD", "DLN", "BXR", "ARA", "DNR", "PNBE"]
BRANCH = ["ARA", "PIRO", "XBKJ"]  # splits off at ARA
SRC = "indian_railways_complete.db"

src = sqlite3.connect(SRC)
xy = lambda c: src.execute("SELECT latitude, longitude FROM stations WHERE station_code=?", (c,)).fetchone()


def way(i, codes):
    # track passes ~50 m from each station
    return {"type": "way", "id": i,
            "geometry": [{"lat": xy(c)[0] + 0.0005, "lon": xy(c)[1]} for c in codes]}


tmp = tempfile.mkdtemp()
fx = os.path.join(tmp, "osm.json")
json.dump({"elements": [way(1, MAIN), way(2, BRANCH)]}, open(fx, "w"))
db = os.path.join(tmp, "t.db")
env = dict(os.environ, OSM_FIXTURE=fx, RAIL_DB=db, RAIL_JSON=os.path.join(tmp, "r.json"))
subprocess.run([sys.executable, "loader_pipeline.py"], env=env, check=True)

c = sqlite3.connect(db)
links = {tuple(r[:2]) for r in c.execute("SELECT station_a, station_b FROM station_links")}
print("links:", sorted(links))
assert ("ARA", "UWNR") in links and ("PIRO", "UWNR") in links, "branch not linked"
nets = c.execute("SELECT route_id, route_name FROM rail_subroutes WHERE route_id LIKE 'NET_%'").fetchall()
print(nets)
assert nets, "no generated routes"
# some generated route must contain both ends of the main line
ok = c.execute("""SELECT route_id FROM subroute_stations WHERE station_code IN ('KCA','BXR','ARA','PNBE')
                  AND route_id LIKE 'NET_%' GROUP BY route_id HAVING COUNT(*)=4""").fetchall()
assert ok, "main line not a single chain"
br = c.execute("""SELECT route_id FROM subroute_stations WHERE station_code IN ('PIRO','XBKJ')
                  AND route_id LIKE 'NET_%' GROUP BY route_id HAVING COUNT(*)=2""").fetchall()
assert br, "branch not a chain"
unresolved = c.execute("""SELECT COUNT(*) FROM subroute_stations ss LEFT JOIN stations s USING(station_code)
                          WHERE s.station_code IS NULL""").fetchone()[0]
assert unresolved == 0
print("ok")
