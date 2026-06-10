# Performance

## Entrypoints

Prefer narrow entrypoints when possible:

- `@moritzbrantner/maps/core` for data-only helpers.
- `@moritzbrantner/maps/layers` for composed map layers.
- `@moritzbrantner/maps/flat` for flat-only wrapper imports.

Use `mapDisplay="globe"` on the standard map components when you need native
MapLibre globe projection.

The release verification includes entry bundle budgets, package/CSS budgets,
and a package consumer smoke test.

```sh
bun run verify:package-size
bun run analyze:bundles
```

JS entry budgets live in `scripts/verify-entry-bundles.mjs`. Package-level
compressed size, unpacked size, entry count, and stylesheet budgets live in
`scripts/verify-package-size.mjs`.

`scripts/analyze-bundles.mjs` stores hash-insensitive bundle baselines. Entry
files are keyed as `entry:<fileName>`, while emitted chunks are keyed by sorted
entrypoint owner group and size rank, such as
`chunk:core+flat+root#1`. This keeps deltas useful even when tsup changes hashed
chunk filenames.

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
/>
```

`initializeMapsScalarFieldWasm(...)` can opt into the engine-backed scalar-field
path provided by the required `@moritzbrantner/viz-engine/core` entrypoint. If
initialization fails, scalar field creation falls back to TypeScript and
`getMapsScalarFieldWasmLoadError()` exposes the last load error.

`@moritzbrantner/viz-engine@0.3.0` also exposes a lazy WASM entrypoint, but maps
keeps the scalar-field initialization path synchronous for now. Lazy loading
requires a separate maps-level API design because the current helper returns a
ready-to-use runtime state.

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

`scripts/verify-entry-bundles.mjs` reports JS entry budget failures. Use the
bundle analysis script to inspect the largest emitted chunks, entrypoint owners,
and deltas from `bundle-baseline.json`.

```sh
bun run analyze:bundles
node scripts/analyze-bundles.mjs --update-baseline
```

Benchmark verification writes `benchmark-results/maps-benchmark-summary.json`
and compares p95 values to `benchmark-baseline.json` when present. Each
benchmark has a warning threshold and a hard failure budget. Warnings keep CI
green by default; set `MAPS_BENCHMARK_WARN_AS_ERROR=1` to make warning
thresholds fail locally or in stricter scheduled jobs.

## Stylesheet Size

The default `@moritzbrantner/maps/styles.css` includes package map styles and
MapLibre GL CSS without Tailwind preflight/global reset. Use
`@moritzbrantner/maps/styles.full.css` only when an app needs compatibility with
the legacy reset-inclusive stylesheet.
