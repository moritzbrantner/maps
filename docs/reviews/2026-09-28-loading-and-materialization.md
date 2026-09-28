# Loading and materialization audit

Baseline: `c93ada2de836e0d2a92b52f665b2281549575f93` (initially clean working tree).
Shared conventions sourceRevision: `e6acb5310afaf15c0cba24f87108f5f4ad1bedc3`.

The review traced WASM loading, raster request ownership, aggregation transport,
retained layer preparation, scalar fields, and editor history. The changes below
remove demonstrated redundant work without changing map-domain authority or
public APIs. This is a targeted audit, not proof that every allocation is necessary.

## Changes and evidence

| Path | Previous work | Change | Regression evidence |
| --- | --- | --- | --- |
| `src/aggregation-wasm.ts` and runtime loaders | Each loader invoked initialization independently; scalar fields and geometry kernels also had separate dynamic-import boundaries. | Retain one initialization promise per resolved package specifier, share pending and successful loads, and evict failures for retry. All six runtime consumers use this boundary. | `aggregation-wasm.test.ts` exercises actual dynamic imports in Bun: three concurrent initializer calls plus a fourth on the next tile become one. Also covers package isolation, scalar/kernel sharing, and shared failure followed by retry. |
| `src/heat-layer.tsx`, `src/maps-heat-layer-mount.tsx` | Field mode eagerly normalized, filtered, weighted, and materialized density GeoJSON that the field renderer did not consume. | Prepare the density source only with data in density modes; field mode retains an empty index and uses its scalar grid/sample path. | `maps-native-retention.test.tsx` checks both mounting paths with 1,000 points: zero density-weight calls in field mode, one per point after switching to interpolated mode, and zero after switching back. |
| `src/scalar-field.ts` | Range calculation filtered/copied grid values, then spread the entire array into two function calls. | Scan values once with constant auxiliary storage, preserving explicit domains and the source-value fallback for all-null grids. | `scalar-field.test.ts` reproduces a stack overflow for a 512×512 field before the change and succeeds afterward. Existing interpolation tests remain green. |

Successful module initialization remains cached for the process lifetime, matching
ES module lifetime. Runtime instances, GPU resources, and aggregation indexes are
still created and disposed independently. Different package specifiers remain
independent; failed initialization is not permanently cached.

## Existing ownership retained

- Raster loading already tracks in-flight requests by tile key and checks request
  identity after decode. Removing these guards or indiscriminately sharing loads
  would weaken cancellation and stale-result handling.
- Native point and flow preparation already separates source/style invalidation
  from camera/interaction changes. Existing retention tests protect this behavior.
- Editor undo/redo copies publicly mutable history entries. Structural sharing
  would require an explicit immutability contract; this audit does not change that
  behavior.
- WASM transport and published frame copies can provide ownership isolation. The
  loader change does not remove or borrow buffers across those boundaries.

## Measurement limits

`bun run bench:scalar-field` uses 67 points, three warmups, and 12 measured runs
per size. Local grid mean times in milliseconds were:

| Cells | Before | After |
| --- | ---: | ---: |
| 240×150 | 32.54 | 33.62 |
| 320×200 | 61.46 | 56.54 |
| 420×260 | 97.97 | 94.45 |

These local timings are mixed and are not an end-to-end speedup or a Fast-gate
claim. The deterministic evidence is the eliminated initialization/preparation
work, constant auxiliary storage for range calculation, and removal of the
large-grid failure. The benchmark's optional WASM scalar runtime was unavailable.

Environment: Linux, Bun 1.4.2, Node 24.16.0, repository Rust toolchain 1.98.1.
The installed Bun differs from the package's declared 1.3.14, so this is local
verification rather than a claim of exact CI environment reproduction.

Verification of this loading/materialization change, before the subsequent engine
projection and Pages work: `bun run verify:agent` passed 497 tests across 55 files, including
TypeScript, scenario validation, and static checks. Existing lint warnings and
jsdom canvas diagnostics remain. `bun run verify:rust`, `bun run build:wasm`,
`bun run build:js`, and all 30 Chromium browser smoke tests passed.
The combined engine/Pages verification and its remaining browser failure are
recorded in `docs/engine-performance.md`.

`bun run verify:entry-bundles` remains failing on a pre-existing shared-chunk size
budget. An isolated archive of the starting commit, built with the same installed
dependencies, produced 227,108 bytes; the candidate produces 227,050 bytes against
the existing 222,600-byte limit. No other entry-bundle errors remain after building
the WASM artifacts. The budget was not changed.

The initial browser attempt lacked Leaflet and the built `/wasm/` assets. Local
prerequisites were prepared with the frozen lockfile install, `build:wasm`, and
the existing CI copy from `dist/wasm` into ignored `public/wasm`; snapshots and
tracked dependency files were unchanged.
