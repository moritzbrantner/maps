# Rust/WASM engine performance and Pages

The standalone map is at `/maps/engine/`. It mounts the Maps-owned runtime directly,
without the library showcase, reference-engine selector, or reference map instance.
The existing Canvas fallback remains available when WebGPU is unavailable. The
standalone Shortbread basemap now uses Rust-decoded tile-local paths painted once
in a worker, then retained by the existing tile-image renderer. This fixed-style
pixel cache does not complete the retained GPU vector/style work in #167.

`/maps/stats/` consumes `evidence/engine-benchmark.json` through the shared
GitHub Pages template's `project-evidence-v1` boundary. Every Pages build produces
new measurements from its built WASM artifact. The JSON contains source revision,
artifact and scenario hashes, environment, raw samples, and workload details.
Dirty local builds have no authoritative evidence revision. Missing evidence stays
unavailable; measurements have no pass/fail performance verdict.

## Projection workload

Run `bun run bench:engine` after building WASM, which also refreshes the browser assets:

```sh
bun run build:wasm
bun run bench:engine
```

The harness uses the seed, point count, viewport, and camera journey from
`engine-scenarios/dense-points-100k-v1.json`. It measures the render-preparation
projection phase in Chromium using the actual `MapsFlatRasterRuntime.projectPacked`
WASM export: 100,000 coordinates, five camera positions, three warmup journeys,
and fifteen measured journeys. Each sample is the mean batch time across that
journey. The reported p95 is the p95 of those journey means.

Flat cameras and cameras with 35° bearing / 40° pitch are reported separately.
Measurements include the packed JS/WASM input and output transfer. They exclude
startup, tile requests, GPU uploads, drawing, and picking, so they do not establish
FPS or overall interaction latency. The harness serves only local inputs and fails
if the WASM module or meaningful projection output is unavailable.

For a Pages build, use `--output public/evidence/engine-benchmark.json` before
Vite builds the site. The checked-in Pages workflow performs these steps and uses
the existing shared template for `/stats/` and `/evidence/`.

## Batch preparation optimization

Tracked in #169. Previously each packed coordinate called the scalar runtime
projection method, which revalidated the camera and reconstructed its local
projection state. Oriented validation also intersected four viewport rays with
the map plane for every coordinate.

The Rust runtime now validates once per batch and reuses a prepared local frame.
`MapLocalRenderFrame` retains the view/projection matrix produced by the existing
3d-lab foundation. The batch iterator streams results into the existing packed
output; it adds no intermediate result vector or JS geographic implementation.
Invalid coordinates still produce individual NaN pairs. Odd packed lengths are
rejected, and subsequent camera changes create fresh preparation.

Local before/after measurements on the same machine and harness:

| Projection, 100k coordinates | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Flat | 12.12 ms | 11.34 ms | 12.96 ms | 12.36 ms |
| Bearing/pitch | 372.04 ms | 23.46 ms | 394.96 ms | 23.96 ms |

The oriented projection median was approximately 15.9× faster in this run. This
is descriptive evidence for this phase, not a Moonlight acceptance decision or a
claim that the map as a whole is 15.9× faster. Runtime-profiler and Moonlight retain
ownership of capture/comparability and architectural performance acceptance.

The starting source revision was `c93ada2de836e0d2a92b52f665b2281549575f93`.
The local run used Chromium 151.0.7922.34 on Linux x64, AMD Ryzen 7 5700X,
Node 24.16.0, and Rust 1.98.1. Baseline WASM SHA-256:
`e7f1a3ad07ba55a308cbc8b299a847953f46be5214915425017e005b146dfcc1`;
candidate WASM SHA-256:
`2e6dcb1bc6176ba1dfa981e438608c86ce27a7bb276a16847eba924cac27430f`.
Shared convention sourceRevision:
`e6acb5310afaf15c0cba24f87108f5f4ad1bedc3`.
Rust tests cover scalar/batch equality across wrapping, invalid inputs, resize,
and camera changes; browser coverage checks the packed transport and both Pages
routes. Canonical camera parity, Rust verification, and the agent gate also apply.

The local Rust and camera-parity checks passed, as did the 497-test agent gate
and all four built-Pages checks. The full browser smoke run passed 31 of 32 tests:
the reference showcase's Globe interaction test stayed on Clusters after its
initial tab click. Its retained trace showed a completed click without a view
change; three isolated diagnostic runs passed without code changes. The full
smoke result remains failed, and this intermittent failure is not resolved by
those diagnostic passes. Both new engine smoke tests passed in the full run.


## Full-page interaction repair

The projection numbers above missed a severe user-visible bottleneck. A recording
of the standalone page with 1,000 points showed multi-second pauses and disappearing
basemap coverage. Replaying a 288px drag at 1700×1312 against the deployed
`2f0fdc69756b4c6ed45ebccfe3aec3c3cdb8d990` page reproduced a 2,616.5ms p95
animation-frame interval, a 4,316.5ms maximum, and 11 long tasks totaling 16,294ms.
Removing only the basemap reduced intervals to approximately 16.7ms with no long
tasks. CPU sampling attributed the dominant work to coordinate preparation,
allocation/GC, and Canvas strokes/fills. The overlay's transformed viewport-only
image could also expose blank areas while movement deferred a fresh render.

The standalone page now prepares fixed-style Shortbread tile images:

- The existing Rust decoder classifies features and groups exterior/interior
  rings once. Its tile-pixel output avoids geographic conversion and subsequent
  camera re-projection for static basemap geometry.
- One worker per Map View decodes and paints one tile at a time on OffscreenCanvas.
  Only ImageBitmaps return to the browser host. Pending cancellations discard
  queued bytes; orphaned results close their bitmap; disposal terminates the worker.
- The existing Rust source runtime owns tile requests, cancellation, cache eviction,
  overzoom and camera placement. The existing Canvas/wgpu base renderer draws the
  retained images. Basemap geometry no longer enters the application overlay scene.
- The source requests a Rust-enforced 128-tile cache and four concurrent loads.
  At 512×512 RGBA this bounds decoded pixels to 128 MiB, plus GPU copies when active.
  Worker geometry is temporary and there is no second decoded-tile cache.
- The reference showcase's geographic Shortbread path remains a comparison edge.
  This does not introduce a second style evaluator or general GPU polygon pipeline.

Tile pixels preserve the shared palette, paint order, and even-odd holes. The
fixed 512px image covers a 256px tile: fractional zoom and pitch resample pixels,
and stroke widths scale with the tile. This is a fixed-style basemap backend,
not a claim of resolution-independent vector cartography or symbol support.

The original warm-tile drag replay after the repair produced 16.7ms p95,
16.8ms maximum and zero long tasks. Replay elapsed time (including its one-second
settle interval) fell from 20.93s to 1.83s. The local tile payload cache held the
same actual Shortbread responses; external network latency was excluded.

`bun run bench:engine:interaction` runs the built standalone page against the
committed `vector-city-style-v1` fixture: forest/water/island polygons, 128 streets
with 256 vertices each per tile, 1,000 application points, one warmup and five
pan/zoom journeys at the recording's viewport. It measures real browser
requestAnimationFrame intervals and PerformanceObserver long tasks, not GPU
completion. No public tile server is involved. Pages runs it after the site build
and publishes the samples at `/maps/evidence/engine-interaction.json` and the
measurements on `/maps/stats/`, separately from the projection microbenchmark.

Local comparison with the same harness and fixture, using the immutable deployed
Pages artifact for the baseline:

| Five warm pan/zoom journeys | Before | After |
| --- | ---: | ---: |
| Median frame interval | 16.7 ms | 16.7 ms |
| p95 frame interval | 16.8 ms | 16.8 ms |
| Longest frame interval | 433.3 ms | 16.8 ms |
| Long tasks (>50 ms) | 10 | 0 |
| Total time in long tasks | 4,496 ms | 0 ms |

The unchanged p95 illustrates why median/p95 alone were insufficient: isolated
long stalls matter. Both runs used Chromium 151.0.7922.34, Linux x64, Ryzen 7 5700X,
Node 24.16.0, the harness's software-GPU flags and the Canvas fallback. These are
descriptive local measurements, not hardware-GPU FPS or a Moonlight Fast verdict.
Browser coverage also checks malformed tiles, cancellation/disposal, exact hole
colors, warm tile reuse, direct hosted navigation, and worker/WASM base-path loading.

The earlier smoke path disabled the external basemap, so it could not catch this
failure. The new dense-tile fixture exercises the complete basemap path without
network variability, and the hosted checks explicitly load it through the built
worker. Keep the interaction measurements alongside the projection microbenchmark;
neither a fast projection loop nor an empty basemap establishes responsive panning.

For this repair, Rust verification, canonical camera parity, the 497-test agent
gate, all 34 browser smoke tests, three focused worker tests and all four built-Pages
checks passed. The worker is explicitly included in TypeScript checking. The final
local interaction run measured 16.7ms p95, 16.8ms maximum and zero long tasks.
The shared convention sourceRevision remains the one recorded above.

Full package validation is not green: `verify:fast` failed the unchanged editor
test “moves all selected features together” (496 tests passed); a later diagnostic
pass does not resolve that failure. A separate entry-bundle check reports 227,692
bytes against the existing 222,600-byte limit, which was already exceeded by the
deployed baseline. The limit has not been raised. These outstanding checks and
the absence of a Moonlight comparison prevent a claim of complete Fast acceptance.

## Directional tile prefetch

The scheduler already fetched a symmetric one-tile ring. The next change, based
on `289765e6aea4a355207a1510ec3e7a9372c58973`, redistributes that existing budget
toward recent camera travel. Rust derives a direction from geographic center
movement at unchanged zoom, bearing, pitch and viewport. A displacement of at
least one CSS pixel updates the hint; jumps larger than the viewport's longest
side reset it. Non-pan camera changes reset it too. Predictions reach at most
two tile columns/rows ahead and use canonical wrapped XYZ identities.

The current viewport always has first priority. Remaining candidates are ordered
around the predicted center, and the request cover is capped at the smaller of
the original ring's size and the existing cache limit. Concurrency and decoded
cache limits are unchanged. Obsolete requests are cancelled on turns/reversals;
late completions cannot populate the cache. Unchanged-camera frames retain the
finite hint without extrapolating farther, so idle loading settles.

This trades some trailing/side coverage for earlier leading-edge readiness; it
cannot guarantee a prediction will be used or reduce total network bytes on every
journey. It adds no zoom-level speculation, clock/velocity API, duplicate tile
cache, or browser-owned geographic calculation. Existing raster and retained
Shortbread sources consume the same scheduler decisions.

The `raster-tile-churn-v1` lifecycle checks and real browser fixture prove tiles
outside the old ring are requested before visibility and reused after travel.
The full-map interaction benchmark remains the responsiveness check on `/stats`;
request-readiness assertions are not an FPS or network-latency improvement claim.
Shared conventions resolved to sourceRevision
`e6acb5310afaf15c0cba24f87108f5f4ad1bedc3` for this change.

Local validation passed Rust verification, canonical camera parity, the 497-test
agent gate, all 35 browser smoke tests and four built-Pages checks. The full-map
benchmark retained 16.7ms p95, 16.8ms maximum and zero long tasks across five warm
journeys on the same local Chromium/Canvas environment described above. The new
early-request browser assertion fails against the baseline WASM and passes with
the candidate. `verify:fast` passed all 497 tests (including the earlier failing
editor case) and the package build, then failed the unchanged 227,692-byte entry
bundle against the 222,600-byte budget. That outstanding gate remains visible;
the editor's earlier failure has not been diagnosed or claimed fixed.

## Dense-point journey lanes (#197)

`bun run bench:point-journey` (`scripts/benchmark-point-journey.mjs`) runs the
deterministic dense-point camera journey of the retained-point acceptance spec
(#155; cameras and points in `e2e/fixtures/dense-point-journey.ts`, shared by
both) on four lanes of the comparative interaction page, without basemap tiles:
the Maps retained path on WebGPU (`maps-wgpu`) and on its Canvas2D fallback
(`maps-canvas2d`), MapLibre (in-memory GeoJSON source and circle layer) and
Leaflet (circle markers on its Canvas renderer). 10,000 points take 40 camera
steps and 100,000 points take 12, which pan, zoom, rotate and pitch. Leaflet has no bearing or
pitch, so its lane follows centre and zoom only. Each lane runs one untimed warm
journey and then a timed one, per repeat, in a fresh browser context.

Per step it records `present` (camera command until the next
animation-frame callback, after the engine's synchronous draw) and `settled`
(until every point for that camera is drawn). MapLibre cuts GeoJSON tiles for a
new zoom in workers, so it settles after it presents; the other lanes draw every
point in the camera frame. The script fails when a lane draws no point pixels
in a screenshot of its 1024×768 map, when it does not end on the journey's last
camera on every axis it claims (centre and zoom, plus bearing and pitch except
for Leaflet), or when the WebGPU lane does not hold the points retained. It
never fails on timings. Pages runs it once per build and publishes
`/maps/evidence/point-journey.json` (`project-evidence-v1`, producer
`maps-point-journey`) on `/maps/stats/`. A failed run leaves that source
unavailable and does not block the deploy.

A local run with three repeats of the production-built fixture (exact 100k-point
spread) gave these medians (ms). The Maps lanes need `bun run build:wasm` first. Environment: Chromium
SwiftShader software GPU, Linux x64, Ryzen 7 5700X, a machine shared with other
builds. The numbers are descriptive and not a verdict:

| Lane | Points | Present p50 | Present p95 | Settled p50 | Settled p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Maps WebGPU (retained) | 10,000 | 230.0 | 323.2 | 230.0 | 323.2 |
| Maps Canvas2D fallback | 10,000 | 27.7 | 84.4 | 27.7 | 84.4 |
| MapLibre circle layer | 10,000 | 23.3 | 52.2 | 29.5 | 645.8 |
| Leaflet Canvas markers | 10,000 | 16.7 | 31.0 | 16.7 | 31.0 |
| Maps WebGPU (retained) | 100,000 | 1,339.7 | 2,105.7 | 1,339.7 | 2,105.7 |
| Maps Canvas2D fallback | 100,000 | 225.4 | 412.7 | 225.4 | 412.7 |
| MapLibre circle layer | 100,000 | 43.4 | 104.0 | 81.6 | 725.4 |
| Leaflet Canvas markers | 100,000 | 150.8 | 201.2 | 150.8 | 201.2 |

On both WebGPU journeys the retained counters stayed flat: zero point
preparations, rebases and upload bytes across the journey (the script now fails otherwise). The O(1)
work contract of #155 holds against the same workload the other lanes draw.
SwiftShader rasterizes the WebGPU instances on the CPU, so the WebGPU lane is
the slowest here. Those times measure the software rasterizer, not retained
work, and they say nothing about hardware-GPU presentation. `--gpu` switches
to hardware-GPU flags for a local comparison on a real adapter.

## Evidence tooling repair — September 30

The build now copies its optimized WASM and matching glue to `public/wasm`, so
local browser evidence consumes the same artifact as the package. Vite scans the
browser fixture entry points before serving acceptance pages. A cold dependency
scan previously discovered Leaflet during the journey, allowing a reload to
detach elements while assertions were running.

The runtime acceptance page uses the existing deterministic comparison fixture.
Its unrelated live comparison previously prepared about 89,000 primitives while
the runtime assertions were waiting. The kinetic test advances browser time
between input events and after release, including a separate coalesced-drag frame,
so it observes continued inertia before allowing the journey to settle. Editor
tests wait for the observable editing mode as well as runtime readiness; runtime
readiness alone precedes registration of the editor's interaction capabilities.

Syntax minification reduces the largest shared JavaScript chunk from 227,692 to
218,704 bytes against the unchanged 222,600-byte limit. API and packed-consumer
checks pass. The 497-test agent gate and all 35 Chromium smoke tests pass with
the repaired fixtures. Validation uses the pinned Bun 1.3.14, wasm-bindgen 0.2.128,
Rust 1.98.1 and Binaryen 132.0.0; convention sourceRevision is recorded above.

Full package validation still fails: compressed package 398,222 bytes exceeds
384,000; unpacked package 1,606,230 exceeds 1,566,000; WASM 519,947 exceeds 488,000.
Those limits remain intact. This repairs part of #168; native execution of the
renderer helper tests, broader shader validation, and package-size convergence
remain open. No complete Fast verdict follows from these repairs.

#187 later raised the package budgets to the values measured on main `1740615`: WASM
532,422 bytes (budget 534,000), compressed package 403,498 (405,500), unpacked
1,622,346 (1,626,000). This was the owner's decision. The per-PR WASM attribution is in
`scripts/verify-package-size.mjs`; the largest step is #151's tile prefetch (+25,560 bytes).
