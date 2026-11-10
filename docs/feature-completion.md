# Maps Feature Completion Protocol

The first-party Maps program uses one completion rule for product/runtime features:

> **Developed → Correct → Fast**

A feature is not complete merely because an implementation exists. It is complete only after all three gates have passed on the same authoritative path.

## Gates

### 1. Developed

The feature has a coherent, usable implementation on the intended Maps-owned runtime path.

- It is integrated through the owning map-domain contracts rather than a parallel demo-only implementation.
- Authority boundaries are explicit: Rust owns map-domain results; browser backends own pixels/picking; React owns composition/lifecycle.
- Required fallback behavior is explicit and fail-closed.
- The implementation has an observable end-to-end path, not only scaffolding or isolated helpers.

### 2. Correct

The developed feature is proven before optimization work changes its shape.

- Deterministic unit/integration coverage protects map-domain invariants.
- Browser evidence covers user-visible rendering and interaction where applicable.
- MapLibre/Leaflet reference parity is used only where their behavior is the compatibility target.
- Edge cases that affect semantics are covered, including invalid geometry, world wrapping, holes/order, picking identity, fallback/recovery, and controlled interaction state where relevant.
- Exact-head required checks are green.

A feature with unresolved semantic correctness is **not eligible for Fast work** except diagnostic instrumentation needed to identify the defect.

### 3. Fast

Optimization starts from a correct implementation and is driven by representative evidence.

- Reuse canonical Maps scenarios; do not create a microbenchmark that cannot represent the user path.
- Measure the costs the architecture can move: main-thread work, frame-time distribution, bridge crossings/bytes, allocation, GPU upload, draw submission, memory, and picking latency where supported.
- Remove unnecessary work before adding complexity: retain stable data, separate invalidation domains, batch crossings, reuse buffers/resources, cull invisible work, and avoid React in per-frame engine paths.
- Use 2d-lab for renderer experiments/evidence when useful, then graduate proven techniques into a Maps-owned implementation.
- A data-volume or operation-count reduction is useful evidence but is not, by itself, an FPS or end-to-end performance claim.
- Missing or incomparable runtime evidence is inconclusive, not Fast.

If a performance change breaks correctness, the feature returns to the Correct gate.

## Program sequencing

Work vertically by feature or coherent subsystem:

```text
Develop feature
    ↓
prove correctness
    ↓
profile representative path
    ↓
optimize measured bottlenecks
    ↓
prove correctness again
    ↓
record Fast evidence
    ↓
complete
```

Do not accumulate many half-finished features and postpone correctness/performance to a final cleanup phase. Conversely, do not spend repeated optimization cycles on one already-usable feature while a required neighboring feature is still absent unless evidence shows that feature is the dominant blocker for the Maps experience.

## Core v1 completion boundary

The first-party engine is **v1 complete** when Milestones B through E are complete under this protocol:

- B — independent camera, interaction, raster source/tile runtime;
- C — first-party rendering for the Leaflet-class application feature set;
- D — practical vector-tile/style engine;
- E — credible labels/symbol cartography.

Milestone F remains an advanced program. Terrain, globe, native/offline, extrusion and similar work must not hide unfinished B-E foundations.

MapLibre remains a reference/fallback at explicit edges until the replacement responsibility has passed Developed, Correct and Fast. Once a replacement is proven, converge by deleting the superseded production authority rather than keeping two engines indefinitely.

## Current completion matrix

This is a planning snapshot, not a substitute for issue/PR evidence. Update a row only when the owning issue or merged evidence changes.

| Capability | Developed | Correct | Fast | Current direction |
| --- | --- | --- | --- | --- |
| Geographic camera, project/unproject, fit/interaction | Yes | Yes | In progress | Keep Rust authoritative; profile the full camera presentation path, not camera math in isolation. |
| Raster tile/source lifecycle and first-party base map | Yes | Yes | In progress | Retain GPU resources, prove churn/overzoom/world-copy/memory behavior, then retire superseded paths. |
| Points and clusters | Yes | Yes | In progress | Circle instancing landed in #153; finish packed/retained application transport under #154/#60 with representative density evidence. Labeled points are GPU-retained like the others; camera frames project only the labeled points, for the Canvas label pass (#204). Deterministic work contracts (#189, `performance:work`) hold camera pan/zoom/bearing/pitch at 1k/10k/100k points to zero point encoding and upload, and in-place updates to work linear in the changed points only. Cluster layers still use the projected path. |
| Lines and flows | Yes | Yes (#195: retained WebGPU lines and flows match the Canvas oracle) | In progress | Lines, flow direction markers and flow endpoints are GPU-retained in shape groups (#195). Frames with labeled points stay retained too (#204), and the MapLibre/Leaflet comparison is #197. |
| GeoJSON polygon fills/strokes and holes | Yes | Yes (#161: WebGPU matches the Canvas oracle) | In progress | Polygons are GPU-retained (#196): Rust lowers rings once and camera frames upload nothing. Frames that mix polygons, lines and points keep them retained as point and shape groups in one painter order (#195). Deterministic work contracts (#189, `performance:work`) hold camera pan and zoom/bearing at 100/1k/10k polygons to zero geometry rebuilds and uploads, in-place shape updates (`updateRetainedPolygons`) to work linear in the changed shapes only, and dataset replacement to declared linear work. |
| Picking, hover and selection | Yes | Yes | In progress | Preserve Maps feature/primitive identity; optimize misses/broad phase only from representative pointer evidence. The mixed-layer journey (#170, `mixed-layer-journey-v1`) now records pointer → Map UI latency, and a hover change repaints only the application overlay. No comparison is available yet. Historical selection validity (#170 phase D): selection, hover and popup clear in the render the Map-Scoped Timeline leaves a feature's period, with browser evidence on the Maps runtime (`e2e/maps-historical-selection.spec.ts`); no Fast evidence recorded for it. |
| Heat/scalar surfaces | Existing product capability | Partial (#171: deterministic density/scalar fixtures and retained-vs-uncached differential oracles; scalar-field polygon masks with holes clip the raster, contours and samples at grid-cell resolution, with mask boundary/hole fixtures and a masked-field oracle; browser alignment evidence is pending) | Needs first-party performance pass | The oracle found and fixed stale stable-raster reuse after filter/weight/radius/style/data changes. The masked-field oracle found and fixed async field reuse after the mask was replaced. Next: work/invalidation counters, browser alignment evidence, then Fast evidence (#171). |
| Measurement and GeoJSON editing | Existing product capability | Existing correctness coverage | Needs first-party integration audit | Preserve editor/measurement authority while removing accidental dependency on legacy rendering responsibilities. |
| MVT/vector source lifecycle | Partial | Partial | Not yet | Finish the production source/cache contract and polygon geometry path before performance promotion. Opt-in raw-tile persistence (#264 phase 1) is developed with correctness coverage; its Fast evidence is not measured yet. |
| Style-spec-compatible vector layers/expressions | Not complete | Not complete | Not started | Develop background/fill/line/circle/raster + filters/expressions, then parity, then bucket/render optimization. |
| Labels, icons and collision placement | Not complete | Not complete | Not started | Develop the cartography model first; correctness includes shaping/collision/stability; optimize only afterward. |
| MapLibre responsibility retirement | Partial | Evidence-gated | Evidence-gated | Remove each responsibility only after its first-party replacement passes all three gates. |

## Near-term order

1. Finish the **Fast** gate for dense points/clusters without broadening semantics.
2. Take **polygons** through Developed → Correct → Fast on WebGPU, using the existing Canvas even-odd/hole behavior as the correctness oracle and 2d-lab retained/chunk/culling work as experiment input.
3. Finish lines/flows and heat/scalar performance on the same retained/batched renderer foundation.
4. Complete vector-source/style features one vertical layer family at a time: develop, parity-test, then optimize.
5. Complete labels/symbols the same way.
6. Retire MapLibre responsibilities immediately after their replacements pass all three gates; do not defer convergence indefinitely.

### Versioned Maps Tilesets (#268)

The public source contract and source-aware runtime have focused Rust/TypeScript
and Chromium coverage, including both renderers, warm data/style reuse,
revision changes, reversed responses, camera/application selection and bounded
eviction. The existing canonical interaction artifact now includes dense-fixture
source lifecycle observations. Executed gates and measurements are recorded in
the owning PR; an unavailable historical source-switch comparison remains
unavailable and is not a comparative performance pass. This scoped work does not
complete the general vector-style/cartography milestones.

Executed at `f034eedf9a8ef39a84cf4ab5e4b048bb9a274ea9` (shared convention
source revision `c104800c7aaeaea12d56f9093e71bdef6a2ce6fa`):

- Rust/WASM gate passed; the source contract has five native integration tests.
- `verify:agent` passed 64 files / 579 tests. Chromium smoke passed 70/70 on the
  fresh isolated candidate; the later metadata-only refactor passed its 14
  focused tests, typecheck and all eight affected browser cases.
- The existing five-sample canonical interaction command stayed on WebGPU. Cold
  A used one network request, two Rust decodes and one bucket build; after loading
  B, five A revisits and five resolved-paint changes added **zero** requests,
  decodes or bucket builds. A revision bump added one request, two decodes and one
  bucket build. Warm A switch-to-ready latency was 17.9 ms median (17.3–22.1 ms).
- Retaining A/B recorded 2,231,552 RGBA/MVT lower-bound bytes and 6,790,480 actual
  GPU geometry-buffer bytes; retaining revision 2 increased these to 3,347,328
  and 10,185,720 bytes. These exclude decoded JS object overhead, driver memory,
  other GPU allocations and total browser memory. The privacy-coarsened reported
  JS heap was 10 MB and cannot establish precise growth.
- The canonical interaction frame interval p95 was 16.8 ms in this descriptive
  software-GPU run. It is not GPU-completion FPS, a controlled historical
  comparison or a Moonlight verdict. The parent source-switch comparison remains
  unavailable. Capture SHA-256:
  `4562ad2b871d98886c15304ae18a7e96f05fa54f740c94a6b1c6117dcb8d3585`.
- Six SHA/byte-verified real MVT samples from the owning asset-tooling producer
  passed both current Rust/WASM geographic and pixel decoders, including the
  expected two water holes. Production ODbL bytes remain outside Maps Git.
- Full package validation passed API, unit/integration, build, entry bundles and
  clean packed consumers, then **failed the unchanged size gate**: compressed
  package 466,311 > 446,000 bytes; WASM 678,690 > 625,500 bytes. Unpacked
  1,600,239 < 1,752,500 bytes, 75 < 84 entries and both stylesheet budgets passed.
  The equivalent main baseline was 442,200 compressed / 1,525,127 unpacked /
  624,781 WASM bytes. This feature is not declared complete while required size
  acceptance remains unresolved.

The `f034eed` capture and producer decoder proof above are historical, scoped
observations. They predate the following correctness repair and are not new-head
performance claims; the decoder and shared data-field contract did not change.

Follow-up executable repair `4b8eda5eca95196fafba56b4ea61f998544ece36`:

- Same-identity XYZ URL/credential refresh now clears Rust pending/failed work,
  aborts old browser loads and reissues missing tiles without evicting ready
  decoded data or GPU buckets. Metadata/date-only and style-only updates do not
  restart the network. Non-cooperative old responses cannot overwrite or remove
  replacement work.
- Canvas now applies the resolved building-outline opacity, matching WebGPU at
  opacity 0, 0.5 and 1 without fetching, decoding or rebuilding buckets.
- The native regression first failed with no replacement request; both public
  URL-refresh regressions first failed (no new request / old HTTP 401 remained).
  The Canvas outline regression first showed opaque black instead of the
  underlying `[196, 216, 180]` color at opacity zero. These cases then passed.
- Required Rust/WASM and agent gates passed (64 files / 579 tests), as did all
  six native source tests, fourteen public source browser cases, the complete
  76-test Chromium smoke suite, and `format:check`. The two formatting failures
  observed in the earlier PR CI were repaired in the same change.
- Full package validation again passed API, tests, build, entry bundles and clean
  packed consumers, then failed only the unchanged size ceilings: **466,500 >
  446,000 compressed bytes; 678,727 > 625,500 WASM bytes**. Unpacked 1,600,423 <
  1,752,500 bytes, 75 < 84 entries, and both stylesheet limits passed.
  Candidate growth over the same main baseline is 24,300 compressed, 75,296
  unpacked and 53,946 WASM bytes. WASM SHA-256:
  `2440c4b5e2cc8bb8992adb364e2961c21eb48e9b2bf34dfc475cb600e8945971`.
  The existing #268.Q1 decision remains open; no ceiling was changed and the
  feature is not declared complete or mergeable.

### Opt-in raw-tile persistence (#264)

Phase 1 of #264 (owner-approved split): `tilePersistence` keeps raw MVT bytes in
Cache Storage behind the first-party tileset reader. The contract is in
[Maps Tilesets](maps-tilesets.md#opt-in-tile-persistence-264).

- **Developed.** The public Map View opts in; the Maps engine page keeps Atlas
  tiles and shows status with a **Clear downloaded tiles** action
  ([control screenshot](evidence/tile-persistence-control.png), captured from a
  local Pages build on a revisit of the Liechtenstein Atlas). Rust remains the
  only scheduler and source-identity authority; no Rust code changed.
- **Correct.** `src/maps-tile-persistence.test.ts` (16 tests) covers the freshness
  policy, canonical keys, later-session reuse with byte identity, revisions,
  cancelled/rejected bytes, `no-store`, 304 revalidation, expiry without a
  reachable server, LRU eviction, unavailable/denied storage, refused quota,
  truncated and undecodable entries, concurrent reads, clearing and orphan
  removal. `e2e/maps-tile-persistence.spec.ts` (13 Chromium cases, both renderers
  for cold/reload/style) drives the real Map View against the committed MVT and
  PMTiles fixtures: opt-in default, cold then reload with zero tile requests and
  identical pixels and bytes, style change, unreachable host with stored versus
  uncached tiles, clear, source/revision/URL-refresh keys, ETag revalidation,
  `no-store`, expired-and-unreachable, malformed network bytes, corrupt stored
  bytes, a late response for an abandoned source, world copies/overzoom, denied
  storage, refused quota and eviction. `e2e-hosted/atlas-pages.spec.ts` adds an
  Atlas revisit and clear on the Pages build. Concurrent requests for one tile and
  truncated entries are covered by the unit tests only. Executed results are
  recorded in the owning PR.
- **Fast.** Not started. No HTTP-only versus persistent comparison has been
  measured, so no benefit over browser HTTP caching is claimed. The profiler
  scenarios and measured network/startup/storage evidence are phase 2 and keep
  #264 open.

### Mixed-layer Map View composition (#170)

`mixed-layer-journey-v1` profiles the public `flatRuntime="maps"` acceptance composition:
raster base, clusters, flow, polygon, points and anchored Map UI. See
[the evidence contract](engine-evidence.md#mixed-layer-journey-evidence-170). This is
Fast *evidence*, not a Fast pass: no reference or parent revision runs the journey, so
comparison and Moonlight are unavailable. The PRD stays open for phase D.

Executed at `3aed78df2c2ab63625871798a73d000683779328` plus this change. WASM SHA-256 was
`9e742de90aeb7a5f859ede2fe500b3d726c61b070cbed708282aef31849421a8`. The run used Chromium
headless shell 158.0.8127.18, Playwright 1.65.0, Node 24.19.0 and the pinned
runtime-profiler at `6d2c92e`, on Linux x64 (AMD Ryzen 7 5700X, WSL2).

- **Invalidation counts.** The Chromium test passed 3/3 repeats on WebGPU and Canvas:
  - An idle page and five unrelated React commits did zero work.
  - Each hover change was exactly one overlay repaint: one WebGPU frame, or one Canvas
    clear. It made no frame plan, projection, aggregation, base redraw, retained write
    or upload.
  - A camera-only change made one projection batch (9 coordinates) and one aggregation
    query, with zero retained writes, evictions or released resources.

  Before the fixture's layer inputs were made identity-stable, each unrelated commit cost
  one overlay repaint and re-projected one to two coordinates. The inline `getFeatureId`
  callbacks and a fresh points array caused it. Map Layers re-prepare inputs whose
  identity changes, by design.
- **Journey profile (Canvas fallback; the pinned collector has no WebGPU flags).**

  | Phase | Work | rAF interval p95 | Long tasks |
  | --- | --- | ---: | ---: |
  | Camera | 94 frame plans, 35 projection batches (297 coordinates), 35 aggregation queries, 92 base and 35 overlay redraws | 16.8 ms | 0 |
  | Hover | 11 overlay redraws, nothing else | 16.7 ms | 0 |
  | Select | 9 overlay redraws, nothing else | 16.8 ms | 0 |
  | Unrelated commits (20) | none | 16.8 ms | 0 |
  | Teardown (3 cycles) | 3 runtimes and 3 aggregation indexes released, then rebuilt on remount | 50 ms | 0 |

  - **Pointer → interaction latency (9 picks):** median 16.1 ms, maximum 20.1 ms.
  - **Trace:** the profiler recorded 7 long tasks (949 ms total, longest 487 ms). They
    fall outside the journey phases: page load and the forced GCs for heap sampling.
  - **Measured crossings (≥ 100 µs):** frame plan 107 (25.7 ms total), aggregation query
    22 (4.5 ms) and projection batch 9 (0.9 ms).
  - **JS heap after GC:** 46.6 MB when ready and 47.5 MB after interaction. Across three
    unmounts it stayed at 47.4 to 47.5 MB, and it was 47.6 MB after remount.
  - **Unavailable:** GPU, WASM linear and total browser memory, and GPU completion time.

  Bundle manifest SHA-256:
  `8de3ff5b5312acf80a1a0835019ed06b82d45d818d9b7301c8adf0cd77367fa4`.


### Content-pinned Atlas tileset on Pages (#270)

**Developed** and **Correct** were delivered earlier: #362 published the pinned
Liechtenstein archives with source selection, attribution and fail-closed coverage on
the first-party Pages Map View, #371 fixed the zoom-out overflow, and
`e2e-hosted/atlas-pages.spec.ts` covers them on the hosted build.

**Fast** now has its matched evidence path,
[`maps-atlas-tileset-v1`](engine-evidence.md#atlas-tileset-journey-evidence-270):
MapLibre GL 6.16 + `pmtiles` 4.5 against the first-party Map View over the same
archives, interleaved, evaluated by Moonlight with the owner-approved viability policy
(≥ 5 samples, complete candidate execution, runtime score ≥ 75). Every Pages deploy
build runs it and publishes the outcome at `/maps/evidence/atlas-tileset-runtime.json`.
**The Fast gate counts as measured only from such a published deploy-build run. Until
one exists it is unavailable, not passed.**

One local capture exists so far. It is advisory and is not that run. Executed at
`2ca24c67519b50247ff38b96905c0e03bb2c72aa` (clean tree), WASM SHA-256
`3ab3375046534cab14a2e5b4dc9c2875814a4e2287b3ec0aa539bcede83bb2c6`, Chromium headless
shell 158.0.8127.18, Playwright 1.65.0, Node 24.19.0, runtime-profiler `6d2c92e` and
Moonlight `b580327`, on Linux x64 (WSL2). Ten measured journeys per side over two
rounds:

- **Moonlight:** passed both rounds with runtime score 99 and 99; browser bundles
  `comparable`. The score rates driver-process wall time (median 2,653 ms reference,
  2,543 ms candidate in round 1) and driver RSS (median 106,956 KiB reference,
  109,752 KiB candidate). The wall time includes Chromium launch and the RSS excludes
  Chromium, so the score cannot rank the renderers.
- **Journey medians (reference → candidate):** first useful map 612 → 361 ms; warm
  revisit 136 → 24 ms; source A → B ready 234 → 101 ms; source B → A ready
  200 → **440 ms**.
- **Transfer:** the candidate made 89 range requests for 1,750,372 bytes, the reference
  57 for 1,517,785 bytes. Every response was HTTP 206. Neither side re-read the archive
  on the warm revisit; the candidate's return to source A made no request and reused
  76 retained resources.
- **Renderer main thread (one trace each):** candidate 1,214 ms of top-level tasks
  with one 371 ms long task; reference 318 ms and no long task. MapLibre decodes in
  workers, the candidate on the main thread.
- **Candidate work and memory:** 85 Rust decodes; 85 retained tiles, 91,640,111
  RGBA + MVT lower-bound bytes. The backend was Canvas2D, so there are no GPU buffers.
- **Unavailable:** browser heap and GPU memory (#76), Rust decode and bucket-build
  timings, frame time during camera motion, and the WebGPU backend.

The slower return to source A, the larger transfer and the main-thread long task are
observations to act on, not regressions against an earlier Maps revision. `evaluation.json`
SHA-256 of this capture:
`9120ee97c1a9995e0f421b59309fbfb647f760385a3aa74cb15e96969e776a9a`.
