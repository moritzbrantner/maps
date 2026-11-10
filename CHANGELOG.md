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

- Historical Map Feature selection (#170 phase D, Decisions 1.14/1.16/1.18/1.20).
  `useHistoricalMapFeatureSelection()` validates selection and hover against the one
  Map-Scoped Timeline clock: leaving a feature's period clears its selection, hover and popup
  and retains its dated details, shown by `HistoricalMapFeatureContextPanel` as **out of
  period** with a mini-timeline of its supported dates. Only an explicit mini-timeline date
  seeks the clock and reselects the feature. `resolveHistoricalMapFeatureName()` and the other
  pure helpers give date- and language-appropriate names from consumer-supplied records, also
  from `@moritzbrantner/maps/core`.
- On `flatRuntime="maps"`, an open feature popup now re-renders with its layer's latest
  `renderFeaturePopup` and feature instead of the click-time ones.
- One public Map-Scoped Timeline clock (#172). `createMapScopedTimelineClock()` owns the
  authoritative time, play/pause, seeking, snapping, looping and the single frame loop that
  advances it; `setControlledTime()` hands ownership of the time to the application, whose
  `onTimeChange` then receives seek and playback requests. `TemporalClusteredMap` and
  `TemporalHeatMap` take it as `timeline`, register their data's time range with it and only
  sample its `activeTime`, so several Map Views can share one clock (with
  `MapScopedTimelineControls` and `useMapScopedTimelineSnapshot`). Without `timeline` each
  component owns a clock configured from its existing `autoPlay`, `currentTime`,
  `defaultTime`, `loopPlayback`, `onTimeChange`, `playbackRate` and `timeStep` props, which
  keep their behaviour; neither component runs its own `requestAnimationFrame` loop any more.
- `ClusteredMap` and `TemporalClusteredMap` accept `flatRuntime`, so temporal points run on
  `flatRuntime="maps"` over static Map Layers passed as children. Measurement props remain
  MapLibre-only there and fail closed.

- `flatRuntime="maps"` accepts a MapLibre style with no sources and one
  constant-`background-color` `background` layer as a tile-free base, drawn on
  WebGPU and the Canvas fallback. Expressions, zoom functions, other background
  paint and extra layers fail closed with an explicit error.

- Patterned GeoJSON fills and lines draw under a pitched camera and on the Canvas fallback
  (#350). Under pitch the projected path samples the sprite perspective-correct: `fill-pattern`
  through the fill's stencil with MapLibre's per-tile outline, `line-pattern` on the map plane
  along its GeoJSON tile pieces, measured on the whole line. On Canvas, fills use a
  `CanvasPattern` on the tile grid (the local affine at the first vertex, an approximation
  under pitch) and lines a repeating image per segment (measured on the screen, without
  mitred joins); SDF images draw only on the GPU paths. Lines that cross a pitched camera's
  near plane now draw and pick their visible part instead of disappearing. The oracle
  `fill-pattern-pitch` and `line-pattern-pitch` scenarios are gated.
- Lines take MapLibre 6.16's `line-pattern` from the map style's `sprite` (#349).
  `tilesetLayers` accepts `line-pattern` on style-spec `line` layers (constant or data-driven,
  not zoom-dependent), and `GeoJsonLayer` styles gain `linePattern` (default `null`). The
  strips draw with a port of MapLibre's `line_pattern` program: the image spans the line's
  width, its height scaled to `line-width`, repeats along the line by the distance measured at
  the floored zoom (restarting at every tile, also for GeoJSON lines), samples one texel into
  the atlas padding, and cross-fades between neighbouring integer zooms like `fill-pattern`.
  A pattern replaces `line-color` and `line-dasharray` and keeps `line-opacity`; features
  whose image is missing draw nothing. Patterned GeoJSON lines draw on the retained WebGPU
  path; under a pitched camera and on the Canvas fallback they are left out for now, like
  patterned fills (#350). The MapLibre runtime batches patterned GeoJSON lines per image.
  The oracle `line-pattern` scenario is gated.
- Rotated and pitched cameras cover tiles with MapLibre 6.16's `coveringTiles` (#332): tiles
  are culled against the camera frustum, and above `maxConstantZoomPitch` (60°) far tiles
  come from lower zooms, so frame placements and requests hold mixed zooms. Cameras whose
  viewport reaches past the ground horizon (pitch above about 71.6°) are no longer rejected
  as unsupported; their visible bounds stop at MapLibre's Mercator horizon line. Oriented
  covers keep the north-up policy of filling at the source's minimum zoom. The MapLibre
  runtime now accepts the Maps camera's pitch range (`maxPitch` 85°). The oracle
  `steep-pitch` scenario (65°) is gated.
- With the horizon in view (#379), `flatRuntime="maps"` draws the band above it as MapLibre
  does: transparent for a style without `sky`, so the page behind the map shows, and the
  style's `sky-color`, `horizon-color` and `sky-horizon-blend` otherwise. The WebGPU surface
  is now premultiplied to allow it. A pan, wheel zoom or rotation at a pointer over the sky
  no longer holds a ground point: pans move the center by the pixel delta and zoom and
  rotation keep the center, as in MapLibre. A right-click over the sky opens no context
  menu. The oracle gates `steep-pitch-horizon` (75°, 85°) and `steep-pitch-sky`.
- Tileset `symbol` layers meet the map on point placement, ported from MapLibre 6.16 (#346).
  `text-rotation-alignment` and `icon-rotation-alignment: map`, `text-pitch-alignment` and
  `icon-pitch-alignment: map` work in any combination: symbols turn with the map (on the
  viewport or on the pitched map plane, with map-plane perspective sizes), and collision
  boxes turn and pitch with them, variable anchors included. Labels and icons at
  `symbol-placement: line` may leave their line with viewport rotation and map pitch, and
  `text-rotation-alignment: viewport-glyph` keeps each glyph level along its line. Icons
  under `icon-text-fit` with variable anchors must share their text's pitch plane. The
  oracle `symbol-alignment` and `symbol-alignment-pitch` scenarios are gated.
- Tileset `symbol` labels choose their anchor at placement, ported from MapLibre 6.16
  (#346). `text-variable-anchor` and `text-variable-anchor-offset` (constant lists, point
  placement) try each anchor in order, the anchor of the last placement first, then, with
  `text-allow-overlap`, again ignoring collisions; `text-radial-offset` applies to both
  variable and fixed anchors, and `text-justify: auto` keeps multi-line labels justified
  towards the chosen anchor. An icon under `icon-text-fit` moves with its text and must fit
  there too. The oracle `symbol-variable-anchors` and `symbol-variable-anchors-pitch`
  scenarios are gated.
- Tileset `symbol` icons follow lines, fit their text and turn, ported from MapLibre 6.16
  (#346). `icon-image` works on `symbol-placement: line` and `line-center`: icons along
  the line (`icon-rotation-alignment` `map`/`auto`) walk the projected line like glyphs, on
  the viewport or the pitched map plane (`icon-pitch-alignment`), with
  `icon-keep-upright` and `icon-offset`; icon-only lines get anchors; their collision boxes
  turn (and pitch) with the map. `icon-text-fit` (`width`, `height`, `both`) and
  `icon-text-fit-padding` stretch icons over their text through the sprite's `stretchX`,
  `stretchY`, `content`, `textFitWidth` and `textFitHeight` (validated as MapLibre's image
  manager does). `icon-rotate` and `text-rotate` turn quads and bound the turned collision
  boxes; rotated icons sample `LINEAR`. `text-translate`, `icon-translate` and their
  `*-translate-anchor` move anchors for placement and drawing (constant values only). The
  oracle `symbol-icon-lines` and `symbol-icon-lines-pitch` scenarios are gated.
- Tileset `symbol` layers follow the camera zoom and their lines, ported from MapLibre 6.15
  (#346). `text-size` and `icon-size` take camera and composite functions (interpolated
  at the drawn zoom between the tile's covering stops, camera sizes capped at the tile's
  layout size), and `text-*`/`icon-*` paint takes camera functions (evaluated each frame)
  and composite functions (blended between the tile zoom and one above). `symbol-placement:
  line` and `line-center` lay labels along lines: `symbol-spacing`, `text-max-angle`,
  merged same-name lines, glyphs walking the projected line each frame with
  `text-keep-upright` flips and `text-offset` along and off the line, on the viewport or
  the pitched map plane (`text-pitch-alignment`), colliding with circles along their path.
  Symbol placement now visits tiles in MapLibre's placement order, and symbols draw in
  its bearing order. Icons along lines are still rejected. The oracle `symbol-zoom`,
  `symbol-lines` and `symbol-lines-pitch` scenarios are gated.
- Tileset `symbol` layers draw icons from the map style's `sprite`, ported from MapLibre
  6.15 (#346): `icon-image` (expressions or `{token}` strings), `icon-size`, `icon-anchor`,
  `icon-offset`, `icon-padding`, `icon-allow-overlap`, `icon-ignore-placement`,
  `icon-optional` and `text-optional`, with `icon-opacity` and, for SDF sprite images,
  `icon-color` and `icon-halo-*`. Icons and text place jointly as in MapLibre's
  `placement.ts`, icons draw before their layer's text, and plain icons sample `NEAREST`
  unless they scale. Tiles lay their icons out once the sprite arrived. `icon-text-fit`,
  `icon-rotate`, `icon-translate` and zoom-dependent `icon-size` are still rejected. The
  oracle `symbol-icons` scenario is gated.
- `flatRuntime="maps"` draws relief from the map style, ported from MapLibre 6.15 (#324):
  `raster-dem` sources (`mapbox`, `terrarium` and `custom` encodings, two-pixel tile
  borders backfilled from loaded neighbours), `hillshade` layers (the prepare pass that
  stores each DEM pixel's slope, then the `standard`, `basic`, `combined`, `igor` and
  `multidirectional` shading with illumination direction, altitude and anchor,
  exaggeration and shadow, highlight and accent colors) and the style's `terrain`: the
  raster and hillshade layers render into a 1024² target per terrain tile, drawn on a
  128 × 128 mesh lifted by the terrain DEM (with skirts, depth tested, sampled
  trilinearly at full anisotropy), and the camera centers on the terrain elevation as
  MapLibre's `centerClampedToGround`. Relief tiles follow MapLibre's `coveringTiles` with
  terrain-aware bounds and level of detail, so each source loads the same tiles. Terrain
  fog (pitch ≥ 60°), the sky, draping tileset and application layers on terrain and
  picking on terrain are not ported yet (#352).
- Fills take MapLibre 6.15's `fill-pattern` from the map style's `sprite` (#323).
  `tilesetLayers` accepts style-spec `fill` layers (`fill-color`, `fill-opacity`,
  `fill-pattern`, `fill-antialias`, `fill-outline-color`), and `GeoJsonLayer` styles gain
  `polygonFillPattern`. On `flatRuntime="maps"` the style's `sprite` (`[@2x].json` and
  `.png`) loads into an image atlas ported from MapLibre's (potpack bins, one pixel of
  wrapped padding around patterns, premultiplied), which symbol icons can share. Patterns
  repeat on the tile pixel grid of the floored zoom, scale with the zoom fraction and
  cross-fade between neighbouring integer zooms for 300 ms after one is crossed, as
  MapLibre's `pattern_from`/`pattern_to`; fills draw MapLibre's `fill-antialias` outline,
  sampling the pattern unless `fill-outline-color` is set. Patterned GeoJSON fills draw on
  the retained WebGPU path; under a pitched camera and on the Canvas fallback their fill is
  left out for now. The MapLibre runtime batches patterned GeoJSON polygons per image.
  `line-pattern` is not supported yet.
- Lines take MapLibre 6.15's `line-cap` (butt, round, square), `line-join` (bevel,
  round, miter, with `line-miter-limit` and `line-round-limit`) and `line-dasharray`
  (#322). `GeoJsonLayer` styles gain `lineCap`, `lineJoin`, `lineMiterLimit`,
  `lineRoundLimit` and `lineDasharray` (defaults: round caps and joins, solid), and
  `tilesetLayers` accepts style-spec `line` layers. Maps ports MapLibre's line bucket
  for every cap and join (flipbevel and fakeround included, sharp-corner vertices,
  byte-quantized extrusion), its dash atlas (SDF dashes, round dash ends, dashes in line
  widths at the tile zoom) and the dash phase of each GeoJSON tile: a dashed GeoJSON
  line is cut into its geojson-vt tile pieces and clipped to each tile, as MapLibre
  measures and draws it. The MapLibre runtime batches dashed GeoJSON lines per dash
  array and cap, so their dashes keep a fractional period. Pitched cameras draw dashed
  GeoJSON lines on the Canvas path; the Canvas fallback uses its own dashes.
- `MapView` accepts `tilesetLayers` (`MapsTilesetLayers`) on `flatRuntime="maps"`:
  MapLibre style-spec `circle` and point-placement `symbol` layers drawn over the
  Tileset's vector source layers (#321). Maps ports MapLibre 6.15's glyph PBF
  loading (from the `glyphs` URL template), SDF glyph atlas, text shaping (line
  breaking, justification, `text-anchor`/`text-offset`, letter spacing), the
  `symbol_sdf` halo/gamma shader, pole-of-inaccessibility polygon labels and the
  collision grid, so the same labels hide. Filters and data-driven properties use
  the expression subset Maps evaluates; anything else (icons, line placement,
  variable anchors, zoom-dependent sizes and paint) is rejected through `onError`.
  The WebGPU backend draws them; the Canvas fallback does not yet.
- Exported `ensureMapsAggregationWasm()`, `getMapsAggregationRuntimeStatus()`,
  `subscribeMapsAggregationRuntime()` and the `MapsAggregationRuntimeStatus`
  type from the root and `core` entries. Consumers can await or observe the
  Rust/WASM aggregation runtime (`idle`, `loading`, `ready`, `unavailable`).
- `PointLayer` accepts `getPointLabel` to draw text centered on a point, as
  cluster layers draw their counts. On WebGPU, labeled points stay GPU-retained
  and camera frames project only the labeled points for the label pass.

### Patch Changes

- `HeatLayer` stable-raster density surfaces now redraw when the filter, weights, radius, intensity, color ramp or points change while the camera stays inside the cached coverage. Before, the previous surface stayed on screen until the camera left the coverage or crossed a zoom bucket. This affects both `flatRuntime="maps"` and MapLibre Map Views (#171).
- `flatRuntime="maps"` Map Views close the hover, tooltip, popup and context menu of a Map Feature that leaves the composition, report maxZoom corrections to controlled owners, and keep saved controllers inert after unmount.
- Maps runtime camera frames no longer go through React (#343). As in MapLibre,
  `setViewState` moves the camera and renders it on the next animation frame
  (a following `getViewState()` sees it at once), and an uncontrolled Map View
  fires `onViewStateChange` every camera frame but commits its view state to
  React (and `useMapSurfaceViewState` consumers) once the camera settles. The
  WASM runtime is built for speed (`opt-level = 3`, about 140 KB larger), and
  pitched stroke geometry no longer calls software `hypot`.
- On the MapLibre runtime, the lines of a layer group share one GeoJSON source
  and one line layer, and its polygons one source with a fill and an outline
  layer (#337). Per-feature colour, width and opacity are data-driven paint
  (`["get", ...]`). Restyles such as hover and selection go through
  feature-state, so they do not re-send the source data. Pointer events go to
  the topmost feature that listens. Before, every line or polygon had its own
  source and layers: `line-styles` had 307 of each, and MapLibre took 13.8 ms
  per moving-camera frame there. It now takes 0.7 ms.
- Polygons on the Maps WebGPU runtime draw MapLibre's `fill-antialias` outline: a
  one-pixel line in the fill colour over each ring edge, faded by MapLibre's
  `v_pos` distance. That interpolation is perspective-correct, so on a pitched
  camera the outline shows beside thin far strokes and fades out along near
  edges. Pitched polygon vertices also snap to MapLibre's GeoJSON tile grid,
  and the outline is clipped per GeoJSON tile as MapLibre clips it.
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
