# Performance

## Entrypoints

Prefer narrow entrypoints when possible:

- `@moritzbrantner/maps/core` for data-only helpers.
- `@moritzbrantner/maps/layers` for composed map layers.
- `@moritzbrantner/maps/flat` or `@moritzbrantner/maps/globe` for display-specific apps.

The release verification includes entry bundle budgets and a package consumer
smoke test.

## Heat And Scalar Fields

Field rendering uses inverse distance weighting over a fixed geographic domain.
Higher `fieldColumns` / `fieldRows` or smaller `fieldCellSizeMeters` values
increase quality and CPU/memory cost.

```tsx
<HeatFieldMap
  domainBounds={[-11, 35, 31, 62]}
  fieldColumns={320}
  fieldRows={220}
  fieldRenderMode="raster-contours"
  fieldValueDomain={[-10, 35]}
  points={stations}
  valueMetric="temperature"
/>;
```

`initializeMapsScalarFieldWasm(...)` can opt into the optional
`@moritzbrantner/viz-engine` runtime. If initialization fails, scalar field
creation falls back to TypeScript and `getMapsScalarFieldWasmLoadError()`
exposes the last load error.

## Temporal GeoJSON

Use `createTemporalGeoJsonPlaybackIndex(...)` when the same tracks are sampled
many times. This precomputes sampling and ring preparation so dense polygons and
multipolygons do not pay that setup cost every frame.

## Benchmarks

Run:

```sh
bun run verify:benchmarks
bun run bench:temporal-geojson
bun run bench:performance
```

`scripts/verify-entry-bundles.mjs` also reports bundle budget failures. Use the
bundle analysis script to inspect the largest emitted chunks.
