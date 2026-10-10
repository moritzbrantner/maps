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
