# OSM railway extract and graph

The workflow downloads the Geofabrik India extract, checks its MD5 and
selects railway ways, station/halt nodes and ways, and selected railway
infrastructure nodes. Referenced nodes are included and `osmium check-refs`
must pass. The release includes the extract, source file metadata, SHA-256
hashes, coverage counts and a gzip-compressed SQLite graph. The source
timestamp is in the notice and file metadata.

The earlier `osm-rail-20261107` release omitted referenced nodes and must
not be used to construct a graph.

## Database dictionary

- `nodes`: OSM node `id`, `lat`, `lon`, and original `tags` as JSON. Includes
  infrastructure and station nodes as well as track geometry nodes.
- `ways`: OSM way `id`, `railway` classification, original `tags` as JSON.
  Graph track ways use `rail`, `narrow_gauge`, `light_rail`, `subway`, `tram`,
  `funicular`, `monorail`, `miniature` or `preserved`,
  excluding ways explicitly marked disused, abandoned, under construction
  or proposed. Other extract classes are retained in the PBF, not the graph.
- `segments`: `way_id`, zero-based `sequence`, `from_node`, `to_node`.
  Each is a pair of consecutive nodes of one OSM way, not a station-to-station
  edge. Identical endpoints are retained but excluded from neighbor counts.
- `relations`: OSM route relation `id`, original `tags`, and ordered member
  objects (`type`, `ref`, `role`) as JSON. These are mapped OSM relations,
  not authoritative timetables or proof a particular train runs that route.
- `neighbors`: distinct directed node-neighbor pairs from segments, provided
  in both directions. This is physical topology, not a train movement rule.
- `junctions`: `node_id`, distinct neighboring-node `degree`, and the number
  of distinct incident `track_way_count`. These are candidate branch points,
  not verified junctions. A node with three or more ways may still be a
  crossing, siding, or mapping artifact.
- `junction_ways`: candidate junction node and every distinct incident track
  way. This preserves the topology relationship; it does not designate a
  main line or branch line.
- `station_track_links`: OSM station-point node, the same track node, and an
  incident track way. This relationship exists only when the OSM station node
  is literally shared with a track way; nearby stations are not linked.
- `stations`: `osm_type` (`node` or `way`), `osm_id`, `railway`, original
  `tags`, and `node_refs` (JSON for ways, null for nodes). These are OSM
  station features, not IRSD records. Station ways are not automatically
  connected to tracks.
- `station_locations`: SQLite R-tree index for OSM station nodes.

`coverage.json` counts OSM objects and topology candidates; it is not a
percentage of the Indian rail network. A shared OSM node establishes mapped
connectivity, not independent verification or permission for a train to traverse it.
Disconnected tracks, parallel lines, overlapping bridges and incomplete or
incorrect OSM mapping may affect results. No branch/main-line designation is
inferred from degree. Station-to-track relations only exist for literal shared
OSM nodes. No station-to-station edge or train schedule is asserted.

## Independent station candidates

`independent-station-candidates.csv` compares the Safar bundled catalog
(DataMeet-derived plus a small set of approximate project fallback stations)
with OSM railway station/halt nodes. Its source is not WIMT/IRSD. The DataMeet
source is the station URL referenced in `loader_pipeline.py`; the app
identifies that data as CC0. The CSV columns are station code/name/coordinates
and source/license, OSM station node ID/ref/name, separation in metres,
incident shared track-way IDs, a shared-node flag, candidate multiplicity
counts, and status. Candidates require an exact OSM `ref` code token and a
1 km coordinate sanity check; name and distance alone never create a match.
`shares_track_node=1` means the OSM station node is literally part of one or
more retained active track ways. It is an OSM topology fact, but the identity
match back to the Safar catalog still needs review. Other rows are not
connected to the physical graph.

`station-match-summary.json` reports counts, not accuracy or national
coverage. It must not be used to claim complete station mapping. No IRSD
records are included, and this result does not update the tracker app.

The summary and `coverage.json` report object counts and topology counts.
`station_nodes_with_shared_track_node` counts OSM station nodes that share
one or more track nodes; `station_track_link_rows` counts those station-way
incidences. `topological_junction_candidates` counts nodes with three or more
distinct neighboring track nodes, and `junction_candidates_with_3plus_ways`
is the subset with three or more incident OSM track ways. These are not
national completeness percentages or independently verified facilities.

## Restricted IRSD matching

The WIMT-derived IRSD archive has unresolved redistribution rights and is
not included in release outputs. To generate a **private**, unreviewed
candidate CSV locally, run:

```
python3 irsd/osm/build_graph.py india-rail.osm.pbf graph.sqlite coverage.json \
  --match-archive station_network_analysis.zip --matches-output private-matches.csv
```

Requires `osmium` and Python 3 with SQLite R-tree support. Each CSV row is
an IRSD station and an OSM station **node** within 1 km. Columns: IRSD code
and gid, OSM node ID, straight-line distance in metres, whether an OSM `ref`
token equals the code, and `unreviewed_candidate`. Multiple candidates are
retained; no row means no candidate node within the threshold, not absence
of a station. Station polygons are not matched. Distance and code do not
establish identity or a track connection. Review candidates and map station
features to track with actual evidence before making station links.

Physical OSM tracks, train timetables and a user's live GPS measurements are
distinct datasets. GPS alone cannot reliably determine the train's route or
whether it stopped at a station. Do not feed candidate matches or this graph
directly into the tracker as verified station routes.

See [ATTRIBUTION.md](ATTRIBUTION.md) for licence and source information.
