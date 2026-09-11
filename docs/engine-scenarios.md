# Canonical Maps Engine Scenarios

These scenarios are stable workload identities for implementation tests, reference comparisons, runtime-profiler capture, Moonlight evaluation and CI. They are not benchmark names tied to a particular implementation.

## Contract

Every scenario must define:

- a stable id;
- deterministic fixture/input generation;
- declared viewport and device assumptions;
- observable semantic outputs that can be normalized for comparison;
- runtime phases worth measuring separately;
- explicit capability requirements;
- bounded execution and artifact sizes.

A scenario must not claim success when a required capability is unavailable. Capability absence is `unavailable`; incomparable baseline/candidate evidence is `inconclusive`.

## Initial scenario corpus

### `camera-world-pan-v1`

Purpose: exercise canonical camera/projection behavior independent of renderer.

Fixture:

- viewport 1280x720;
- start at `[0, 0]`, zoom 2;
- pan east across the antimeridian and back;
- zoom through integer and fractional levels;
- resize to 800x600;
- project/unproject a deterministic set of coordinates.

Semantic evidence:

- canonical camera state after every operation;
- projected screen coordinates;
- unprojected geographic coordinates;
- world-wrap identity;
- visible geographic bounds.

Runtime phases:

- camera update;
- projection batch;
- visible-world calculation.

### `raster-tile-churn-v1`

Purpose: exercise tile identity, scheduling, cancellation and cache lifecycle.

Fixture:

- deterministic local tile fixture source;
- cold initial viewport;
- rapid pan over several viewport widths;
- reverse direction before all requested tiles complete;
- revisit the original viewport.

Semantic evidence:

- canonical requested tile identities and priority order;
- cancellations;
- deduplicated requests;
- cache hits/misses;
- evictions;
- final visible tile set.

Runtime phases:

- visible-tile calculation;
- scheduling;
- decode/upload where applicable;
- warm-cache revisit.

### `dense-points-100k-v1`

Purpose: measure the already-authoritative Rust point index together with render preparation and interaction.

Fixture:

- deterministic seeded 100k point dataset with numeric metrics;
- 1280x720 viewport;
- fixed pan/zoom journey;
- deterministic pick coordinates.

Semantic evidence:

- visible point/cluster identities;
- cluster metrics;
- expansion zoom;
- bounded leaves;
- pick results.

Runtime phases:

- index build;
- viewport aggregation;
- render-frame preparation;
- renderer upload/paint;
- picking.

### `geometry-edit-dense-v1`

Purpose: exercise line/polygon rendering and edit semantics under a non-trivial dataset.

Fixture:

- deterministic GeoJSON collection containing long lines, polygons, holes and overlapping features;
- scripted select, vertex move, insert, delete and reshape operations.

Semantic evidence:

- normalized resulting GeoJSON;
- topology/validation result;
- feature identity;
- pick result at defined screen coordinates.

Runtime phases:

- geometry preparation;
- render-frame preparation;
- paint;
- picking;
- edit operation application.

### `vector-city-style-v1`

Purpose: become the primary MapLibre reference scenario for Milestones D/E.

Fixture:

- committed deterministic vector-tile fixtures rather than live network data;
- committed style fixture using background/fill/line/circle first, then symbols once supported;
- fixed viewport journey across zoom levels.

Semantic evidence:

- decoded feature identities and properties;
- evaluated layer visibility/order/style values;
- render-bucket identities/counts;
- normalized pick results;
- later: normalized symbol placement.

Runtime phases:

- tile decode;
- style evaluation;
- bucket construction;
- upload;
- render;
- picking.

### `labels-dense-city-v1`

Purpose: validate stable cartographic label placement.

Fixture:

- deterministic label/sprite/glyph fixtures;
- dense overlapping point and line labels;
- pan/zoom path designed to cause candidate collisions.

Semantic evidence:

- shaped runs;
- placement/collision decisions;
- cross-tile identity;
- stable visible symbol set per camera state.

Runtime phases:

- shaping;
- candidate generation;
- collision/placement;
- glyph upload;
- rendering.

## Evidence ownership

Maps owns the fixture and normalized map-domain observations. `runtime-profiler` owns runtime capture and immutable evidence bundles. Moonlight owns baseline/candidate evaluation policy. Renderer-specific diagnostic fields may be included as evidence, but they do not become semantic truth.

## Growth rule

Add a new scenario only when it introduces a materially different workload family or acceptance boundary. Do not add scenarios merely because a new internal type, layer implementation or optimization exists.
