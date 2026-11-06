"""Runs the pipeline into a temp DB and checks the network is sane and connected."""
import os
import sqlite3
import subprocess
import sys
import tempfile
from collections import defaultdict

tmp = tempfile.mkdtemp()
db = os.path.join(tmp, "t.db")
env = dict(os.environ, RAIL_DB=db, RAIL_JSON=os.path.join(tmp, "r.json"))
subprocess.run([sys.executable, "loader_pipeline.py"], env=env, check=True)

c = sqlite3.connect(db)
n_routes = c.execute("SELECT COUNT(*) FROM rail_subroutes").fetchone()[0]
assert n_routes > 500, n_routes
assert c.execute("""SELECT COUNT(*) FROM subroute_stations ss LEFT JOIN stations s USING(station_code)
                    WHERE s.station_code IS NULL""").fetchone()[0] == 0, "unresolved stations"

g = defaultdict(set)
for a, b in c.execute("SELECT station_a, station_b FROM station_links"):
    g[a].add(b)
    g[b].add(a)


def connected(a, b):
    seen, stack = {a}, [a]
    while stack:
        for v in g[stack.pop()]:
            if v not in seen:
                seen.add(v)
                stack.append(v)
    return b in seen


for a, b in [("BRWD", "MGS"), ("NDLS", "HWH"), ("CSTM", "MAS"), ("PNBE", "GAYA")]:
    assert connected(a, b), f"{a} -> {b} not connected"
cic = [r[0] for r in c.execute("SELECT station_code FROM subroute_stations WHERE route_id='CIC_BRWD_MGS' ORDER BY sequence_order")]
assert len(cic) >= 35 and cic[0] == "BRWD" and cic[-1] == "MGS", cic
assert all(k in cic for k in ("DTO", "LBT", "GHD", "HDN", "SEB", "DOS", "SSM", "KTQ", "GAQ")), cic
print("ok")
