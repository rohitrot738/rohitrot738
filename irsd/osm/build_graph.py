#!/usr/bin/env python3
"""Build a physical OSM track graph; optional station matches stay separate."""

import argparse
import csv
import io
import json
import math
import os
import re
import sqlite3
import subprocess
import xml.etree.ElementTree as ET
import zipfile

TRACKS = {"rail", "narrow_gauge", "light_rail", "preserved"}
STATIONS = {"station", "halt"}
INACTIVE = {"disused", "abandoned", "construction", "proposed"}


def track_is_active(tags):
    return (tags.get("railway") in TRACKS
            and not any(tags.get(k) in {"yes", "true", "1"} for k in INACTIVE)
            and not any(k in tags for k in ("disused:railway", "abandoned:railway", "construction:railway")))


def build(xml, database, report):
    if os.path.exists(database):
        raise FileExistsError(f"Refusing to overwrite {database}")
    db = sqlite3.connect(database)
    db.executescript("""
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        CREATE TABLE nodes(id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, tags TEXT NOT NULL);
        CREATE TABLE ways(id INTEGER PRIMARY KEY, railway TEXT NOT NULL, tags TEXT NOT NULL);
        CREATE TABLE segments(way_id INTEGER NOT NULL, sequence INTEGER NOT NULL,
                              from_node INTEGER NOT NULL, to_node INTEGER NOT NULL,
                              PRIMARY KEY(way_id, sequence));
        CREATE TABLE stations(osm_type TEXT NOT NULL, osm_id INTEGER NOT NULL,
                              railway TEXT NOT NULL, tags TEXT NOT NULL, node_refs TEXT,
                              PRIMARY KEY(osm_type, osm_id));
    """)
    root = None
    for event, elem in ET.iterparse(xml, events=("start", "end")):
        if root is None:
            root = elem
        if event != "end" or elem.tag not in ("node", "way", "relation"):
            continue
        tags = {t.attrib["k"]: t.attrib["v"] for t in elem.findall("tag")}
        tag_json = json.dumps(tags, ensure_ascii=False, sort_keys=True)
        obj_id = int(elem.attrib["id"])
        if elem.tag == "node":
            db.execute("INSERT INTO nodes VALUES (?,?,?,?)",
                       (obj_id, float(elem.attrib["lat"]), float(elem.attrib["lon"]), tag_json))
            if tags.get("railway") in STATIONS:
                db.execute("INSERT INTO stations VALUES (?,?,?,?,?)",
                           ("node", obj_id, tags["railway"], tag_json, None))
        elif elem.tag == "way":
            refs = [int(n.attrib["ref"]) for n in elem.findall("nd")]
            if tags.get("railway") in STATIONS:
                db.execute("INSERT INTO stations VALUES (?,?,?,?,?)",
                           ("way", obj_id, tags["railway"], tag_json, json.dumps(refs)))
            if track_is_active(tags):
                db.execute("INSERT INTO ways VALUES (?,?,?)", (obj_id, tags["railway"], tag_json))
                db.executemany("INSERT INTO segments VALUES (?,?,?,?)",
                               ((obj_id, i, a, b) for i, (a, b) in enumerate(zip(refs, refs[1:]))))
        root.clear()

    missing = db.execute("""
        SELECT COUNT(*) FROM segments s
        LEFT JOIN nodes a ON a.id=s.from_node LEFT JOIN nodes b ON b.id=s.to_node
        WHERE a.id IS NULL OR b.id IS NULL
    """).fetchone()[0]
    if missing:
        raise ValueError(f"{missing} track segments reference missing nodes; extract is incomplete")
    db.executescript("""
        CREATE INDEX segments_from ON segments(from_node);
        CREATE INDEX segments_to ON segments(to_node);
        CREATE TABLE neighbors(node_id INTEGER NOT NULL, neighbor_id INTEGER NOT NULL,
                               PRIMARY KEY(node_id, neighbor_id)) WITHOUT ROWID;
        INSERT OR IGNORE INTO neighbors SELECT from_node, to_node FROM segments WHERE from_node != to_node;
        INSERT OR IGNORE INTO neighbors SELECT to_node, from_node FROM segments WHERE from_node != to_node;
        CREATE TABLE junctions AS SELECT node_id, COUNT(*) AS degree FROM neighbors
            GROUP BY node_id HAVING COUNT(*) >= 3;
        CREATE UNIQUE INDEX junction_id ON junctions(node_id);
        CREATE INDEX stations_type ON stations(osm_type, osm_id);
        CREATE VIRTUAL TABLE station_locations USING rtree(id, min_lat, max_lat, min_lon, max_lon);
        INSERT INTO station_locations SELECT n.id, n.lat, n.lat, n.lon, n.lon
            FROM nodes n JOIN stations s ON s.osm_type='node' AND s.osm_id=n.id;
    """)
    queries = {
        "osm_nodes_in_extract": "SELECT COUNT(*) FROM nodes",
        "track_ways": "SELECT COUNT(*) FROM ways",
        "track_segments": "SELECT COUNT(*) FROM segments",
        "track_nodes": "SELECT COUNT(*) FROM (SELECT from_node FROM segments UNION SELECT to_node FROM segments)",
        "topological_junction_candidates": "SELECT COUNT(*) FROM junctions",
        "station_nodes": "SELECT COUNT(*) FROM stations WHERE osm_type='node'",
        "station_ways": "SELECT COUNT(*) FROM stations WHERE osm_type='way'",
        "station_nodes_on_track": """SELECT COUNT(*) FROM stations s WHERE s.osm_type='node'
            AND (EXISTS (SELECT 1 FROM segments WHERE from_node=s.osm_id)
              OR EXISTS (SELECT 1 FROM segments WHERE to_node=s.osm_id))""",
        "missing_segment_node_references": "SELECT 0",
    }
    stats = {key: db.execute(query).fetchone()[0] for key, query in queries.items()}
    if not stats["track_segments"] or not stats["station_nodes"]:
        raise ValueError("No track segments or station nodes found in extract")
    stats["track_ways_by_railway"] = dict(db.execute("SELECT railway, COUNT(*) FROM ways GROUP BY railway"))
    stats["coverage_status"] = "unknown; OSM mapping and real-world connectivity not independently verified"
    db.commit()
    db.close()
    with open(report, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
        f.write("\n")


def distance(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 12742000 * math.asin(min(1, math.sqrt(a)))


def match(database, archive, output):
    if os.path.exists(output):
        raise FileExistsError(f"Refusing to overwrite {output}")
    db = sqlite3.connect(f"file:{os.path.abspath(database)}?mode=ro", uri=True)
    with zipfile.ZipFile(archive) as z, z.open("data/stations.csv") as data, \
            open(output, "x", newline="", encoding="utf-8") as out:
        writer = csv.writer(out)
        writer.writerow(["irsd_code", "irsd_gid", "osm_node_id", "distance_m", "osm_ref_matches_code", "status"])
        for row in csv.DictReader(io.TextIOWrapper(data, encoding="utf-8-sig")):
            lat, lon = float(row["lat"]), float(row["lng"])
            # Conservative bounding box; actual distance is checked below.
            dy = 1000 / 110000
            dx = dy / max(0.01, math.cos(math.radians(lat)))
            candidates = db.execute("""
                SELECT n.id, n.lat, n.lon, n.tags FROM station_locations r
                JOIN nodes n ON n.id=r.id
                WHERE r.min_lat<=? AND r.max_lat>=? AND r.min_lon<=? AND r.max_lon>=?
            """, (lat + dy, lat - dy, lon + dx, lon - dx))
            for node_id, nlat, nlon, tags in candidates:
                meters = distance(lat, lon, nlat, nlon)
                if meters > 1000:
                    continue
                ref = json.loads(tags).get("ref", "")
                refs = {x.strip().upper() for x in re.split(r"[;,]", ref)}
                writer.writerow([row["station_code"], row["gid"], node_id, round(meters, 1),
                                 int(row["station_code"].upper() in refs), "unreviewed_candidate"])
    db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?")
    parser.add_argument("database", nargs="?")
    parser.add_argument("report", nargs="?")
    parser.add_argument("--xml", action="store_true", help="Input is OSM XML, for fixtures")
    parser.add_argument("--match-archive", help="Optional restricted IRSD ZIP, never published by workflow")
    parser.add_argument("--matches-output", help="Private CSV for unreviewed matches")
    args = parser.parse_args()
    if not all((args.input, args.database, args.report)):
        parser.error("input, database and report are required")
    if bool(args.match_archive) != bool(args.matches_output):
        parser.error("--match-archive and --matches-output must be supplied together")
    if args.xml:
        with open(args.input, "rb") as f:
            build(f, args.database, args.report)
    else:
        with subprocess.Popen(["osmium", "cat", args.input, "-f", "osm"], stdout=subprocess.PIPE) as p:
            try:
                build(p.stdout, args.database, args.report)
            finally:
                p.stdout.close()
            if p.wait() != 0:
                raise RuntimeError("osmium cat failed")
    if args.match_archive:
        match(args.database, args.match_archive, args.matches_output)


if __name__ == "__main__":
    main()
