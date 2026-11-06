"""
Indian Railways network pipeline (timetable based, fully automatic).

1. Stations: DataMeet stations.json.
2. Timetable: DataMeet schedules.json (trains.json only holds map geometry, no stop lists).
   Each train's stops, ordered by day and time, are a topologically correct station sequence.
3. station_edges: consecutive stops of every train become graph edges. Express "skip" edges
   covered by a finer chain of shorter edges are pruned, so paths list every halt.
4. rail_subroutes / subroute_stations: one route per distinct train stop pattern. Express hops
   are expanded through the graph, so each route lists the halts it passes as well.
"""

import heapq
import json
import math
import os
import sqlite3
import sys
import urllib.request
from collections import defaultdict

DB_FILE = os.environ.get("RAIL_DB", "indian_railways_complete.db")
STATIONS_URL = "https://raw.githubusercontent.com/datameet/railways/master/stations.json"
SCHEDULES_URL = os.environ.get(
    "SCHEDULES_URL", "https://raw.githubusercontent.com/datameet/railways/master/schedules.json")

PRUNE_DETOUR = 1.6   # drop an edge if a chain of other edges covers it within this factor
MAX_EDGE_KM = 700    # edges longer than this are timetable errors

# Halts missing from DataMeet. Coordinates are approximate.
FALLBACK_STATIONS = [
    ("GADH", "Garhani", 25.4124, 84.6012),
    ("SJV", "Sanjhauli Halt", 25.0912, 84.1412),
    ("NXR", "Nagsar Halt", 25.4912, 83.6912),
    ("SAHA", "Sarahula Halt", 25.5312, 83.6812),
    ("TLPC", "Tulsi Ashram", 25.3712, 83.4512),
    ("BWHH", "Baruna Halt", 25.5612, 84.0712),
    ("PAIL", "Pali Halt", 25.5812, 84.8312),
]


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ---------------------------------------------------------------- stations

def fetch_and_load_stations(conn):
    print("[2/5] Downloading station data from DataMeet...")
    req = urllib.request.Request(STATIONS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        features = json.loads(resp.read().decode("utf-8")).get("features", [])
    print(f" -> {len(features)} stations received.")
    cur = conn.cursor()
    inserted = 0
    for item in features:
        props = item.get("properties") or {}
        coords = (item.get("geometry") or {}).get("coordinates") or [0.0, 0.0]  # [lon, lat]
        code, name = props.get("code"), props.get("name")
        lon = float(coords[0]) if len(coords) > 0 else 0.0
        lat = float(coords[1]) if len(coords) > 1 else 0.0
        if code and name and lat != 0.0 and lon != 0.0:
            cur.execute('''INSERT OR REPLACE INTO stations
                (station_code, station_name, latitude, longitude, zone, division, state)
                VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (code.strip().upper(), name.strip(), lat, lon,
                 props.get("zone", "IR"), props.get("division", "IR"), props.get("state", "India")))
            inserted += 1
    cur.executemany('''INSERT OR IGNORE INTO stations
        (station_code, station_name, latitude, longitude, zone, division, state)
        VALUES (?, ?, ?, ?, 'IR', 'IR', 'India')''', FALLBACK_STATIONS)
    conn.commit()
    print(f" -> {inserted} stations saved.")


# ---------------------------------------------------------------- timetable

def _secs(t):
    if not t or t == "None":
        return None
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def load_schedules():
    print("[3/5] Downloading train schedules from DataMeet (~80 MB)...")
    local = os.environ.get("SCHEDULES_FILE")
    if local:
        with open(local, encoding="utf-8") as f:
            return json.load(f)
    req = urllib.request.Request(SCHEDULES_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))


def prune_skip_edges(edges):
    """Drops long express hops that a chain of shorter edges already covers."""
    nbrs = defaultdict(dict)
    for (a, b), d in edges.items():
        nbrs[a][b] = d
        nbrs[b][a] = d
    removed = 0
    for (a, b), d in sorted(edges.items(), key=lambda kv: -kv[1]):
        limit = d * PRUNE_DETOUR
        dist = {a: 0.0}
        heap = [(0.0, a)]
        found = False
        while heap and not found:
            du, u = heapq.heappop(heap)
            if du > dist.get(u, math.inf):
                continue
            for v, w in nbrs[u].items():
                if u == a and v == b:
                    continue  # the edge itself
                nd = du + w
                if nd > limit or nd >= dist.get(v, math.inf):
                    continue
                if v == b:
                    found = True
                    break
                dist[v] = nd
                heapq.heappush(heap, (nd, v))
        if found:
            del nbrs[a][b]
            del nbrs[b][a]
            removed += 1
    pruned = {(a, b): d for (a, b), d in edges.items() if b in nbrs[a]}
    print(f" -> pruned {removed} express skip edges; {len(pruned)} edges remain.")
    return pruned



def train_sequences(schedules, coords):
    """{train_number: (name, [codes in running order])}; stops without coordinates are dropped."""
    trains = defaultdict(list)
    names = {}
    for r in schedules:
        code = (r.get("station_code") or "").strip().upper()
        if code in coords:
            t = _secs(r.get("arrival"))
            if t is None:
                t = _secs(r.get("departure"))
            trains[r["train_number"]].append((r.get("day") or 1, t or 0, code))
            names[r["train_number"]] = (r.get("train_name") or "").strip()
    out = {}
    for num, stops in trains.items():
        stops.sort()
        seq = []
        for _, _, code in stops:
            if not seq or seq[-1] != code:
                seq.append(code)
        if len(seq) >= 2:
            out[num] = (names[num], seq)
    return out


def build_station_graph(sequences, coords):
    """Returns {(a, b): metres} for consecutive stops of every train (a < b)."""
    edges = {}
    for _, seq in sequences.values():
        for a, b in zip(seq, seq[1:]):
            pair = (a, b) if a < b else (b, a)
            if pair not in edges:
                d = haversine_m(*coords[pair[0]], *coords[pair[1]])
                if d <= MAX_EDGE_KM * 1000:
                    edges[pair] = d
    return edges


def expander(links):
    """Returns expand(seq) that fills in halts between stops that are not directly linked."""
    nbrs = defaultdict(dict)
    for (a, b), d in links.items():
        nbrs[a][b] = d
        nbrs[b][a] = d
    cache = {}

    def leg(a, b):
        if b in nbrs[a]:
            return [a, b]
        key = (a, b)
        if key in cache:
            return cache[key]
        dist, prev, heap, out = {a: 0.0}, {}, [(0.0, a)], None
        while heap:
            d, u = heapq.heappop(heap)
            if u == b:
                out = [b]
                while out[-1] != a:
                    out.append(prev[out[-1]])
                out.reverse()
                break
            if d > dist[u]:
                continue
            for v, w in nbrs[u].items():
                if d + w < dist.get(v, math.inf):
                    dist[v] = d + w
                    prev[v] = u
                    heapq.heappush(heap, (d + w, v))
        cache[key] = out or [a, b]  # unreachable pair: keep the direct hop
        return cache[key]

    def expand(seq):
        out = [seq[0]]
        for a, b in zip(seq, seq[1:]):
            out += leg(a, b)[1:]
        return out
    return expand


# ---------------------------------------------------------------- output

def write_network(conn, sequences, links, coords):
    print("[5/5] Writing routes and edges...")
    cur = conn.cursor()
    expand = expander(links)

    def dist_m(a, b):
        d = links.get((a, b) if a < b else (b, a))
        return d if d is not None else haversine_m(*coords[a], *coords[b])

    # One route per distinct stop pattern (a train and its return run share a route).
    routes = {}
    for num in sorted(sequences):
        name, seq = sequences[num]
        full = expand(seq)
        key = tuple(full) if full[0] < full[-1] else tuple(reversed(full))
        if key in routes:
            routes[key][1].append(num)
        else:
            routes[key] = (name, [num], full)

    # Longest routes first; a route is kept only if a quarter of its edges (min 3) are new.
    covered, kept = set(), []
    for key, (name, nums, full) in sorted(routes.items(), key=lambda kv: -len(kv[1][2])):
        pairs = {(a, b) if a < b else (b, a) for a, b in zip(full, full[1:])}
        new = pairs - covered
        if len(new) >= max(3, len(pairs) // 4):
            covered |= pairs
            kept.append((name, nums, full))
    routes = kept

    for i, (name, nums, full) in enumerate(routes, 1):
        route_id = f"TRAIN_{i:05d}"
        label = f"{name} ({', '.join(nums[:3])}{' +%d' % (len(nums) - 3) if len(nums) > 3 else ''})"
        total, rows = 0.0, []
        for k, code in enumerate(full, 1):
            if k > 1:
                total += dist_m(full[k - 2], code)
            rows.append((route_id, code, k, round(total / 1000.0, 2)))
        cur.execute("INSERT INTO rail_subroutes VALUES (?,?,?,?,?,?)",
                    (route_id, label, "TRAIN", full[0], full[-1], round(total / 1000.0, 2)))
        cur.executemany("INSERT INTO subroute_stations (route_id, station_code, sequence_order, "
                        "distance_from_origin_km) VALUES (?,?,?,?)", rows)

    # Track is bidirectional, so every link is stored in both directions.
    edge_rows = []
    for (a, b), d in links.items():
        km = round(d / 1000.0, 3)
        edge_rows += [(a, b, km), (b, a, km)]
    cur.executemany("INSERT INTO station_edges VALUES (?,?,?)", edge_rows)
    conn.commit()
    print(f" -> {len(routes)} routes from {len(sequences)} trains, {len(edge_rows)} directed edges.")


def export_json(conn):
    out = os.environ.get("RAIL_JSON", "rail_routes_full.json")
    routes = []
    for rid, name, ltype, o, d, km in conn.execute(
            "SELECT route_id, route_name, line_type, origin_code, destination_code, total_distance_km "
            "FROM rail_subroutes"):
        codes = [r[0] for r in conn.execute(
            "SELECT station_code FROM subroute_stations WHERE route_id=? ORDER BY sequence_order", (rid,))]
        routes.append({"route_id": rid, "route_name": name, "line_type": ltype, "origin": o,
                       "destination": d, "total_distance_km": km, "station_codes": codes})
    with open(out, "w", encoding="utf-8") as f:
        json.dump(routes, f, ensure_ascii=False, separators=(",", ":"))


def init_database(conn):
    print("[1/5] Preparing SQLite schema...")
    conn.executescript('''
    DROP TABLE IF EXISTS station_links;
    DROP TABLE IF EXISTS station_edges;
    DROP TABLE IF EXISTS subroute_stations;
    DROP TABLE IF EXISTS rail_subroutes;
    CREATE TABLE IF NOT EXISTS stations (
        station_code TEXT PRIMARY KEY, station_name TEXT NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL,
        zone TEXT, division TEXT, state TEXT);
    CREATE TABLE rail_subroutes (
        route_id TEXT PRIMARY KEY, route_name TEXT NOT NULL, line_type TEXT,
        origin_code TEXT, destination_code TEXT, total_distance_km REAL);
    CREATE TABLE subroute_stations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL, station_code TEXT NOT NULL,
        sequence_order INTEGER NOT NULL, distance_from_origin_km REAL,
        FOREIGN KEY (route_id) REFERENCES rail_subroutes(route_id),
        FOREIGN KEY (station_code) REFERENCES stations(station_code));
    CREATE TABLE station_edges (
        station_a TEXT NOT NULL, station_b TEXT NOT NULL, distance_km REAL NOT NULL,
        PRIMARY KEY (station_a, station_b));
    CREATE INDEX idx_ss_station ON subroute_stations(station_code);
    CREATE INDEX idx_ss_route ON subroute_stations(route_id, sequence_order);
    ''')
    conn.commit()


def main():
    conn = sqlite3.connect(DB_FILE)
    init_database(conn)
    fetch_and_load_stations(conn)
    coords = {c: (la, lo) for c, la, lo in conn.execute("SELECT station_code, latitude, longitude FROM stations")}
    schedules = load_schedules()
    if not schedules:
        sys.exit("No schedule data loaded; refusing to produce an empty network.")

    print("[4/5] Building the station network from train stops...")
    sequences = train_sequences(schedules, coords)
    del schedules
    edges = build_station_graph(sequences, coords)
    print(f" -> {len(sequences)} trains, {len(edges)} unique consecutive-stop edges.")
    links = prune_skip_edges(edges)
    write_network(conn, sequences, links, coords)
    export_json(conn)
    conn.execute("VACUUM")
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
