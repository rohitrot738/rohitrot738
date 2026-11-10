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
- `relation_members`: normalized relation ID and member object type, ID and
  role. Members from route and public-transport relations are retained for
  topology and station-stop linkage.
- `neighbors`: distinct directed node-neighbor pairs from segments, provided
  in both directions. This is physical topology, not a train movement rule.
- `junctions`: `node_id`, distinct neighboring-node `degree`, and the number
  of distinct incident `track_way_count`. These are candidate branch points,
  not verified junctions. A node with three or more ways may still be a
  crossing, siding, or mapping artifact.
- `junction_ways`: candidate junction node and every distinct incident track
  way. This preserves the topology relationship; it does not designate a
  main line or branch line.
- `station_track_links`: OSM station-point node, linked track node, incident
  track way, link type, and public-transport relation ID (zero for a shared
  node). Link types are either a literally shared track node or an explicit
  `type=public_transport`/`public_transport=stop_area` relation from the
  station node to a `public_transport=stop_position`/`railway=stop` node on a
  track way. Nearby stations are not linked by distance.
- `stations`: `osm_type` (`node` or `way`), `osm_id`, `railway`, original
  `tags`, and `node_refs` (JSON for ways, null for nodes). These are OSM
  station features, not IRSD records. Station ways are not automatically
  connected to tracks.
- `station_locations`: SQLite R-tree index for OSM station nodes.

`coverage.json` counts OSM objects and topology candidates; it is not a
percentage of the Indian rail network. Shared OSM nodes and explicit
stop-area relations establish mapped connectivity, not independent
verification or permission for a train to traverse it.
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
track-way IDs, explicit link types, a shared-node flag, candidate multiplicity
counts, and status. Candidates require an exact OSM `ref` code token and a
1 km coordinate sanity check; name and distance alone never create a match.
`shares_track_node=1` means the OSM station node is literally part of one or
more retained active track ways. `has_explicit_track_link=1` also includes
explicit OSM stop-area relations. These are OSM topology/relationship facts,
but the identity match back to the Safar catalog still needs review. Other
rows are not connected to the physical graph.

`station-match-summary.json` reports counts, not accuracy or national
coverage. It must not be used to claim complete station mapping. No IRSD
records are included.

`osm-stations.json` is the app's separate OSM station catalog. It contains
OSM railway station/halt nodes that are not already represented by a unique
station-code candidate in the project catalog. IDs use the prefix `OSM:` plus
the OSM node ID and are kept distinct from project station codes. OSM-only
entries can be selected as candidate-route endpoints but do not imply a
verified identity, station-to-track connection, or complete station inventory.

`station-route-candidates.json` is the route graph used by Safar. A
multi-source shortest-path partition runs over the OSM graph. Candidate
station nodes are seeds only if one catalog code uniquely matches one OSM
station `ref`, lies within the coordinate sanity radius, and has an explicit
OSM track link (shared track node or public-transport stop-area relation).
OSM-only station nodes with an explicit track link are also route seeds and
use their `OSM:<node id>` IDs.
An edge is emitted only between adjacent seed regions joined by an
actual consecutive-node track segment; the edge weight is the OSM geometry
path-length estimate through that segment. Duplicate or ambiguous code/node
matches are excluded from route seeds. The method does not use timetable
edges, station-name similarity, or free-standing distance guesses.
The JSON has `schema_version`, the derivation `method`, an explicit
`stations_unreviewed: true` flag, and `edges` rows shaped as
`[station_code_a, station_code_b, track_distance_metres]`.
The app summary includes the Geofabrik OSM replication timestamp so users
can see which snapshot the route candidates came from.

Routes shown by the app are still **candidates** because station identity and
OSM mapping have not been independently reviewed. A connected OSM path does
not say a train is scheduled to use it, nor does the graph provide real-time
train location. Both generated route files are copied into `safar/` by the
workflow so GitHub Pages can serve them with the app; the separate OSM station
catalog is copied there as well.
The tracker finds routes over these OSM candidate links together with the
older timetable-derived `edges.json`, because the OSM graph links only part of
the station catalog. A station with no link of its own joins its nearest
linked stations (within 15 km), and long timetable jumps are penalised so a
route steps station by station.

The summary and `coverage.json` report object counts and topology counts.
`station_nodes_with_shared_track_node` counts OSM station nodes that share
one or more track nodes. `station_nodes_with_explicit_stop_area_link` counts
stations explicitly related to track stop-position nodes. `station_track_link_rows`
counts all station-to-track relationships. `topological_junction_candidates` counts nodes with three or more
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
