#!/usr/bin/env python3
"""Build a physical OSM track graph; optional station matches stay separate."""

import argparse
import ast
import csv
import heapq
import io
import json
import math
import os
import re
import sqlite3
import subprocess
import xml.etree.ElementTree as ET
import zipfile

TRACKS = {"rail", "narrow_gauge", "light_rail", "subway", "tram", "funicular", "monorail", "miniature", "preserved"}
STATIONS = {"station", "halt"}
INACTIVE = {"disused", "abandoned", "construction", "proposed"}


def track_is_active(tags):
    return (tags.get("railway") in TRACKS
            and not any(tags.get(k) in {"yes", "true", "1"} for k in INACTIVE)
            and not any(k in tags for k in ("disused:railway", "abandoned:railway", "construction:railway")))


def is_station(tags):
    return tags.get("railway") in STATIONS or tags.get("public_transport") == "station"


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
        CREATE TABLE relations(id INTEGER PRIMARY KEY, category TEXT NOT NULL,
                               tags TEXT NOT NULL, members TEXT NOT NULL);
        CREATE TABLE relation_members(
            relation_id INTEGER NOT NULL, member_type TEXT NOT NULL,
            ref INTEGER NOT NULL, role TEXT NOT NULL
        );
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
            if is_station(tags):
                db.execute("INSERT INTO stations VALUES (?,?,?,?,?)",
                           ("node", obj_id, tags.get("railway") or "public_transport:station", tag_json, None))
        elif elem.tag == "way":
            refs = [int(n.attrib["ref"]) for n in elem.findall("nd")]
            if is_station(tags):
                db.execute("INSERT INTO stations VALUES (?,?,?,?,?)",
                           ("way", obj_id, tags.get("railway") or "public_transport:station",
                            tag_json, json.dumps(refs)))
            if track_is_active(tags):
                db.execute("INSERT INTO ways VALUES (?,?,?)", (obj_id, tags["railway"], tag_json))
                db.executemany("INSERT INTO segments VALUES (?,?,?,?)",
                               ((obj_id, i, a, b) for i, (a, b) in enumerate(zip(refs, refs[1:]))))
        elif elem.tag == "relation" and (
            tags.get("route") in {"train", "railway", "subway", "tram"}
            or tags.get("type") == "public_transport"
            or tags.get("public_transport") == "stop_area"
        ):
            category = "public_transport" if (
                tags.get("type") == "public_transport" or tags.get("public_transport") == "stop_area"
            ) else "route"
            members = [
                {"type": member.attrib["type"], "ref": int(member.attrib["ref"]),
                 "role": member.attrib.get("role", "")}
                for member in elem.findall("member")
            ]
            db.execute("INSERT INTO relations VALUES (?,?,?,?)",
                       (obj_id, category, tag_json, json.dumps(members, ensure_ascii=False)))
            db.executemany("INSERT INTO relation_members VALUES (?,?,?,?)", (
                (obj_id, member["type"], member["ref"], member["role"]) for member in members
            ))
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
        CREATE TEMP TABLE node_ways AS
            SELECT from_node AS node_id, way_id FROM segments
            UNION
            SELECT to_node AS node_id, way_id FROM segments;
        CREATE INDEX node_ways_id ON node_ways(node_id);
        CREATE TABLE neighbors(node_id INTEGER NOT NULL, neighbor_id INTEGER NOT NULL,
                               PRIMARY KEY(node_id, neighbor_id)) WITHOUT ROWID;
        INSERT OR IGNORE INTO neighbors SELECT from_node, to_node FROM segments WHERE from_node != to_node;
        INSERT OR IGNORE INTO neighbors SELECT to_node, from_node FROM segments WHERE from_node != to_node;
        CREATE TABLE junctions AS
            SELECT d.node_id, d.degree, COUNT(DISTINCT w.way_id) AS track_way_count
            FROM (SELECT node_id, COUNT(*) AS degree FROM neighbors
                  GROUP BY node_id HAVING COUNT(*) >= 3) d
            JOIN node_ways w ON w.node_id=d.node_id
            GROUP BY d.node_id, d.degree;
        CREATE UNIQUE INDEX junction_id ON junctions(node_id);
        CREATE TABLE junction_ways(
            junction_node_id INTEGER NOT NULL,
            way_id INTEGER NOT NULL,
            PRIMARY KEY(junction_node_id, way_id)
        );
        INSERT INTO junction_ways
            SELECT DISTINCT j.node_id, w.way_id
            FROM junctions j JOIN node_ways w ON w.node_id=j.node_id;
        CREATE INDEX junction_ways_way ON junction_ways(way_id);
        CREATE TABLE station_track_links(
            station_node_id INTEGER NOT NULL,
            track_node_id INTEGER NOT NULL,
            way_id INTEGER NOT NULL,
            link_type TEXT NOT NULL,
            relation_id INTEGER NOT NULL,
            PRIMARY KEY(station_node_id, track_node_id, way_id, link_type, relation_id)
        );
        INSERT INTO station_track_links
            SELECT DISTINCT s.osm_id, s.osm_id, w.way_id, 'shared_track_node', 0
            FROM stations s JOIN node_ways w ON w.node_id=s.osm_id
            WHERE s.osm_type='node';
        INSERT OR IGNORE INTO station_track_links
            SELECT DISTINCT station.osm_id, CAST(stop.ref AS INTEGER), ways.way_id,
                   'public_transport_stop_area', relation.id
            FROM relations relation
            JOIN relation_members station_member ON station_member.relation_id=relation.id
                AND station_member.member_type='node'
                AND station_member.role IN ('station', 'stop', '')
            JOIN stations station ON station.osm_type='node'
                AND station.osm_id=station_member.ref
            JOIN relation_members stop ON stop.relation_id=relation.id
                AND stop.member_type='node'
                AND stop.ref!=station_member.ref
                AND stop.role IN ('stop', '')
            JOIN nodes stop_node ON stop_node.id=stop.ref
            JOIN node_ways ways ON ways.node_id=stop_node.id
            WHERE relation.category='public_transport'
              AND (json_extract(stop_node.tags, '$.public_transport')='stop_position'
                   OR json_extract(stop_node.tags, '$.railway')='stop');
        CREATE INDEX station_track_links_way ON station_track_links(way_id);
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
        "junction_way_links": "SELECT COUNT(*) FROM junction_ways",
        "station_nodes": "SELECT COUNT(*) FROM stations WHERE osm_type='node'",
        "station_ways": "SELECT COUNT(*) FROM stations WHERE osm_type='way'",
        "rail_route_relations": "SELECT COUNT(*) FROM relations WHERE category='route'",
        "public_transport_relations": "SELECT COUNT(*) FROM relations WHERE category='public_transport'",
        "relation_members": "SELECT COUNT(*) FROM relation_members",
        "station_nodes_with_shared_track_node": """SELECT COUNT(DISTINCT station_node_id)
            FROM station_track_links WHERE link_type='shared_track_node'""",
        "station_nodes_with_explicit_stop_area_link": """SELECT COUNT(DISTINCT station_node_id)
            FROM station_track_links WHERE link_type='public_transport_stop_area'""",
        "station_track_link_rows": "SELECT COUNT(*) FROM station_track_links",
        "junction_candidates_with_3plus_ways": "SELECT COUNT(*) FROM junctions WHERE track_way_count>=3",
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


def match_independent_stations(database, station_file, output, summary_file,
                               routes_output, routes_summary_output):
    outputs = (output, summary_file, routes_output, routes_summary_output)
    if any(os.path.exists(path) for path in outputs):
        raise FileExistsError("Refusing to overwrite station match outputs")
    pipeline_path = os.path.join(os.path.dirname(__file__), "..", "..", "loader_pipeline.py")
    with open(pipeline_path, encoding="utf-8") as f:
        pipeline = ast.parse(f.read(), filename=pipeline_path)
    fallback_assignment = next(
        node for node in pipeline.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "FALLBACK_STATIONS" for target in node.targets)
    )
    fallback_codes = {row[0].upper() for row in ast.literal_eval(fallback_assignment.value)}
    db = sqlite3.connect(f"file:{os.path.abspath(database)}?mode=ro", uri=True)
    with open(station_file, encoding="utf-8") as source:
        stations = json.load(source)
    candidates = []
    for code, name, lat, lon in stations:
        dy = 1000 / 110000
        dx = dy / max(0.01, math.cos(math.radians(lat)))
        rows = db.execute("""
            SELECT n.id, n.lat, n.lon, n.tags,
                   (SELECT group_concat(DISTINCT way_id) FROM station_track_links l
                    WHERE l.station_node_id=n.id),
                   (SELECT group_concat(DISTINCT link_type) FROM station_track_links l
                    WHERE l.station_node_id=n.id),
                   (SELECT group_concat(DISTINCT track_node_id) FROM station_track_links l
                    WHERE l.station_node_id=n.id)
            FROM station_locations r JOIN nodes n ON n.id=r.id
            WHERE r.min_lat<=? AND r.max_lat>=? AND r.min_lon<=? AND r.max_lon>=?
        """, (lat + dy, lat - dy, lon + dx, lon - dx))
        for node_id, nlat, nlon, tags_json, way_ids, link_types, track_node_ids in rows:
            tags = json.loads(tags_json)
            refs = {item.strip().upper() for item in re.split(r"[;,]", tags.get("ref", ""))}
            if code.upper() not in refs:
                continue
            meters = distance(lat, lon, nlat, nlon)
            if meters > 1000:
                continue
            candidates.append({
                "code": code, "name": name, "lat": lat, "lon": lon,
                "source": "project_approximate_fallback" if code.upper() in fallback_codes else "DataMeet-derived",
                "osm_id": node_id, "osm_ref": tags.get("ref", ""),
                "osm_name": tags.get("name", ""),
                "distance_m": round(meters, 1),
                "way_ids": sorted(int(value) for value in re.split(r"[;,]", way_ids or "") if value),
                "link_types": sorted((link_types or "").split(",")),
                "track_node_ids": sorted(int(value) for value in re.split(r"[;,]", track_node_ids or "") if value),
            })
    db.close()

    code_counts = {}
    node_counts = {}
    for row in candidates:
        code_counts[row["code"]] = code_counts.get(row["code"], 0) + 1
        node_counts[row["osm_id"]] = node_counts.get(row["osm_id"], 0) + 1
    with open(output, "x", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "station_code", "station_name", "station_lat", "station_lon", "station_source",
            "source_license", "osm_station_node_id", "osm_ref", "osm_name", "distance_m", "track_way_ids",
            "track_link_types", "shares_track_node", "has_explicit_track_link",
            "candidate_count_for_code", "candidate_count_for_osm_node",
            "status",
        ])
        for row in sorted(candidates, key=lambda item: (item["code"], item["distance_m"], item["osm_id"])):
            writer.writerow([
                row["code"], row["name"], row["lat"], row["lon"], row["source"],
                ("DataMeet CC0; OSM-derived match ODbL" if row["source"] == "DataMeet-derived"
                 else "Project approximation; OSM-derived match ODbL"),
                row["osm_id"], row["osm_ref"], row["osm_name"], row["distance_m"], json.dumps(row["way_ids"]),
                json.dumps(row["link_types"]), int("shared_track_node" in row["link_types"]),
                int(bool(row["link_types"])), code_counts[row["code"]], node_counts[row["osm_id"]],
                "unreviewed_candidate",
            ])
    summary = {
        "station_catalog": station_file,
        "station_catalog_source": "https://raw.githubusercontent.com/datameet/railways/master/stations.json",
        "provenance": "DataMeet-derived catalog plus project approximate fallback entries; per-record source is marked in CSV",
        "matching_rule": "exact OSM station-node ref token equals station code and coordinates are within 1000 m; proximity is only a sanity filter",
        "candidate_rows": len(candidates),
        "source_records": len(stations),
        "project_approximate_fallback_candidate_rows": sum(row["source"] == "project_approximate_fallback" for row in candidates),
        "distinct_station_codes_with_candidates": len(code_counts),
        "candidate_rows_sharing_track_node": sum("shared_track_node" in row["link_types"] for row in candidates),
        "candidate_rows_with_explicit_track_link": sum(bool(row["link_types"]) for row in candidates),
        "distinct_station_codes_with_track_link_candidate": len({
            row["code"] for row in candidates if row["link_types"]
        }),
        "ambiguous_station_codes": sum(value > 1 for value in code_counts.values()),
        "ambiguous_osm_station_nodes": sum(value > 1 for value in node_counts.values()),
        "radius_m": 1000,
        "status": "all rows are candidates; none are independently reviewed or verified station identities",
    }
    with open(summary_file, "x", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write("\n")
    route_summary = build_station_route_candidates(
        database, candidates, routes_output, catalog_station_count=len(stations))
    with open(routes_summary_output, "x", encoding="utf-8") as f:
        json.dump(route_summary, f, indent=2, ensure_ascii=False)
        f.write("\n")


def build_station_route_candidates(database, candidates, output, catalog_station_count=None):
    code_counts = {}
    node_counts = {}
    for row in candidates:
        code_counts[row["code"]] = code_counts.get(row["code"], 0) + 1
        node_counts[row["osm_id"]] = node_counts.get(row["osm_id"], 0) + 1
    seeds = {
        row["code"]: row["track_node_ids"]
        for row in candidates
        if row["way_ids"] and row["track_node_ids"]
        and code_counts[row["code"]] == 1 and node_counts[row["osm_id"]] == 1
    }

    db = sqlite3.connect(f"file:{os.path.abspath(database)}?mode=ro", uri=True)
    adjacency = {}
    for a, b, alat, alon, blat, blon in db.execute("""
        SELECT e.node_id,e.neighbor_id,a.lat,a.lon,b.lat,b.lon
        FROM neighbors e
        JOIN nodes a ON a.id=e.node_id
        JOIN nodes b ON b.id=e.neighbor_id
    """):
        adjacency.setdefault(a, []).append((b, distance(alat, alon, blat, blon)))
    db.close()

    best = {}
    queue = []
    for code, nodes in seeds.items():
        for node in nodes:
            value = (0.0, code)
            if value < best.get(node, (math.inf, "")):
                best[node] = value
                heapq.heappush(queue, (0.0, code, node))
    while queue:
        cost, code, node = heapq.heappop(queue)
        if best.get(node) != (cost, code):
            continue
        for neighbor, length in adjacency.get(node, ()):
            candidate = (cost + length, code)
            if candidate < best.get(neighbor, (math.inf, "")):
                best[neighbor] = candidate
                heapq.heappush(queue, (candidate[0], code, neighbor))

    edges = {}
    for node, neighbors in adjacency.items():
        left = best.get(node)
        if left is None:
            continue
        for neighbor, length in neighbors:
            if node >= neighbor:
                continue
            right = best.get(neighbor)
            if right is None or left[1] == right[1]:
                continue
            pair = tuple(sorted((left[1], right[1])))
            path_distance = left[0] + length + right[0]
            if path_distance < edges.get(pair, math.inf):
                edges[pair] = path_distance

    with open(output, "x", encoding="utf-8") as f:
        json.dump({
            "schema_version": 1,
            "method": "Multi-source shortest-path partition over connected OSM track nodes; pair links meet across an actual shared track segment.",
            "stations_unreviewed": True,
            "edges": [[a, b, round(length, 1)] for (a, b), length in sorted(edges.items())],
        }, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")
    station_codes_in_edges = {code for pair in edges for code in pair}
    return {
        "station_seeds": len(seeds),
        "station_track_seed_nodes": sum(len(nodes) for nodes in seeds.values()),
        "station_catalog_records": catalog_station_count,
        "catalog_records_without_route_seed": (
            max(0, catalog_station_count - len(seeds)) if catalog_station_count is not None else None
        ),
        "station_codes_with_candidate_route_edges": len(station_codes_in_edges),
        "isolated_station_seeds": len(seeds) - len(station_codes_in_edges),
        "candidate_station_route_edges": len(edges),
        "edge_distance_unit": "metres, OSM geometry haversine estimate",
        "station_seed_rule": "unique independent-catalog code and OSM station node with exact ref token within 1000 m, linked to active track by shared node or explicit public_transport stop-area relation; identity remains unreviewed",
        "edge_rule": "only adjacent regions joined by an actual consecutive-node track segment; distance combines OSM track-geometry shortest distances to that segment",
        "network_coverage": "unknown; OSM mapping and real-world connectivity not independently verified",
        "status": "candidate paths only; no train timetable, train-specific route, or live train position",
        "source": "OpenStreetMap © contributors, ODbL 1.0; independent station catalog is DataMeet-derived CC0 with project fallback records separately labeled",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?")
    parser.add_argument("database", nargs="?")
    parser.add_argument("report", nargs="?")
    parser.add_argument("--xml", action="store_true", help="Input is OSM XML, for fixtures")
    parser.add_argument("--match-archive", help="Optional restricted IRSD ZIP, never published by workflow")
    parser.add_argument("--matches-output", help="Private CSV for unreviewed matches")
    parser.add_argument("--independent-stations", help="Independent station catalog JSON (not WIMT/IRSD)")
    parser.add_argument("--independent-matches-output", help="CSV for independent station candidates")
    parser.add_argument("--match-summary", help="Summary JSON for independent station candidates")
    parser.add_argument("--station-routes-output", help="OSM track-derived candidate station routes JSON")
    parser.add_argument("--station-routes-summary", help="OSM candidate route summary JSON")
    args = parser.parse_args()
    if not all((args.input, args.database, args.report)):
        parser.error("input, database and report are required")
    if bool(args.match_archive) != bool(args.matches_output):
        parser.error("--match-archive and --matches-output must be supplied together")
    independent_args = (args.independent_stations, args.independent_matches_output, args.match_summary,
                        args.station_routes_output, args.station_routes_summary)
    if any(independent_args) and not all(independent_args):
        parser.error("all independent-station and route-candidate output options must be supplied together")
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
    if args.independent_stations:
        match_independent_stations(args.database, args.independent_stations,
                                   args.independent_matches_output, args.match_summary,
                                   args.station_routes_output, args.station_routes_summary)


if __name__ == "__main__":
    main()
