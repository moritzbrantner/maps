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

## Retained-point and retained-shape work contracts (#189)

The O(1) camera contract of #155 is also a deterministic gate. `.performance/contract.json`
(schemaVersion 2) declares `operations` in coding-tooling's shared vocabulary, and
`scripts/collect-work-evidence.sh` is the root `performance:work` capability that
`coding-tooling performance work` judges. The counters are owned by the resource:
`RetainedPointState` in `crates/maps-wasm/src/retained_points.rs` decides every
lowering, encode and upload of a retained point group and counts it in
`RetainedPointCounters`, and the wgpu backend only executes the uploads it returns.
`crates/maps-wasm/src/work_complexity.rs` drives that state with real `maps-core` camera
frames at 1k, 10k and 100k points. It mirrors the GPU instance buffer by executing the
returned uploads and checks a projection oracle before it records any work. Every visible
point must be drawn within 0.05 px of its `maps-core` projection, with its current paint.

| Operation | Bound |
| --- | --- |
| `retained-points-camera-pan`, `retained-points-camera-zoom-rotate-pitch` | No lowering, encoding, rebuilds or instance uploads; one 256-byte frame uniform per camera frame, constant in points |
| `retained-points-camera-deep-pan-rebase` | Three counted rebases for the fixed travel, constant in points; each rebase re-encodes the group (linear) |
| `retained-points-update-features` | Lowering, encoding, upload, write calls and call payload linear in changed points and constant in total points; no rebuilds and no unrelated instances written |
| `retained-points-replace-dataset` | Declared linear: one lowering, encode and upload of every point |
| `projected-points-camera-pan` | Comparison role: the screen-projected path projects, sends and uploads every point on every camera frame (linear) |
| `retained-polygons-camera-pan`, `retained-polygons-camera-zoom-rotate` | No geometry rebuilds or uploads; one frame uniform per camera frame, constant in shapes (100, 1k, 10k) |
| `retained-polygons-update-features` | Lowering, geometry upload, write calls and call payload linear in changed shapes and constant in total shapes; no rebuilds and no bytes written over unchanged shapes' geometry |
| `retained-polygons-replace-dataset` | Declared linear: one lowering, build and upload of every shape |

Retained shape groups follow the same pattern. `RetainedPolygonState` in
`crates/maps-wasm/src/retained_polygons.rs` decides every geometry build and write, and the
backend executes them. The tests mirror the four geometry buffers by executing the returned
uploads. Their oracle compares the draws over the mirror with a fresh build of the whole
group around the same anchor, byte for byte. A shape update builds only the changed shapes'
geometry around the current anchor. A shape whose geometry keeps its size is written in
place. Otherwise it moves into the free tail that every build reserves (a quarter of each
buffer's vertices). The group is repacked only when a tail is full or a shape's draw count
changes. Camera frames read cached counts of zoom-dependent and patterned shapes rather than
visiting every shape. Pitch is outside the shape camera contract: the runtime returns shape
groups to the projected path under a pitched camera. Groups with lines or patterns rebuild
once per floored-zoom change, as MapLibre's GeoJSON tiles do; the polygon contracts measure
polygon-only groups.

Without `MAPS_WORK_EVIDENCE_DIR`, plain `cargo test` asserts the same bounds as exact
formulas. A camera frame that re-encodes or re-uploads the points or shapes therefore fails
the normal Rust gate as well as `performance work`. On WebGPU, `updateRetainedPoints` and
`updateRetainedPolygons` carry a data or hover/selection change of some features of a group
to the renderer. The runtime compares the group's previous transport arrays with the new
ones and sends only the changed points or shapes; unchanged groups are not re-sent, and a
group that changes size or in more than half of its features is replaced. Line and flow
groups use the same update path but have no operation contracts of their own yet. The JS
side still rebuilds and compares the transport arrays of a changed frame, so JS-side
materialization is linear in the group size.

## Heat/scalar work counters (#171 phase 2)

TypeScript is still the computational authority for heat and scalar surfaces, so their
deterministic counters live in TypeScript (`src/heat-layer-work.ts`). Each count is kept
by the resource that decides the work:

- `HeatLayerDataWork` belongs to one mounted `HeatLayer` and travels on its descriptor. It
  counts the camera-independent artifacts: density source-index builds and their points,
  bounds queries and query-cache hits, and the scalar-field grid (interpolation cells),
  field image and contour builds. It also counts retained grids reused for a style-only
  change and superseded async field results.
- `HeatLayerSurfaceWork` belongs to one `MapsHeatLayerRenderState`. It counts the camera
  path: density plans, sources lowered into raster space, sources hashed into the cache
  key, rasterizations and their pixels, raster reuses, discarded async rasters, and raster
  images handed to the pixel backend (uploads) with their pixels.

`src/heat-layer-work.test.tsx` drives the production mount and render state together and
asserts these properties:

| Operation | Bound |
| --- | --- |
| 32 camera frames (pan and zoom within the rebuild bucket) inside a stable density raster, 500 points | No index queries, source lowering, signature hashing, rasterization or upload; one raster reuse per frame |
| Camera leaves the stable coverage | One plan, rasterization and upload; lowers only the sources inside the new coverage |
| Density style change (color ramp) / opacity / data | Ramp: one rasterization, no index rebuild. Opacity: no rasterization. Data: one index rebuild and one rasterization |
| Viewport-raster (pixel radius) camera frames | Declared camera-dependent: one rasterization per moved frame |
| 32 camera frames over a scalar field (raster and contours) | No grid, image, contour or upload work |
| Scalar-field color ramp / contour levels / data | Ramp: one image and one upload only. Levels: one contour build only. Data: one grid, image and contour build |
| Async scalar field, style-only change | Reuses the retained grid |

Before this phase, the fix for stale stable-raster reuse (#401) checked raster reuse by
re-planning on every camera frame. For 32 frames at 500 points it lowered and hashed
16,000 sources while rasterizing nothing. The Maps render state now records which
descriptor produced the committed raster. A frame with that descriptor and a camera inside
the raster's zoom bucket and coverage reuses the raster without querying or planning.
Every planning input lives on the descriptor, and the mount publishes a new descriptor
whenever an input changes. The retained-vs-uncached oracle
(`src/heat-surface-retained-oracle.test.ts`) still covers the reuse and invalidation steps.

These are work counts, not frame-time evidence. They are not yet part of the root
`performance:work` contract, which collects Cargo evidence only. No WASM bridge is involved
while TypeScript is the authority, so bridge bytes are reported as not applicable rather
than zero. The full-map frame distribution, stalls, memory and async latency are measured by
the journey below.

## Heat/scalar full-map journey (#171 phase 5)

`heat-scalar-journey-v1` mounts the canonical kernel workloads in one public
`flatRuntime="maps"` Map View (`e2e/fixtures/heat-scalar-journey.tsx`): the
`heat-map-density-index-v1` density (10,000 demand-weighted points, default meter radius,
stable raster, async) and the `scalar-field-grid-v1` field (320 × 200 cells, K = 10,
power 2, async), clipped by a polygon mask with a hole and traced into contours, next to a
GeoJSON polygon and a Point Layer. Both use the same generators
(`e2e/fixtures/heat-scalar-workloads.ts`). A control lane mounts the same Map View without
the Heat Layers, so the camera phases of the two lanes differ only by the heat surfaces.
The capture path is described in
[engine-evidence.md](engine-evidence.md#heatscalar-journey-evidence-171):

```sh
RUNTIME_PROFILER_BIN=/path/to/runtime-profiler bun run verify:engine-heat-scalar-evidence
```

The surface work counters gained `rasterDraws`, `rasterDrawTriangles` (the clipped affine
triangles those draws submit to Canvas) and `rasterImagesDecoded`. The journey reads them
through `observeHeatLayerWork()`, an evidence-only registry that retains nothing unless a
page installs it. `e2e/maps-heat-scalar-journey.spec.ts` asserts the same invalidation
contract on every browser run.

Two captures at `fa172da91bacb2a00321f4a9955f4afb76e7665c` (clean tree), WASM SHA-256
`30ce7958b07d0710c2d146ecb51f67d240981def1399ae2a2fa9c6598b75ab1b`, runtime-profiler
`6d2c92e`, Chromium headless shell 158.0.8127.18, Playwright 1.65.0, Node 24.16.0, Ryzen 7
5700X, Linux x64. The pinned collector launches Chromium without WebGPU, so both lanes ran
the Canvas fallback with software rasterization. Frame intervals are `requestAnimationFrame`
intervals; long tasks come from the in-page observer. Values are capture A / capture B.

| Phase | Control frame p95 / max (ms) | Heat frame p95 / max (ms) | Heat long tasks (count, total) | Heat work |
| --- | --- | --- | --- | --- |
| Pan (drag, 20 steps) | 16.7 / 16.8 | 16.7 / 16.8 | 0 | 96 raster draws, 10,070 / 9,890 triangles; no rasterization or upload |
| Wheel zoom (3 steps) | 16.8 / 16.8 | 49.9 / 50.0, 33.4 / 50.1 | 0 | 8 density rasterizations, 7 superseded and discarded, 1 upload |
| Bearing 35° + pitch 40° (120 frames) | 83.3 / 83.4 | 216.6 / 216.7 | 119, 18.1 s / 17.9 s (longest 216 ms) | 245 draws, 258,488 / 264,866 triangles, 1 rasterization |
| Resize 1024 × 640 and back | 16.8 / 16.8 | 16.7 / 16.8 | 0 | 8 draws, 986 triangles; nothing rebuilt |
| 6 density seeks | — | 16.7 / 33.4, 16.8 / 33.4 | 0 | 6 index builds (42,507 points) and rasterizations; no field work |
| 6 field refreshes | — | 33.4 / 66.6, 16.8 / 33.4 | 0 | 6 grids (64,000 cells each), images and contours; no density points re-indexed |
| 4 color ramp changes | — | 16.8 / 33.4 | 0 | 4 field images from the retained grid (4 grid reuses), 4 density rasterizations |
| Superseded bursts | — | 33.4 / 50.0, 16.8 / 50.0 | 0 | 5 superseded density rasters discarded; only the last commits |

No camera phase rebuilt a density index, scalar-field grid, field image or contour set.

- **Input → presented surface** (18 awaited commits: until the new raster is decoded, plus
  one animation frame): p50 98.2 / 83.2 ms, p95 181.7 / 165.5 ms. Density seeks 65 to
  111 ms, field refreshes 80 to 130 ms, ramp changes of both layers 115 to 182 ms. The latency
  includes the deliberate async deferral, React commits, image decoding and frame waits.
- **Page load to both surfaces presented:** 293 / 277 ms (control lane: 156 / 122 ms to a
  ready Map View). No long task in either lane.
- **JS heap after forced GC:** heat lane 9.2 MB ready, 13.1 MB after the journey, 6.4 to
  6.5 MB across three unmounts and 10.5 MB after remount. Control lane 4.7 MB ready and 5.3 to
  5.4 MB unmounted. Unmounting releases the journey's retained surfaces. GPU, WASM linear and
  total browser memory are unavailable.

**Measured bottleneck: geographic rasters under pitch.** Canvas maps an image only affinely,
so a raster under a pitched camera is drawn as clipped affine triangles split until they
follow the projection within 0.5 px (#171 phase 3). Pitched frames drew about 2,100 triangles
for two rasters, which added about 80 ms per frame over the control lane (heat p50 133 ms
against 67 ms). A CPU profile of that phase attributes it to Canvas work (`drawImage`, clip,
`save`/`restore` and native rasterization) and to per-vertex WASM projection; no heat/scalar
computation runs in it. An experiment with a 2 px error limit cut the triangles by 70 % but
the added long-task time only from 10.3 s to 5.8 s, still far over the frame budget, at the
cost of the 0.5 px alignment; it was not adopted.

**Changed here:** `drawCanvasGeographicRaster` now splits only the axis whose edges bend.
Unpitched field frames are latitude-linear only along rows, so their columns stay whole: the
pan phase draws 10,070 triangles instead of 19,976 and the resize phase 986 instead of 1,946,
at the same 0.5 px limit (`src/canvas-geographic-raster.test.ts`; the phase 3 alignment
spec passes on both backends). Pitched frames are bent along both axes and barely change
(258,488 against 275,380 triangles).

**Not Fast yet.** Unpitched navigation, resize and every data and style change stay within
the frame budget with no long task. Pitched navigation over heat surfaces does not, and the
control lane shows that pitched Canvas frames exceed it on this backend even without heat.
No reference implementation or parent revision runs this journey, so the comparison is
unavailable and this evidence is descriptive, not a Fast verdict.

**Conditional Rust authority (phase 4): not justified.** The audit found these
computations in TypeScript: the density source index (weights, filter, normalization), surface
lowering and rasterization, the scalar IDW grid with mask clipping, the field image and contour
tracing. In the representative journey none of them produced a long task: each data change
re-indexed up to 10,000 points or re-interpolated 64,000 cells inside the frame budget. The
only measured bottleneck is pixel submission in the Canvas overlay, which a Rust kernel would
not move. TypeScript therefore stays the computational authority (owner decision of
2026-11-08: measurement-first, no speculative kernels).

Observed, not investigated: the first mount builds the 10,000-point density index twice (three
data work sets for two Heat Layers at load); remounts build it once.
A field refresh also rebuilds the field layer's own empty density index.

## Heat/scalar GPU presentation (#171)

Owner decision 2026-11-11 approves presentation of existing heat/scalar rasters on the existing
wgpu backend, retaining Canvas. The application painter-order stream now includes textured
meshes: one draw per raster, with unchanged TypeScript computational authority. Initial module
loading no longer causes a discarded extra density-index build.

Captured on `32e5be889ee6fd9abc04168429f7236d497767a1` plus this PR's runtime changes:
WASM SHA-256 `ea78ead17e99abfd50aa24e0ef4651cc48597f8ac32e96228fdc6ace0ab2c239`
(1,668,623 bytes), runtime-profiler `fd26af06b649d319fdd9c1cf14fce63f1abaa324`, Node
24.16.0, Playwright 1.62.1 and Chromium 151.0.7922.34 on Linux x64. The scenario's explicit
flags select SwiftShader **software WebGPU** with CPU Canvas rasterization. The capture ran
alongside verification jobs; these are contended descriptive timings, not a controlled
performance comparison or a hardware Fast result.

| Phase | Control rAF p95 | Heat rAF p50 / p95 | Heat worst interval | Heat long tasks |
| --- | ---: | ---: | ---: | ---: |
| Pan | 16.7 ms | 16.7 / 33.4 ms | 33.4 ms | 0 |
| Zoom | 133.4 ms | 16.7 / 133.3 ms | 350 ms | 1 (87 ms) |
| Bearing/pitch | 66.7 ms | 66.7 / 233.3 ms | 333.4 ms | 100 (12,270 ms total) |
| Resize | 16.7 ms | 16.7 / 50 ms | 116.6 ms | 0 |

- Initial work: exactly two mounted layers, one nonempty density index (10,000 points),
  one 64,000-cell field, two texture uploads / 2,303,920 RGBA bytes.
- Camera/resize rebuild no index, grid, field image or contours. Pan/resize upload no texture.
  Zoom and orientation each replace one density texture as their raster inputs require.
  Six density seeks replace six textures; six field changes replace six field textures.
  Four ramp changes replace eight textures and retain the field grid.
- Every phase submits zero Canvas raster triangles; textures are retained per image and
  released on replacement, removal and disposal. Meshes still cross the object bridge per frame;
  numeric mesh bytes and serialized-object overhead are not separately measured.
- Input-to-presented surface over 18 awaited changes: p50 244.2 ms, p95/worst 1,015.3 ms.
- JS heap after GC: 9.45 MB ready, 13.26 MB after interaction, 6.47–6.61 MB across three
  unmounts and 10.64 MB after remount. GPU, WASM-linear and total browser memory and GPU
  completion time remain unavailable.

The prior Canvas capture has different runtime inputs. No improvement is claimed from these
numbers. Comparison/Moonlight remain unavailable and #171 stays open pending the Fast evidence.
The owning correctness/retention and browser alignment checks pass independently of timing.

Immutable bundle manifest SHA-256:
`17c159185b9e1d27759c92b525c7d9300266a6a76a997107b514863c7fb32c87`.
Local capture: `.runtime-profiler/maps-171-gpu-1/`; reproduce with
`RUNTIME_PROFILER_BIN=/path/to/current/runtime-profiler bun run verify:engine-heat-scalar-evidence`
in an idle environment (output directories are immutable).

## Moving features on a Map-Scoped Timeline (#172 phase E)

### Work counters

Each prepared moving-track playback index keeps one `TemporalPlaybackWork` set
(`src/temporal-work.ts`), on both the Rust/WASM and the TypeScript reference path: track
preparations (and those by Rust), prepared tracks and keyframes, samples, sampled tracks,
emitted features, changed features (admitted, removed or moved since the index's previous
sample) and bridge bytes into and out of the Rust sampler. Aggregation index maintenance,
static-layer writes, uploads and repaints belong to the Map View runtime and are counted by the
browser runtime counters (`e2e/helpers/mixed-layer-work.ts`).

`src/temporal-work.test.tsx` drives the shared temporal map state (`useTemporalMapState`) with a
real Map-Scoped Timeline and asserts:

| Operation | Bound |
| --- | --- |
| Mount, Rust runtime idle → loading → unavailable | One preparation and one sample (the authority never changed) |
| 5 seeks | 5 samples over every track, no preparation |
| Same time again, pause, unrelated commit | Nothing sampled or prepared |
| 30 playback frames | One sample per advanced time, no preparation; only moving tracks are changed features |
| Seek across an admission and back | Admitted and removed tracks count as changed features |
| Remount on a shared clock | One preparation and one sample, at the kept time |
| Source replacement | One preparation and one sample |
| Rust runtime installed | One Rust preparation; keyframes cross once (32 bytes each plus 4 per track); each sample returns 48 bytes per track |

**Found and fixed.**

- Tracks were re-prepared (and re-sampled, and the aggregation index rebuilt) on every
  temporal runtime *status* change, because the playback index was keyed on the runtime
  version. Without the compiled module a mount prepared three times instead of once; in the
  browser, idle → loading added one full TypeScript preparation of every track before Rust
  took over. The index is now keyed on the installed runtime.
- A map remounted on a shared clock first sampled the clock's placeholder time (`0`, reported
  while no consumer has registered a range) and then the kept time: two samples and two
  aggregation index rebuilds per remount, the first at a time the map never shows. Nothing is
  sampled until the clock has a range.
- That fix made the first frame of a remount an empty point set, which crashed the Rust
  aggregation index (`supercluster` panics on an empty load; the release WASM traps). An empty
  point set now builds an empty index (`crates/maps-core/tests/point_aggregation.rs`). Any
  clustered Map Layer on `flatRuntime="maps"` with no points hit the same trap before.

### Full-map playback journey

`temporal-playback-journey-v1` mounts the public `TemporalClusteredMap` on
`flatRuntime="maps"` with 2,000 moving tracks of 24 keyframes over 48 static GeoJSON regions,
driven by one shared Map-Scoped Timeline and the public timeline controls
([scenario](engine-scenarios.md#temporal-playback-journey-v1),
[evidence contract](engine-evidence.md#temporal-playback-journey-evidence-172)):

```sh
RUNTIME_PROFILER_BIN=/path/to/runtime-profiler bun run verify:engine-temporal-evidence
```

Two captures at `11f30390` (clean tree), WASM SHA-256
`fa2e032207266fa816ea12571435cdff3066bdcd91dfb075eaf9c35b41e6bc18`, runtime-profiler
`6d2c92e`, Chromium headless shell 158.0.8127.18, Playwright 1.65.0, Node 24.16.0, Ryzen 7
5700X, Linux x64. The pinned collector launches Chromium without WebGPU, so the Canvas fallback
ran. Both captures gave identical work counts and frame distributions within 0.1 ms.

| Phase | Frame p50 / p95 / max (ms) | Long tasks | Temporal work | Map View work |
| --- | --- | --- | --- | --- |
| Idle, 60 paused frames | 16.7 / 16.8 / 16.8 | 0 | none | none |
| Playback, 180 frames | 16.7 / 16.7–16.8 / 16.8 | 0 | 179 samples (2,000 tracks each), 0 preparations, 322,200 changed features, 17.2 MB out of WASM | 179 aggregation index rebuilds and 179 repaints; no static-region write or tile upload |
| 8 awaited seeks | 16.7 / 16.7 / 16.8 | 0 | 8 samples, 0 preparations | 8 rebuilds and repaints |
| Scrub, 40 slider moves | 16.7 / 16.7–16.8 / 16.8 | 0 | 39 samples, 0 preparations | 39 rebuilds and repaints |
| Pan, paused | 16.7 / 16.7 / 16.7–16.8 | 0 | none | 55 frame plans, 42 aggregation queries, no rebuild |
| Pan, playing | 16.7 / 16.7–16.8 / 16.8 | 0 | 36 samples, 0 preparations | 36 rebuilds, 79 queries, 48 frame plans |
| 3 source replacements | 16.7 / 16.7 / 16.7–16.8 | 0 | 3 Rust preparations (48,000 keyframes, 1.5 MB into WASM each), 3 samples | 3 rebuilds |
| 20 unrelated commits | 16.7 / 16.7 / 16.7–16.8 | 0 | none | 1 frame plan and repaint |
| 3 remounts | 16.7 / 16.7 / 16.7 | 0 | 3 Rust preparations, 3 samples | runtime rebuilt per remount; 2 aggregation indexes each (the empty first frame, then the tracks) |

- **Rust sampling crossings:** 267–268 measured `temporal-sample` crossings, 90.5–90.7 ms in
  total, longest 0.6 ms: about 0.34 ms per sample of 2,000 tracks.
- **Input → presented** (8 seeks, 3 source replacements): p50 30.0 ms, p95 30.3 ms (the
  sample, the repaint on the next frame, plus one frame). Slow input events (Event Timing,
  ≥ 16 ms) during scrubbing and panning: 24 and 20 entries, each 24–32 ms.
- **Load:** 238 / 190 ms to a presented Map View with Rust sampling; two preparations (the
  TypeScript reference, then Rust once ready); one 61 ms long task in capture A, none in B.
- **JS heap after forced GC:** 12.8 MB ready, 14.2 MB after the journey, 13.3 MB across three
  unmounts (the page keeps both track sources), 14.0 MB remounted. GPU, WASM linear and total
  browser memory are unavailable.

Every time change rebuilds the Rust aggregation index over all emitted points: clustering
depends on every position, so this is the declared required work, not an incremental
promise. Camera frames and unrelated commits neither prepare nor sample, and no phase rewrote
the static regions or re-uploaded tiles.

**Not a Fast verdict.** Every phase stayed inside the frame budget with no long task at 2,000
tracks on the Canvas fallback. No reference implementation or parent revision runs this
journey, so the comparison is unavailable; WebGPU timing and larger track counts are not
measured.

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
the repaired fixtures. Validation uses the pinned Bun 1.4.3, wasm-bindgen 0.2.128,
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

## Package acceptance repair — 2026-10-26

The package gate at `e8eace88a03baff2e43c42f8ce367e8aaef02bfa` exceeded all
three aggregate size limits. With the same runtime features, exports and package
contents, identifier minification with preserved function/class names and the
Binaryen `merge-similar-functions` pass produce:

| Artifact boundary | Before | After | Unchanged limit |
| --- | ---: | ---: | ---: |
| npm compressed package | 455,498 bytes | 445,314 bytes | 446,000 bytes |
| npm unpacked package | 1,790,144 bytes | 1,534,263 bytes | 1,752,500 bytes |
| WebGPU-enabled Maps WASM | 633,382 bytes | 624,781 bytes | 625,500 bytes |

These are local package-size observations, not runtime-performance or Fast
acceptance. The build still includes the complete public entrypoints, declarations,
fallback styles and WebGPU runtime. Its 59 WASM exports are unchanged. The CSS is
regenerated with the already-pinned Tailwind 4.3.3 rather than the stale 4.3.0
generated output; no stylesheet source or dependency version changed.

The measurements used Rust 1.99.0, wasm-bindgen 0.2.129, Binaryen 132, tsup 8.5.1,
Bun 1.4.3 and npm 12.2.0 on Linux x64. A single post-link run on the same Rust
input took 22.70 seconds for the previous `-O1` command and 10.19 seconds with
the additional merge pass. These uncontrolled samples do not establish a build-time
speedup. `-Oz` was rejected: it reduced raw WASM to 597,417 bytes but increased
its gzip size and failed the complete compressed-package gate.

Packed-consumer checks follow Timeline Editor's established Git-source install
contract: the optional source peer's exact UI and editor-core prerequisites are
listed and trusted directly. This handles Bun's skipped transitive Git preparation
without adding a new Maps peer or weakening optional-peer coverage. The shared
npm pack parser accepts both npm 10's array and npm 12's package-keyed envelope.
The broader representative Fast acceptance in #169 remains open.

The packed-WASM verifier uses Supercluster 8.0.1 only in its disposable reference
fixture. It cannot use an uninitialized `createPointAggregationIndex()` as a
clustering oracle: the approved #47 no-WASM/SSR contract intentionally returns
unclustered points. The reference adapter is outside all package entries and
retains the canonical, seeded, metric, expansion, leaf and large-index checks;
it does not restore a JavaScript production clustering authority.
