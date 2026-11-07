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
<way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="railway" v="rail"/></way>
<way id="11"><nd ref="2"/><nd ref="4"/><tag k="railway" v="rail"/></way>
<way id="12"><nd ref="3"/><nd ref="5"/><tag k="railway" v="rail"/><tag k="disused" v="yes"/></way>
<way id="13"><nd ref="4"/><nd ref="5"/><tag k="railway" v="construction"/></way>
<way id="14"><nd ref="1"/><nd ref="6"/><nd ref="1"/><tag k="railway" v="station"/></way>
<relation id="20"><member type="way" ref="10" role="forward"/><tag k="route" v="train"/><tag k="type" v="route"/></relation>
</osm>"""


class GraphTest(unittest.TestCase):
    def test_graph_and_private_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath = os.path.join(tmp, "graph.sqlite")
            report = os.path.join(tmp, "coverage.json")
            build_graph.build(io.BytesIO(FIXTURE), dbpath, report)
            db = sqlite3.connect(dbpath)
            self.assertEqual(db.execute("SELECT way_id,from_node,to_node FROM segments ORDER BY way_id,sequence").fetchall(),
                             [(10, 1, 2), (10, 2, 3), (11, 2, 4)])
            self.assertEqual(db.execute("SELECT node_id,degree,track_way_count FROM junctions").fetchall(), [(2, 3, 2)])
            self.assertEqual(db.execute("SELECT junction_node_id,way_id FROM junction_ways ORDER BY way_id").fetchall(),
                             [(2, 10), (2, 11)])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM stations").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT station_node_id,way_id FROM station_track_links").fetchall(),
                             [(1, 10)])
            self.assertEqual(db.execute("SELECT id,tags,members FROM relations").fetchone()[0], 20)
            with open(report, encoding="utf-8") as f:
                self.assertEqual(json.load(f)["station_nodes_with_shared_track_node"], 1)
            db.close()
            archive = os.path.join(tmp, "stations.zip")
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("data/stations.csv", "station_code,gid,lat,lng\nDOS,1,25,84\nFAR,2,30,80\n")
            output = os.path.join(tmp, "matches.csv")
            build_graph.match(dbpath, archive, output)
            with open(output, newline="") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["status"], "unreviewed_candidate")
            self.assertEqual(rows[0]["osm_ref_matches_code"], "1")
            self.assertNotIn("FAR", [r["irsd_code"] for r in rows])
            independent_output = os.path.join(tmp, "independent-candidates.csv")
            summary_output = os.path.join(tmp, "summary.json")
            stations = os.path.join(tmp, "stations.json")
            with open(stations, "w", encoding="utf-8") as f:
                json.dump([["DOS", "Dehri On Sone", 25, 84], ["GADH", "Garhani", 25, 84],
                           ["FAR", "Far", 30, 80]], f)
            build_graph.match_independent_stations(dbpath, stations, independent_output, summary_output)
            with open(independent_output, newline="", encoding="utf-8") as f:
                independent_rows = list(csv.DictReader(f))
            self.assertEqual(len(independent_rows), 2)
            self.assertEqual(independent_rows[0]["station_code"], "DOS")
            self.assertEqual(independent_rows[0]["shares_track_node"], "1")
            self.assertEqual(independent_rows[0]["status"], "unreviewed_candidate")
            self.assertEqual(independent_rows[1]["station_source"], "project_approximate_fallback")
            self.assertEqual(independent_rows[0]["candidate_count_for_osm_node"], "2")
            with open(summary_output, encoding="utf-8") as f:
                summary = json.load(f)
                self.assertEqual(summary["candidate_rows_sharing_track_node"], 2)
                self.assertEqual(summary["ambiguous_osm_station_nodes"], 1)

    def test_missing_node_fails(self):
        data = FIXTURE.replace(b'<nd ref="4"/>', b'<nd ref="999"/>', 1)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "missing nodes"):
                build_graph.build(io.BytesIO(data), os.path.join(tmp, "db"), os.path.join(tmp, "report"))


if __name__ == "__main__":
    unittest.main()
