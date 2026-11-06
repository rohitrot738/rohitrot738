"""
Indian Railways network pipeline.

1. Stations: DataMeet stations.json (+ manual fallback halts).
2. Track geometry: OpenStreetMap railway ways (Overpass API). DataMeet publishes no
   lines.geojson, so OSM is the line source.
3. Each station is snapped to the nearest track vertex within SNAP_M (1.5 km).
4. Walking the track graph from every station finds the neighbouring stations, which gives
   a station graph. The graph is split into sequential chains (main lines, loops, branches),
   and each chain becomes a row in rail_subroutes + rows in subroute_stations.

Set OSM_FIXTURE=<file.json> to read Overpass-style JSON from disk instead of the network.
"""

import heapq
import json
import math
import os
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

DB_FILE = os.environ.get("RAIL_DB", "indian_railways_complete.db")
STATIONS_URL = "https://raw.githubusercontent.com/datameet/railways/master/stations.json"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
CACHE_DIR = os.environ.get("OSM_CACHE", "osm_cache")

SNAP_M = 1500          # max station-to-track distance
MAX_HOP_M = 100_000    # max track distance between neighbouring stations
DENSIFY_M = 150        # insert vertices so snapping isn't limited by sparse geometry
MIN_STRAIGHT_DEG = 110  # at junctions, only join edges that continue fairly straight
TILE_DEG = 1

# Hand-written named routes that are kept alongside the generated network.
CURATED_ROUTES = [
    ("CIC_BRWD_MGS", "CIC Line - Barwadih - Garwa Road - Son Nagar - Mughal Sarai", "MAIN",
     ["BRWD", "GHD", "SEB", "MGS"]),
    ("SUB_ARA_SSM", "Ara - Piro - Bikramganj - Sasaram Branch Line", "BRANCH",
     ["ARA", "GADH", "CRQ", "PIRO", "HBS", "XBKJ", "MANI", "SJV", "GQN", "BMHT", "SSM"]),
    ("SUB_DLN_TRG", "Dildarnagar - Tarighat Branch Line", "BRANCH", ["DLN", "NXR", "SAHA", "TRG"]),
    ("SUB_FUT_IPR", "Fatuha - Hilsa - Islampur Branch Line", "BRANCH", ["FUT", "DNWH", "HIL", "EKR", "IPR"]),
    ("SUB_BKP_RGD", "Bakhtiyarpur - Rajgir Branch Line", "BRANCH", ["BKP", "HRT", "WENA", "BEHS", "NLD", "RGD"]),
    ("MAIN_DDU_PNBE", "DDU - Buxar - Ara - Danapur - Patna Main Line", "MAIN", [
        "MGS", "KCA", "SLD", "TLPC", "ZNA", "DRV", "DLN", "USK", "BWH", "KKRH", "GMR", "BQW", "CSA",
        "PWL", "BXR", "BWHH", "DURE", "TWG", "VKDH", "RPR", "BYN", "BEA", "KYA", "KRS", "JGA",
        "ARA", "KUA", "KWR", "PAIL", "BTA", "PATL", "SDE", "GZH", "NEO", "DNR", "PWS", "PNBE"]),
    ("SUB_PNBE_GAYA", "Patna - Jehanabad - Gaya Sub-Route", "SUB_ROUTE",
     ["PNBE", "PRBZ", "PNUG", "PPN", "TEA", "JHD", "BELA", "GAYA"]),
    ("CHORD_DDU_GAYA", "DDU - Sasaram - Dehri On Sone - Gaya Grand Chord", "CHORD",
     ["MGS", "CDMR", "BBU", "KTQ", "SSM", "DOS", "AUBR", "RFJ", "GRRU", "GAYA"]),
]

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

def init_database(conn):
    print("[1/6] Preparing SQLite schema...")
    cur = conn.cursor()
    cur.executescript('''
    CREATE TABLE IF NOT EXISTS stations (
        station_code TEXT PRIMARY KEY, station_name TEXT NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL,
        zone TEXT, division TEXT, state TEXT);
    CREATE TABLE IF NOT EXISTS rail_subroutes (
        route_id TEXT PRIMARY KEY, route_name TEXT NOT NULL, line_type TEXT,
        origin_code TEXT, destination_code TEXT, total_distance_km REAL);
    CREATE TABLE IF NOT EXISTS subroute_stations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL, station_code TEXT NOT NULL,
        sequence_order INTEGER NOT NULL, distance_from_origin_km REAL,
        FOREIGN KEY (route_id) REFERENCES rail_subroutes(route_id),
        FOREIGN KEY (station_code) REFERENCES stations(station_code));
    CREATE TABLE IF NOT EXISTS station_links (
        station_a TEXT NOT NULL, station_b TEXT NOT NULL, distance_km REAL NOT NULL,
        PRIMARY KEY (station_a, station_b));
    CREATE INDEX IF NOT EXISTS idx_ss_station ON subroute_stations(station_code);
    CREATE INDEX IF NOT EXISTS idx_ss_route ON subroute_stations(route_id, sequence_order);
    ''')
    # Rebuilt from scratch on every run so reruns never duplicate rows.
    cur.executescript("DELETE FROM subroute_stations; DELETE FROM rail_subroutes; DELETE FROM station_links;")
    conn.commit()


def fetch_and_load_stations(conn):
    print("[2/6] Downloading station data from DataMeet...")
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


# ---------------------------------------------------------------- OSM

def _overpass(query, label):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(8):
        url = OVERPASS_URLS[attempt % len(OVERPASS_URLS)]
        try:
            req = urllib.request.Request(url, data=body, headers={
                "User-Agent": "railtrack-loader/1.0 (https://github.com/rohitrot738/rohitrot738)"})
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # rate limit, timeout, bad JSON from an overloaded server
            last = e
            wait = min(120, 10 * 2 ** min(attempt, 4))
            print(f"   {label}: {url.split('/')[2]} failed ({e}); retry in {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"Overpass failed after retries: {last}")


def load_osm_ways(station_coords):
    """Returns {way_id: [(lat, lon), ...]} for railway track in India."""
    fixture = os.environ.get("OSM_FIXTURE")
    if fixture:
        with open(fixture, encoding="utf-8") as f:
            return _parse_ways(json.load(f))
    print("[3/6] Downloading railway track geometry from OpenStreetMap...")
    os.makedirs(CACHE_DIR, exist_ok=True)
    ways = {}
    # Only tiles that contain a station; ocean and foreign tiles are skipped.
    tiles = sorted({(math.floor(la / TILE_DEG) * TILE_DEG, math.floor(lo / TILE_DEG) * TILE_DEG)
                    for la, lo in station_coords})
    failed = []
    for i, (s, w) in enumerate(tiles, 1):
        path = os.path.join(CACHE_DIR, f"tile_{s}_{w}.json")
        try:
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
            else:
                q = (f'[out:json][timeout:240][maxsize:2147483648];'
                     f'way["railway"~"^(rail|narrow_gauge)$"][!"service"]'
                     f'({s},{w},{s + TILE_DEG},{w + TILE_DEG});out geom qt;')
                data = _overpass(q, f"tile ({s},{w})")
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(data, f)
                time.sleep(2)
        except RuntimeError as e:
            failed.append((s, w))
            print(f"   tile {i}/{len(tiles)} ({s},{w}) SKIPPED: {e}", flush=True)
            continue
        ways.update(_parse_ways(data))
        print(f"   tile {i}/{len(tiles)} ({s},{w}): {len(ways)} ways so far", flush=True)
    if len(failed) > max(2, len(tiles) // 33):
        sys.exit(f"Too many OSM tiles failed ({len(failed)}/{len(tiles)}): {failed}")
    if failed:
        print(f" !! {len(failed)} tiles missing, network incomplete there: {failed}")
    return ways


def _parse_ways(data):
    out = {}
    for el in data.get("elements", []):
        if el.get("type") == "way" and el.get("geometry") and len(el["geometry"]) > 1:
            out[el["id"]] = [(p["lat"], p["lon"]) for p in el["geometry"]]
    return out


# ---------------------------------------------------------------- graph

def _key(lat, lon):
    return (round(lat, 6), round(lon, 6))


def build_track_graph(ways):
    """Node = rounded coordinate. Shared coordinates join ways into one graph."""
    adj = defaultdict(dict)
    for pts in ways.values():
        prev = None
        for lat, lon in pts:
            if prev is not None:
                seg = haversine_m(prev[0], prev[1], lat, lon)
                n = max(1, int(seg // DENSIFY_M) + 1)
                last = prev
                for k in range(1, n + 1):
                    cur = (lat, lon) if k == n else (prev[0] + (lat - prev[0]) * k / n,
                                                     prev[1] + (lon - prev[1]) * k / n)
                    a, b = _key(*last), _key(*cur)
                    if a != b:
                        d = haversine_m(last[0], last[1], cur[0], cur[1])
                        adj[a][b] = d
                        adj[b][a] = d
                    last = cur
            prev = (lat, lon)
    return adj


def snap_stations(stations, adj):
    """stations: {code: (lat, lon)} -> {node: code}, nearest station per track node."""
    cell = 0.02
    grid = defaultdict(list)
    for node in adj:
        grid[(int(node[0] // cell), int(node[1] // cell))].append(node)
    best = {}
    for code, (lat, lon) in stations.items():
        cx, cy = int(lat // cell), int(lon // cell)
        near, near_d = None, SNAP_M
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for node in grid.get((cx + dx, cy + dy), ()):
                    d = haversine_m(lat, lon, node[0], node[1])
                    if d <= near_d:
                        near, near_d = node, d
        if near is None:
            continue
        if near not in best or near_d < best[near][1]:
            best[near] = (code, near_d)
    return {node: code for node, (code, _) in best.items()}


def station_links(adj, node_station):
    """Dijkstra from each station over track; stop at the next stations."""
    links = {}
    for start, a in node_station.items():
        dist = {start: 0.0}
        heap = [(0.0, start)]
        while heap:
            d, node = heapq.heappop(heap)
            if d > dist.get(node, math.inf):
                continue
            b = node_station.get(node)
            if b is not None and node != start:
                if b != a:
                    pair = (a, b) if a < b else (b, a)
                    if d < links.get(pair, math.inf):
                        links[pair] = d
                continue  # stations block the walk so only adjacent stations link
            for nxt, w in adj[node].items():
                nd = d + w
                if nd <= MAX_HOP_M and nd < dist.get(nxt, math.inf):
                    dist[nxt] = nd
                    heapq.heappush(heap, (nd, nxt))
    return links


def build_chains(links, coords):
    """Splits the station graph into sequential chains; at junctions the straightest edges join."""
    nbrs = defaultdict(dict)
    for (a, b), d in links.items():
        nbrs[a][b] = d
        nbrs[b][a] = d

    def vec(n, m):
        la, lo = coords[n]
        lb, lob = coords[m]
        return ((lob - lo) * math.cos(math.radians(la)), lb - la)

    def angle(n, x, y):
        (x1, y1), (x2, y2) = vec(n, x), vec(n, y)
        m = math.hypot(x1, y1) * math.hypot(x2, y2)
        if m == 0:
            return 0.0
        c = max(-1.0, min(1.0, (x1 * x2 + y1 * y2) / m))
        return math.degrees(math.acos(c))

    cont = {}
    for n, ns in nbrs.items():
        ns = list(ns)
        if len(ns) < 2:
            continue
        cands = sorted(((angle(n, x, y), x, y) for i, x in enumerate(ns) for y in ns[i + 1:]), reverse=True)
        used = set()
        for ang, x, y in cands:
            if ang < MIN_STRAIGHT_DEG or x in used or y in used:
                continue
            used.update((x, y))
            cont[(n, x)] = y
            cont[(n, y)] = x

    seen = set()
    chains = []
    for a, b in sorted(links):
        if (a, b) in seen:
            continue
        chain = [a, b]
        seen.add((a, b))
        while True:  # forward
            nxt = cont.get((chain[-1], chain[-2]))
            e = tuple(sorted((chain[-1], nxt))) if nxt else None
            if nxt is None or e in seen:
                break
            seen.add(e)
            chain.append(nxt)
        while True:  # backward
            nxt = cont.get((chain[0], chain[1]))
            e = tuple(sorted((chain[0], nxt))) if nxt else None
            if nxt is None or e in seen:
                break
            seen.add(e)
            chain.insert(0, nxt)
        chains.append(chain)
    return chains, nbrs


# ---------------------------------------------------------------- output

def write_routes(conn, chains, links, names):
    print("[5/6] Writing routes...")
    cur = conn.cursor()
    known = {c: (la, lo) for c, la, lo in cur.execute("SELECT station_code, latitude, longitude FROM stations")}

    def insert(route_id, name, ltype, codes, dist_fn):
        total, rows = 0.0, []
        for i, code in enumerate(codes, 1):
            if i > 1:
                total += dist_fn(codes[i - 2], code)
            rows.append((route_id, code, i, round(total / 1000.0, 2)))
        cur.execute("INSERT OR REPLACE INTO rail_subroutes VALUES (?,?,?,?,?,?)",
                    (route_id, name, ltype, codes[0], codes[-1], round(total / 1000.0, 2)))
        cur.executemany("INSERT INTO subroute_stations (route_id, station_code, sequence_order, "
                        "distance_from_origin_km) VALUES (?,?,?,?)", rows)

    def link_dist(a, b):
        d = links.get((a, b) if a < b else (b, a))
        return d if d is not None else haversine_m(*known[a], *known[b])

    for r_id, r_name, l_type, codes in CURATED_ROUTES:
        codes = [c for c in codes if c in known]
        if len(codes) >= 2:
            insert(r_id, r_name, l_type, codes, link_dist)

    for i, chain in enumerate(chains, 1):
        n = len(chain)
        ltype = "MAIN" if n >= 25 else "BRANCH" if n >= 4 else "SECTION"
        name = f"{names.get(chain[0], chain[0])} - {names.get(chain[-1], chain[-1])} ({n} stations)"
        insert(f"NET_{i:05d}", name, ltype, chain, link_dist)

    cur.executemany("INSERT OR REPLACE INTO station_links VALUES (?,?,?)",
                    [(a, b, round(d / 1000.0, 3)) for (a, b), d in links.items()])
    conn.commit()
    print(f" -> {len(chains)} generated routes + curated routes, {len(links)} station links.")


def export_json(conn):
    print("[6/6] Exporting JSON...")
    routes = []
    for r in conn.execute("SELECT route_id, route_name, line_type, origin_code, destination_code, "
                          "total_distance_km FROM rail_subroutes").fetchall():
        stns = conn.execute('''
            SELECT ss.sequence_order, ss.station_code, s.station_name, ss.distance_from_origin_km,
                   s.latitude, s.longitude
            FROM subroute_stations ss JOIN stations s ON s.station_code = ss.station_code
            WHERE ss.route_id = ? ORDER BY ss.sequence_order''', (r[0],)).fetchall()
        routes.append({"route_id": r[0], "route_name": r[1], "line_type": r[2], "origin": r[3],
                       "destination": r[4], "total_distance_km": r[5],
                       "stations": [{"order": s[0], "code": s[1], "name": s[2], "distance_km": s[3],
                                     "lat": s[4], "lon": s[5]} for s in stns]})
    with open(os.environ.get("RAIL_JSON", "rail_routes_full.json"), "w", encoding="utf-8") as f:
        json.dump(routes, f, ensure_ascii=False)


def main():
    conn = sqlite3.connect(DB_FILE)
    init_database(conn)
    fetch_and_load_stations(conn)
    station_coords = [(la, lo) for la, lo in conn.execute("SELECT latitude, longitude FROM stations")]
    ways = load_osm_ways(station_coords)
    if not ways:
        sys.exit("No OSM track data loaded; refusing to produce an empty network.")

    print("[4/6] Matching stations to track and building the network...")
    adj = build_track_graph(ways)
    coords = {c: (la, lo) for c, la, lo in conn.execute("SELECT station_code, latitude, longitude FROM stations")}
    names = dict(conn.execute("SELECT station_code, station_name FROM stations"))
    node_station = snap_stations(coords, adj)
    print(f" -> {len(adj)} track nodes, {len(node_station)}/{len(coords)} stations within {SNAP_M} m of track.")
    links = station_links(adj, node_station)
    chains, _ = build_chains(links, coords)
    write_routes(conn, chains, links, names)
    export_json(conn)
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
