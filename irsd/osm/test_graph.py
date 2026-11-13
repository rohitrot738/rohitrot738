import csv
import io
import json
import os
import sqlite3
import tempfile
import unittest
import zipfile

import build_graph


FIXTURE = b"""<osm version="0.6">
<node id="1" lat="25.0" lon="84.0"><tag k="railway" v="station"/><tag k="ref" v="DOS;GADH"/></node>
<node id="2" lat="25.0" lon="84.001"/>
<node id="3" lat="25.001" lon="84.001"/>
<node id="4" lat="24.999" lon="84.001"/>
<node id="5" lat="25.0" lon="84.002"/>
<node id="6" lat="25.0" lon="84.0005"><tag k="railway" v="halt"/></node>
<node id="7" lat="25.0" lon="84.0001"><tag k="railway" v="station"/><tag k="ref" v="PT1"/></node>
<node id="8" lat="25.0" lon="84.0002"><tag k="public_transport" v="stop_position"/></node>
<node id="9" lat="25.0" lon="84.003"><tag k="railway" v="station"/><tag k="ref" v="NOLINK"/></node>
<node id="30" lat="26.0" lon="85.0"><tag k="amenity" v="bus_station"/><tag k="bus" v="yes"/><tag k="public_transport" v="station"/><tag k="name" v="City Bus Stand"/></node>
<node id="31" lat="26.0" lon="85.01"><tag k="amenity" v="ferry_terminal"/><tag k="ferry" v="yes"/><tag k="public_transport" v="station"/><tag k="name" v="Ghat Ferry"/></node>
<node id="32" lat="26.0" lon="85.02"><tag k="public_transport" v="station"/><tag k="train" v="yes"/><tag k="name" v="Train Halt"/></node>
<node id="33" lat="26.0" lon="85.03"><tag k="public_transport" v="station"/><tag k="name" v="Auto Stand"/></node>
<way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="railway" v="rail"/></way>
<way id="11"><nd ref="2"/><nd ref="4"/><tag k="railway" v="rail"/></way>
<way id="12"><nd ref="3"/><nd ref="5"/><tag k="railway" v="rail"/><tag k="disused" v="yes"/></way>
<way id="13"><nd ref="4"/><nd ref="5"/><tag k="railway" v="construction"/></way>
<way id="14"><nd ref="1"/><nd ref="6"/><nd ref="1"/><tag k="railway" v="station"/></way>
<relation id="20"><member type="way" ref="10" role="forward"/><tag k="route" v="train"/><tag k="type" v="route"/></relation>
<way id="15"><nd ref="8"/><nd ref="2"/><tag k="railway" v="rail"/></way>
<relation id="21"><member type="node" ref="7" role="station"/><member type="node" ref="8" role="stop"/><tag k="public_transport" v="stop_area"/><tag k="type" v="public_transport"/></relation>
</osm>"""


class GraphTest(unittest.TestCase):
    def test_graph_and_private_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath = os.path.join(tmp, "graph.sqlite")
            report = os.path.join(tmp, "coverage.json")
            build_graph.build(io.BytesIO(FIXTURE), dbpath, report)
            db = sqlite3.connect(dbpath)
            self.assertEqual(db.execute("SELECT way_id,from_node,to_node FROM segments ORDER BY way_id,sequence").fetchall(),
                             [(10, 1, 2), (10, 2, 3), (11, 2, 4), (15, 8, 2)])
            self.assertEqual(db.execute("SELECT node_id,degree,track_way_count FROM junctions").fetchall(), [(2, 4, 3)])
            self.assertEqual(db.execute("SELECT junction_node_id,way_id FROM junction_ways ORDER BY way_id").fetchall(),
                             [(2, 10), (2, 11), (2, 15)])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM stations").fetchone()[0], 9)
            self.assertEqual(db.execute(
                "SELECT station_node_id,track_node_id,way_id,link_type FROM station_track_links ORDER BY station_node_id"
            ).fetchall(), [(1, 1, 10, "shared_track_node"), (7, 8, 15, "public_transport_stop_area")])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM relations").fetchone()[0], 2)
            with open(report, encoding="utf-8") as f:
                coverage = json.load(f)
                self.assertEqual(coverage["station_nodes_with_shared_track_node"], 1)
                self.assertEqual(coverage["station_nodes_with_explicit_stop_area_link"], 1)
                self.assertEqual(coverage["station_track_link_rows"], 2)
            db.close()
            linked_output = os.path.join(tmp, "linked-routes.json")
            linked_summary = build_graph.build_station_route_candidates(dbpath, [
                {"code": "DOS", "osm_id": 1, "way_ids": [10], "track_node_ids": [1]},
                {"code": "PT1", "osm_id": 7, "way_ids": [15], "track_node_ids": [8]},
            ], linked_output)
            self.assertEqual(linked_summary["station_seeds"], 2)
            with open(linked_output, encoding="utf-8") as f:
                self.assertEqual(len(json.load(f)["edges"]), 1)
            archive = os.path.join(tmp, "stations.zip")
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("data/stations.csv", "station_code,gid,lat,lng\nDOS,1,25,84\nFAR,2,30,80\n")
            output = os.path.join(tmp, "matches.csv")
            build_graph.match(dbpath, archive, output)
            with open(output, newline="") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 4)
            self.assertTrue(all(row["status"] == "unreviewed_candidate" for row in rows))
            self.assertTrue(any(row["osm_ref_matches_code"] == "1" for row in rows))
            self.assertNotIn("FAR", [r["irsd_code"] for r in rows])
            independent_output = os.path.join(tmp, "independent-candidates.csv")
            summary_output = os.path.join(tmp, "summary.json")
            routes_output = os.path.join(tmp, "routes.json")
            routes_summary = os.path.join(tmp, "routes-summary.json")
            osm_stations_output = os.path.join(tmp, "osm-stations.json")
            stations = os.path.join(tmp, "stations.json")
            with open(stations, "w", encoding="utf-8") as f:
                json.dump([["DOS", "Dehri On Sone", 25, 84], ["GADH", "Garhani", 25, 84],
                           ["NOLINK", "No Link", 25, 84.003],
                           ["FAR", "Far", 30, 80]], f)
            build_graph.match_independent_stations(
                dbpath, stations, independent_output, summary_output, routes_output, routes_summary,
                osm_stations_output)
            with open(independent_output, newline="", encoding="utf-8") as f:
                independent_rows = list(csv.DictReader(f))
            self.assertEqual(len(independent_rows), 3)
            dos_row = next(row for row in independent_rows if row["station_code"] == "DOS")
            no_link_row = next(row for row in independent_rows if row["station_code"] == "NOLINK")
            self.assertEqual(dos_row["shares_track_node"], "1")
            self.assertEqual(dos_row["status"], "unreviewed_candidate")
            self.assertEqual(dos_row["candidate_count_for_osm_node"], "2")
            self.assertEqual(no_link_row["track_link_types"], "[]")
            self.assertEqual(no_link_row["has_explicit_track_link"], "0")
            self.assertTrue(any(row["station_source"] == "project_approximate_fallback"
                                for row in independent_rows))
            with open(summary_output, encoding="utf-8") as f:
                summary = json.load(f)
                self.assertEqual(summary["candidate_rows_sharing_track_node"], 2)
                self.assertEqual(summary["candidate_rows_with_explicit_track_link"], 2)
                self.assertEqual(summary["ambiguous_osm_station_nodes"], 1)
            with open(routes_output, encoding="utf-8") as f:
                routes = json.load(f)
            self.assertTrue(routes["stations_unreviewed"])
            self.assertTrue(routes["edges"])
            self.assertTrue(all(a.startswith("OSM:") and b.startswith("OSM:")
                                for a, b, _ in routes["edges"]))
            with open(osm_stations_output, encoding="utf-8") as f:
                osm_stations = json.load(f)
            self.assertTrue(all(row[0].startswith("OSM:") for row in osm_stations))
            # The bus stand, the ferry ghat and the bare stand off the tracks are not stations a train stops at.
            self.assertEqual(sorted(row[1] for row in osm_stations if row[0] in ("OSM:30", "OSM:31", "OSM:32", "OSM:33")),
                             ["Train Halt"])
            self.assertEqual(len(osm_stations), 4)

    def test_candidate_station_route_uses_track_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath = os.path.join(tmp, "graph.sqlite")
            report = os.path.join(tmp, "coverage.json")
            build_graph.build(io.BytesIO(FIXTURE), dbpath, report)
            output = os.path.join(tmp, "routes.json")
            summary = build_graph.build_station_route_candidates(dbpath, [
                {"code": "A", "osm_id": 1, "way_ids": [10], "track_node_ids": [1]},
                {"code": "B", "osm_id": 3, "way_ids": [10], "track_node_ids": [3]},
            ], output)
            with open(output, encoding="utf-8") as f:
                routes = json.load(f)
            self.assertEqual({tuple(edge[:2]) for edge in routes["edges"]},
                             {("A", "OSM:7"), ("B", "OSM:7")})
            self.assertTrue(all(edge[2] > 0 for edge in routes["edges"]))
            self.assertEqual(summary["station_seeds"], 3)

    def test_missing_node_fails(self):
        data = FIXTURE.replace(b'<nd ref="4"/>', b'<nd ref="999"/>', 1)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "missing nodes"):
                build_graph.build(io.BytesIO(data), os.path.join(tmp, "db"), os.path.join(tmp, "report"))



    def test_misplaced_station_nodes_stay_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath = os.path.join(tmp, "graph.sqlite")
            build_graph.build(io.BytesIO(FIXTURE), dbpath, os.path.join(tmp, "coverage.json"))
            listed = os.path.join(tmp, "misplaced.json")
            with open(listed, "w", encoding="utf-8") as f:
                json.dump({"nodes": [{"osm_node": 9, "ref": "NOLINK", "why": "test"}]}, f)
            self.assertEqual(build_graph.misplaced_nodes(listed), {9})
            self.assertEqual(build_graph.misplaced_nodes(os.path.join(tmp, "none.json")), set())
            output = os.path.join(tmp, "osm-stations.json")
            build_graph.export_osm_station_catalog(dbpath, [], output, skip=build_graph.misplaced_nodes(listed))
            with open(output, encoding="utf-8") as f:
                exported = {row[0] for row in json.load(f)}
            self.assertNotIn("OSM:9", exported)
            self.assertIn("OSM:7", exported)
            routes = os.path.join(tmp, "routes.json")
            build_graph.build_station_route_candidates(dbpath, [], routes, skip={7})
            with open(routes, encoding="utf-8") as f:
                self.assertFalse(any("OSM:7" in edge[:2] for edge in json.load(f)["edges"]))
        # The project's own list is read from beside the script, and names real OSM nodes.
        self.assertTrue(build_graph.misplaced_nodes())

    def test_only_places_trains_stop_are_railway_stations(self):
        self.assertTrue(build_graph.is_railway_station({"railway": "station"}))
        self.assertTrue(build_graph.is_railway_station({"railway": "halt", "public_transport": "station"}))
        self.assertTrue(build_graph.is_railway_station({"railway": "station", "station": "subway"}))
        self.assertTrue(build_graph.is_railway_station({"public_transport": "station", "train": "yes"}))
        # Mapped only as a public-transport station, on a track: a railway station all the same.
        self.assertTrue(build_graph.is_railway_station({"public_transport": "station", "name": "LTA"}, on_track=True))
        self.assertFalse(build_graph.is_railway_station({"public_transport": "station", "name": "Auto Stand"}))
        for tags in ({"amenity": "bus_station", "public_transport": "station", "bus": "yes"},
                     {"amenity": "ferry_terminal", "public_transport": "station", "ferry": "yes"},
                     {"amenity": "taxi", "public_transport": "station"},
                     {"public_transport": "station", "aerialway": "station"},
                     {"public_transport": "station", "railway": "proposed", "station": "subway"},
                     {"public_transport": "station", "disused:railway": "station"}):
            self.assertFalse(build_graph.is_railway_station(tags, on_track=True), tags)

    def test_station_code_is_the_railway_ref(self):
        self.assertEqual(build_graph.station_code({"ref": "DDU"}), "DDU")
        self.assertEqual(build_graph.station_code({"ref": " pryj ; x1"}), "PRYJ")
        self.assertIsNone(build_graph.station_code({"ref": "12"}))
        self.assertIsNone(build_graph.station_code({"name": "No ref"}))
        self.assertIsNone(build_graph.station_code({"ref": "KMRP", "station": "subway"}))
        self.assertIsNone(build_graph.station_code({"ref": "AB", "network": "Delhi Metro"}))

if __name__ == "__main__":
    unittest.main()
