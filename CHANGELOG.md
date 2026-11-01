# @moritzbrantner/maps

## Unreleased

### Breaking Changes

- The root entry no longer exports `EditableGeoJsonMap` or the GeoJSON
  timeline exports (`GeoJsonTimelineEditor`, `createGeoJsonTimelineDocument`,
  and related helpers and types). Import them from
  `@moritzbrantner/maps/editor` and `@moritzbrantner/maps/timeline`; the root
  entry now bundles without the optional `@moritzbrantner/timeline-editor` peer.
- Removed the `supercluster` dependency. Point clustering now comes only from
  the Maps Rust/WASM runtime, which Map Views start on mount; cluster layers
  rebuild their indexes once it is ready. Until then, and in SSR or
  `core`-only code, `createPointAggregationIndex()` returns points unclustered
  and reports a `fallback` diagnostic.

### Minor Changes

- Exported `ensureMapsAggregationWasm()`, `getMapsAggregationRuntimeStatus()`,
  `subscribeMapsAggregationRuntime()` and the `MapsAggregationRuntimeStatus`
  type from the root and `core` entries. Consumers can await or observe the
  Rust/WASM aggregation runtime (`idle`, `loading`, `ready`, `unavailable`).
- `PointLayer` accepts `getPointLabel` to draw text centered on a point, as
  cluster layers draw their counts. On WebGPU, labeled points stay GPU-retained
  and camera frames project only the labeled points for the label pass.

### Patch Changes

- On the MapLibre runtime, `controller.setViewState()` now moves the camera of
  an uncontrolled Map View (it only updated React state before). Camera frames
  no longer set the unchanged bounds minimum zoom from the constraints effect,
  which logged React's "Maximum update depth exceeded" during per-frame camera
  animation and cost a second commit per frame.
- GeoJSON lines on the Maps flat runtime now follow MapLibre's GeoJSON source.
  As geojson-vt does, they are simplified by 0.375 px at the floored camera
  zoom and snapped to the 8192-unit tile grid. The line geometry is rebuilt when
  that zoom changes.
- On the Maps flat runtime, releasing a right-drag rotate no longer opens a
  feature's context menu or selects the feature under the pointer. Feature
  context menus now open on release, as in MapLibre.
- Lines on the Maps flat runtime now render like MapLibre's line layers. Vector
  tile lines and GeoJSON lines use MapLibre's round-join tessellation, so
  sharp corners no longer crack and translucent lines no longer darken at every
  vertex. Lines thinner than a pixel fade by their coverage. Vector tile lines
  are clipped to their tile, and vector tilesets load the floored zoom as
  MapLibre's vector sources do. The `frameStats()` field
  `retainedVectorLineSegments` is now `retainedVectorLineTriangles`.
- Pitched cameras on the Maps flat runtime now match MapLibre. They use
  MapLibre's field of view (36.87° instead of 45°) and near/far planes, so
  overlays, picks and drag pans land where MapLibre puts them. Lines and polygon
  outlines are stroked on the map plane and thin with distance, and circles
  scale with their depth (`circle-pitch-scale: map`). Raster tiles now carry mip
  chains and are filtered anisotropically above 20° of pitch, so far tiles no
  longer alias.
- Wheel zoom on the Maps flat runtime now follows MapLibre's scroll zoom. It
  tells mouse wheels from trackpads the same way, maps the summed deltas of
  each frame through MapLibre's rate curve (at most a factor of two per frame),
  eases mouse-wheel zoom over 200 ms, and zooms about the pointer where the
  gesture started. A mouse notch now zooms about 0.18 levels instead of 0.3. The
  same wheel input now ends on MapLibre's bounds in the MapLibre oracle (#311).
- The Maps flat runtime now draws overlay circles and strokes as MapLibre does.
  A circle's stroke lies outside its radius, and the circle edge and the
  fill-to-stroke edge fade over one device pixel. Polygon outlines and lines
  fade over one device pixel at their edges. Cluster bubbles use MapLibre's 0.9
  fill opacity. The Canvas fallback also draws circle strokes outside the
  radius. The MapLibre oracle's church-site-discovery and clusters scenarios
  now pass their image gate (#309).
- The Maps flat runtime now picks raster tile levels and places raster tiles
  as MapLibre does: the covering zoom is rounded instead of floored (zoom 4.6
  with 256 px tiles shows z6), and at rest raster tiles snap to the pixel grid.
  The MapLibre oracle's zoom-crossfade and source-location scenarios now pass
  their image gate (#308).
- On WebGPU, changing some points of a GPU-retained point group, through new
  data or hover/selection, now updates only those points on the GPU. The
  renderer no longer re-uploads the whole group, and unchanged retained shape
  groups are not re-sent.
- Cluster layers (`ClusterLayer` on MapLibre and Maps Map Views,
  `CanvasPointClusterLayer`) no longer draw every point while the aggregation
  runtime is still loading. Before, a MapLibre style that loaded first drew a
  dense dataset as one MapLibre source and layer per point. With 100,000 points
  that blocked the main thread for minutes. The layers now stay pending (nothing
  drawn, no viewport aggregation reported) until the runtime is ready, then draw
  the Rust-clustered view. The unclustered fallback applies only once loading
  has failed.
- Imported `polygon-clipping` through its default export so Rollup-based
  bundlers (Vite 5) accept the package.
- Map Views now publish camera and hover state separately from their stable
  surface capabilities. Hovering or moving the camera no longer re-renders
  layers that do not draw from that state, no longer re-runs Maps-native
  compatibility frames on hover, and no longer makes a mounted GeoJSON Editor
  re-render every MapLibre layer. A MapLibre Map View with `maxBounds` and a
  GeoJSON Editor no longer loops renders.
- On MapLibre Map Views, uncontrolled hover now updates the hovered class and
  flow opacity of point, cluster, flow and GeoJSON layers. The existing markers
  and paths are restyled in place, so hovered features stay mounted under the
  pointer and the layers do not re-render. Before, their hover styling only
  refreshed when a mounted GeoJSON Editor forced a full layer re-render.

## 0.1.5

### Patch Changes

- Slimmed the default `styles.css` export by removing Tailwind
  preflight/global reset and added `styles.full.css` as the compatibility
  stylesheet.
- Made bundle analysis baselines hash-insensitive for emitted chunks.
- Added benchmark warning thresholds alongside hard failure budgets.
- Updated `@moritzbrantner/ui` to `1.0.0`; refreshed Chromium smoke
  screenshots for the resulting UI spacing and styling changes.

## 0.1.4

### Patch Changes

- Added controlled bee-line measurement props for flat MapLibre maps.
- Made default heat-map radius and interpolated intensity data-space based.

## 0.1.3

### Patch Changes

- Extracted the package into the standalone `moritzbrantner/maps` repository.
- Kept the public exports and runtime behavior unchanged.

## 0.1.2

### Patch Changes

- Updated dependencies:
  - @moritzbrantner/ui@0.4.0

## 0.1.1

### Patch Changes

- Release every package in the workspace.

- Updated dependencies []:
  - @moritzbrantner/data-density@0.1.1
  - @moritzbrantner/ui@0.3.1
