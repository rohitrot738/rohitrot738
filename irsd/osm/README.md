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
  Graph track ways use `rail`, `narrow_gauge`, `light_rail` or `preserved`,
  excluding ways explicitly marked disused, abandoned, under construction
  or proposed. Other extract classes are retained in the PBF, not the graph.
- `segments`: `way_id`, zero-based `sequence`, `from_node`, `to_node`.
  Each is a pair of consecutive nodes of one OSM way, not a station-to-station
  edge. Identical endpoints are retained but excluded from neighbor counts.
- `neighbors`: distinct directed node-neighbor pairs from segments, provided
  in both directions. This is physical topology, not a train movement rule.
- `junctions`: `node_id`, distinct neighboring-node `degree`, and the number
  of distinct incident `track_way_count`. These are candidate branch points,
  not verified junctions. A node with three or more ways may still be a
  crossing, siding, or mapping artifact.
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
inferred from degree. No station-to-station edge or train route is asserted.

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
