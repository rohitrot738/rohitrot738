"""
Indian Railways Complete 8,500+ Stations & Sub-Routes Pipeline
Source: Open Data (DataMeet / Indian Railways GeoJSON)
"""

import json
import sqlite3
import urllib.request
import math

DB_FILE = "indian_railways_complete.db"
STATIONS_URL = "https://raw.githubusercontent.com/datameet/railways/master/stations.json"


def init_database():
    print("[1/4] Preparing SQLite schema...")
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    cur.execute('''
    CREATE TABLE IF NOT EXISTS stations (
        station_code TEXT PRIMARY KEY,
        station_name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        zone TEXT,
        division TEXT,
        state TEXT
    )''')
    cur.execute('''
    CREATE TABLE IF NOT EXISTS rail_subroutes (
        route_id TEXT PRIMARY KEY,
        route_name TEXT NOT NULL,
        line_type TEXT,
        origin_code TEXT,
        destination_code TEXT,
        total_distance_km REAL
    )''')
    cur.execute('''
    CREATE TABLE IF NOT EXISTS subroute_stations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        station_code TEXT NOT NULL,
        sequence_order INTEGER NOT NULL,
        distance_from_origin_km REAL,
        FOREIGN KEY (route_id) REFERENCES rail_subroutes(route_id),
        FOREIGN KEY (station_code) REFERENCES stations(station_code)
    )''')
    conn.commit()
    conn.close()


def fetch_and_load_stations():
    print("[2/4] Downloading station data from DataMeet...")
    req = urllib.request.Request(STATIONS_URL, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            features = json.loads(resp.read().decode('utf-8')).get("features", [])
            print(f" -> {len(features)} stations received.")
    except Exception as e:
        print(f"Download error: {e}")
        return

    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    inserted = 0
    for item in features:
        props = item.get("properties") or {}
        geom = item.get("geometry") or {}
        code, name = props.get("code"), props.get("name")
        coords = geom.get("coordinates") or [0.0, 0.0]  # GeoJSON: [lon, lat]
        lon = float(coords[0]) if len(coords) > 0 else 0.0
        lat = float(coords[1]) if len(coords) > 1 else 0.0
        if code and name and lat != 0.0 and lon != 0.0:
            cur.execute('''INSERT OR REPLACE INTO stations
                (station_code, station_name, latitude, longitude, zone, division, state)
                VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (code.strip().upper(), name.strip(), lat, lon,
                 props.get("zone", "IR"), props.get("division", "IR"), props.get("state", "India")))
            inserted += 1
    conn.commit()
    conn.close()
    print(f" -> {inserted} stations saved.")


# User-supplied fallbacks for halts absent from DataMeet. Coordinates are approximate;
# verify them before relying on the 400 m geofence at these stops.
FALLBACK_STATIONS = [
    ("GADH", "Garhani", 25.4124, 84.6012),
    ("SJV", "Sanjhauli Halt", 25.0912, 84.1412),
    ("NXR", "Nagsar Halt", 25.4912, 83.6912),
    ("SAHA", "Sarahula Halt", 25.5312, 83.6812),
    ("TLPC", "Tulsi Ashram", 25.3712, 83.4512),
    ("BWHH", "Baruna Halt", 25.5612, 84.0712),
    ("PAIL", "Pali Halt", 25.5812, 84.8312),
]


def add_fallback_stations():
    conn = sqlite3.connect(DB_FILE)
    # IGNORE keeps real DataMeet rows if a code is present
    conn.executemany("""INSERT OR IGNORE INTO stations
        (station_code, station_name, latitude, longitude, zone, division, state)
        VALUES (?, ?, ?, ?, 'IR', 'IR', 'India')""", FALLBACK_STATIONS)
    conn.commit()
    conn.close()


def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def build_subroute_chains():
    print("[3/4] Building sub-route chains...")
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    # Reset so reruns don't duplicate subroute_stations rows
    cur.execute("DELETE FROM subroute_stations")

    subroutes = [
        ("SUB_ARA_SSM", "Ara - Piro - Bikramganj - Sasaram Branch Line", "BRANCH", "ARA", "SSM", ["ARA", "GADH", "CRQ", "PIRO", "HBS", "XBKJ", "MANI", "SJV", "GQN", "BMHT", "SSM"]),
        ("SUB_DLN_TRG", "Dildarnagar - Tarighat Branch Line", "BRANCH", "DLN", "TRG", ["DLN", "NXR", "SAHA", "TRG"]),
        ("SUB_FUT_IPR", "Fatuha - Hilsa - Islampur Branch Line", "BRANCH", "FUT", "IPR", ["FUT", "DNWH", "HIL", "EKR", "IPR"]),
        ("SUB_BKP_RGD", "Bakhtiyarpur - Rajgir Branch Line", "BRANCH", "BKP", "RGD", ["BKP", "HRT", "WENA", "BEHS", "NLD", "RGD"]),
        ("MAIN_DDU_PNBE", "DDU - Buxar - Ara - Danapur - Patna Main Line", "MAIN", "MGS", "PNBE", [
            "MGS", "KCA", "SLD", "TLPC", "ZNA", "DRV", "DLN", "USK", "BWH", "KKRH", "GMR", "BQW", "CSA",
            "PWL", "BXR", "BWHH", "DURE", "TWG", "VKDH", "RPR", "BYN", "BEA", "KYA", "KRS", "JGA",
            "ARA", "KUA", "KWR", "PAIL", "BTA", "PATL", "SDE", "GZH", "NEO", "DNR", "PWS", "PNBE"
        ]),
        ("SUB_PNBE_GAYA", "Patna - Jehanabad - Gaya Sub-Route", "SUB_ROUTE", "PNBE", "GAYA", ["PNBE", "PRBZ", "PNUG", "PPN", "TEA", "JHD", "BELA", "GAYA"]),
        ("CHORD_DDU_GAYA", "DDU - Sasaram - Dehri On Sone - Gaya Grand Chord", "CHORD", "MGS", "GAYA", ["MGS", "CDMR", "BBU", "KTQ", "SSM", "DOS", "AUBR", "RFJ", "GRRU", "GAYA"])
    ]

    for r_id, r_name, l_type, orig, dest, stn_list in subroutes:
        cur.execute('''INSERT OR REPLACE INTO rail_subroutes
            (route_id, route_name, line_type, origin_code, destination_code, total_distance_km)
            VALUES (?, ?, ?, ?, ?, 0)''', (r_id, r_name, l_type, orig, dest))
        last_coords, cum = None, 0.0
        for idx, code in enumerate(stn_list, 1):
            cur.execute("SELECT latitude, longitude FROM stations WHERE station_code = ?", (code,))
            row = cur.fetchone()
            if row:
                if last_coords:
                    cum += haversine_distance(last_coords[0], last_coords[1], row[0], row[1])
                last_coords = (row[0], row[1])
            cur.execute('''INSERT INTO subroute_stations (route_id, station_code, sequence_order, distance_from_origin_km)
                VALUES (?, ?, ?, ?)''', (r_id, code, idx, round(cum, 2)))
        cur.execute("UPDATE rail_subroutes SET total_distance_km = ? WHERE route_id = ?", (round(cum, 2), r_id))

    conn.commit()
    conn.close()
    print(" -> Sub-routes built.")


def export_json_for_mobile():
    print("[4/4] Exporting JSON...")
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()
    routes_json = []
    for r in cur.execute("SELECT route_id, route_name, line_type, origin_code, destination_code, total_distance_km FROM rail_subroutes").fetchall():
        stns = conn.execute('''
        SELECT ss.sequence_order, ss.station_code, s.station_name, ss.distance_from_origin_km, s.latitude, s.longitude
        FROM subroute_stations ss JOIN stations s ON s.station_code = ss.station_code
        WHERE ss.route_id = ? ORDER BY ss.sequence_order ASC''', (r[0],)).fetchall()
        routes_json.append({
            "route_id": r[0], "route_name": r[1], "line_type": r[2],
            "origin": r[3], "destination": r[4], "total_distance_km": r[5],
            "stations": [{"order": s[0], "code": s[1], "name": s[2], "distance_km": s[3],
                          "lat": s[4], "lon": s[5]} for s in stns]})
    with open("rail_routes_full.json", "w", encoding="utf-8") as f:
        json.dump(routes_json, f, indent=2, ensure_ascii=False)
    conn.close()
    print(" -> Done.")


if __name__ == "__main__":
    init_database()
    fetch_and_load_stations()
    add_fallback_stations()
    build_subroute_chains()
    export_json_for_mobile()
