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
unpacked size, entry count, and stylesheet budgets live in
`scripts/verify-package-size.mjs`. The compressed package and Maps WASM runtime
sizes are measured and reported there but are not blocking ceilings (#268);
reducing them belongs to the loading strategy.

### WASM capability modules (#305)

One `bun run build:wasm` emits two modules from the `maps-wasm` crate with the
same speed-first release profile (#343):

| Module | Export | Contents | Used by |
| --- | --- | --- | --- |
| `maps_wasm_core` | `@moritzbrantner/maps/wasm/core` | flat runtime and camera planning, aggregation, temporal tracks, Shortbread/MVT decode, Tileset QA kernels | Canvas2D Map Views (no WebGPU), data-only loaders, Tileset QA |
| `maps_wasm` | `@moritzbrantner/maps/wasm` | every core export plus the WebGPU base renderer (`wgpu-base-map`) | WebGPU Map Views |

Every runtime loader goes through `importMapsWasmModule(capability, …)`. Only
the WebGPU base renderer asks for `renderer`; it is not fetched at all when
`navigator.gpu` is missing. A `flatRuntime="maps"` Map View in a WebGPU browser
declares the renderer module before any loader starts, so the flat runtime,
clustering and the other core loaders share that one module and the page never
fetches both. A core loader that starts after the renderer module also reuses
it. A string module URL (`configureMapsWasmPackage(url)` or a loader's
`wasmPackage`) keeps naming one full module for every loader.

Measured on `cbe2188` (`bun run build:package`, gzip -9):

| First Map View transfer | Before | After |
| --- | ---: | ---: |
| Canvas2D or data-only: WASM | 1,657,910 B (627,906 gzip) | 876,066 B (329,229 gzip), −47.6% gzip |
| Canvas2D or data-only: wasm-bindgen glue | 140,682 B (20,524 gzip) | 54,168 B (7,936 gzip) |
| WebGPU: WASM | 1,657,910 B (627,906 gzip) | unchanged, byte-identical |

The npm package carries both modules, so its compressed size grows; browser
transfer, not the tarball, is what this split reduces. `verify:package-size`
reports both runtime sizes.

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

`initializeMapsScalarFieldWasm(...)` now targets the first-party
`@moritzbrantner/maps/wasm` boundary. A Maps WASM build that exposes scalar-field
computation can become the fast path without introducing a second visualization
authority. Until that export is available, initialization fails closed and scalar
field creation continues through the deterministic TypeScript implementation;
`getMapsScalarFieldWasmLoadError()` exposes the load/capability error. This
boundary is computation-only: browser renderers consume Maps-owned map-domain
outputs rather than becoming a second source of geographic truth.

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
