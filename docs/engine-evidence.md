# Maps engine evidence contract

Maps uses shared tooling instead of growing a private performance/evaluation platform.

## Ownership

- **Maps** owns canonical scenario identity, deterministic fixtures, map-domain observations and reference adapters.
- **coding-tooling** discovers/invokes repository-declared deterministic scenario capabilities.
- **runtime-profiler** captures, validates and summarizes immutable runtime evidence. It owns profiler-specific bundle formats and strict comparability.
- **Moonlight** owns baseline/candidate comparison policy and verdicts.
- **reusable-workflows** may transport/reuse exact build and evidence artifacts; it does not reinterpret evidence.

Maps CI and Pages consume the same source-addressed Linux runtime-profiler binary
from the upstream `Publish Score History` run using
`scripts/install-runtime-profiler-ci.sh`. The publisher has already built and
smoke-tested these bytes; the consumer downloads the public, source-pinned
release asset **without a workflow token**, installs it, and checks `--version`
and `detect`.
The Pages flow still fetches that exact upstream source commit because it uses
the profiler's score-history helper script; it no longer rebuilds the CLI.
The source/run pin is only advanced deliberately when adopting a new profiler,
not by a recurring checksum-refresh job. The producer's Actions artifact also
retains a 90-day receipt; the separately published release asset is the durable
consumer endpoint.

## Required flow

```text
immutable reference identity + immutable candidate identity
                 |
                 +--> Maps semantic scenario observations
                 |
                 +--> runtime-profiler evidence bundles
                                |
                                v
                             Moonlight
                                |
                                v
                    pass / fail / inconclusive / error
```

A Maps PR may still use focused unit/browser checks, but architectural performance claims must be backed by named canonical scenarios when the required profiler capability exists.

## Semantic observation contract

`docs/contracts/maps-engine-observation-v1.schema.json` defines the versioned Maps-owned semantic envelope. The implementation identity is evidence provenance; the remaining normalized fields are the semantic comparison surface.

The first executable path is `camera-world-pan-v1`:

```text
engine-scenarios/camera-world-pan-v1.json
              |
              +--> maps-core executor --> native CLI
              |                     |
              |                     +--> maps-wasm --> browser candidate
              |
              +--> MapLibre public-API reference adapter
                                     |
                                     v
                     maps.engine-observation/v1 parity
```

`maps-core` is the only candidate semantic implementation. The CLI and WASM functions are transports over the same executor. The MapLibre adapter stays under `scripts/engine-reference/` so reference-specific normalization cannot become Maps engine truth.

The repository capability `test:integration` builds the Maps WASM transport, executes the canonical browser scenario against the MapLibre reference, and fails on a normalized semantic mismatch. It is deterministic semantic evidence, not a replacement for runtime-profiler performance capture or Moonlight policy.

## Milestone B runtime evidence

`runtime-profiler-scenarios/camera-world-pan-v1.yaml` is the representative Milestone B runtime scenario. It wraps a real Chromium journey implemented by `scripts/profile-engine-camera-runtime.mjs` while retaining the same Maps canonical camera workload.

Reference and candidate captures use one identical runtime-profiler scenario digest and one execution environment. The only selected implementation value is `MAPS_RUNTIME_PROFILE_IMPLEMENTATION`:

- `reference` executes the pinned MapLibre public-API reference adapter;
- `candidate` executes the generated first-party Rust/WASM scenario transport.

The selector name is declared as inherited environment in the profiler scenario so target construction is explicit. Its value is not used as a Maps-side comparability override. Runtime-profiler remains responsible for deciding whether the resulting immutable bundles have compatible scenario and environment identities.

`profile:runtime` performs the complete acceptance flow:

1. re-run canonical browser semantic parity first;
2. capture and validate an immutable reference runtime-profiler bundle;
3. capture and validate an immutable candidate bundle using the same scenario;
4. ask runtime-profiler for its descriptive reference-relative score;
5. pass the validated bundles and neutral `agent.evidence/v1` references to Moonlight;
6. require Moonlight's `agent.evaluation-result/v1` outcome to be `passed`;
7. preserve the reference bundle, candidate bundle, descriptive score and Moonlight result as the hosted evidence artifact.

For this foundation milestone, Moonlight requires at least five measured samples, complete candidate execution, and a runtime score of at least 75. That threshold is a broad viability guard, not a package-size or microbenchmark optimization target. A lower score fails acceptance; valid but non-comparable evidence is inconclusive and therefore does not pass.

The process collector continues to record process wall time, success/timeout state and supported process memory around the real browser journey. Its five-sample Moonlight policy remains separate from browser trace evidence.

`runtime-profiler-scenarios/camera-world-pan-browser-v1.yaml` uses the same canonical camera identity with the shared `browser-chromium` collector. Both collectors execute `scripts/profile-engine-camera-journey.ts`; Maps arranges the built, local fixture and owns the camera operations, while runtime-profiler owns Chromium launch, CDP tracing, normalization, immutable bundle validation and browser comparability. The browser collector captures exactly one journey containing 12 scenario executions. It does not supply process samples or satisfy the five-sample Moonlight process policy.

`verify:engine-runtime-evidence` also runs `verify:engine-browser-evidence` and preserves its `browser/` reference/candidate bundles plus the upstream `comparability.json` report in the existing artifact. The browser verifier requires real renderer-main tasks and normalized hot paths, all 12 explicit candidate boundary measures, and the upstream `comparable` result. Missing, incomplete or incompatible browser evidence fails this evidence command; comparable is an identity assessment, not a performance verdict. Run only browser evidence with:

```sh
bun run verify:engine-browser-evidence
```

This command expects an already built WASM package, the pinned runtime-profiler CLI, Node 24 or newer (for the TypeScript journey module), and installed Playwright Chromium. Output is immutable; choose a fresh `MAPS_BROWSER_EVIDENCE_DIR` for another run. The full command uses its existing `MAPS_RUNTIME_EVIDENCE_DIR` and nests browser bundles beneath it.

The candidate emits ordinary User Timing measures named `runtime-profiler:js-to-wasm:camera-world-pan` around scenario serialization, the WASM call and returned observation. These describe the inclusive instrumented section, not isolated marshaling/copying overhead. Do not infer a separate WASM-to-JavaScript cost from it. Raw trace events remain artifacts; bounded long-task/hot-path/boundary summaries come from runtime-profiler. Trace durations include loading and fixture execution, while the explicit measure identifies only the scenario boundary section. React render summaries, source-file/line attribution, worker/GPU work and browser memory remain outside this shipped collector's scope and unavailable here. #76 therefore remains open for its richer attribution requirements.

## Mixed-layer journey evidence (#170)

`runtime-profiler-scenarios/mixed-layer-journey-browser-v1.yaml` captures the canonical
`mixed-layer-journey-v1` through the same `browser-chromium` collector. Its Maps-owned journey,
`scripts/profile-mixed-layer-journey.ts`, builds the existing acceptance page for production,
serves it with the built `dist/wasm` package, and drives the public Map View. It writes a
Maps observation (`maps.mixed-layer-journey-observation/v1`) next to the immutable bundle.
`verify:engine-runtime-evidence` runs it as `verify:engine-mixed-layer-evidence`, under
`mixed-layer/` in the existing artifact:

```sh
RUNTIME_PROFILER_BIN=/path/to/runtime-profiler bun run verify:engine-mixed-layer-evidence
```

The counters in `e2e/helpers/mixed-layer-work.ts` wrap the prototypes of the WASM classes
the Map View already loaded. They count actual crossings, not React renders or mocks:

- frame plans, projection batches and coordinates, and aggregation queries;
- WebGPU frame submissions and their packed bytes;
- retained point and shape writes, updates, evictions and their bytes;
- tile uploads;
- released runtimes, renderers and aggregation indexes;
- Canvas base and overlay redraws.

The profiler journey also emits each crossing as a `runtime-profiler:js-to-wasm:<label>`
measure. Chromium coarsens `performance.now()` to 100 µs on this page and records
zero-length measures as instant events, which the pinned collector does not aggregate.
The profiler's marker occurrences therefore count only crossings of at least one timer
tick. The Maps observation counts every crossing.

The same counters back `e2e/maps-runtime.spec.ts` on WebGPU and Canvas. That test asserts
four invariants:

- an idle page does no work;
- a camera-only change keeps every prepared source, retained group and runtime resource;
- each hover change repaints only the application overlay (no frame plan, projection,
  aggregation, base redraw or upload);
- unrelated React commits reach no runtime, renderer or draw at all.

Each repaint is one WebGPU frame or one Canvas clear.

Limits:

- The pinned collector launches Chromium without WebGPU flags, so this capture measures
  the Canvas fallback. WebGPU work counts come from the Chromium test, not from a
  profiled trace.
- Trace long tasks include page load and the journey's forced GCs for heap sampling.
  The in-page phase observer reports long tasks per phase separately.
- GPU memory, WASM linear memory and total browser memory are unavailable.
- No reference implementation or parent revision runs this journey, so `evaluation.json`
  records comparison and Moonlight as `unavailable`. This evidence is descriptive, not a
  Fast verdict.

## Heat/scalar journey evidence (#171)

`runtime-profiler-scenarios/heat-scalar-journey-browser-v1.yaml` captures the canonical
`heat-scalar-journey-v1` through the same `browser-chromium` collector. Its Maps-owned
journey, `scripts/profile-heat-scalar-journey.ts`, builds `e2e/fixtures/heat-scalar-journey.html`
for production, serves it with the built `dist/wasm` package and drives the public Map View
in two lanes: the heat lane, and a control lane (`?heat=0`) with the same Map View without its
Heat Layers. It writes a Maps observation (`maps.heat-scalar-journey-observation/v1`) next
to the immutable bundle. `verify:engine-runtime-evidence` runs it as
`verify:engine-heat-scalar-evidence`, under `heat-scalar/` in the existing artifact:

```sh
RUNTIME_PROFILER_BIN=/path/to/runtime-profiler bun run verify:engine-heat-scalar-evidence
```

Per phase and lane the observation records `requestAnimationFrame` intervals, long tasks and
the heat/scalar work counters (`src/heat-layer-work.ts`, read through the evidence-only
`observeHeatLayerWork()` registry): index, grid, image, contour and raster builds, reuses,
discarded async results, uploads, decoded images, raster draws and their Canvas triangles.
Data and style phases also record input → presented-surface latency: from the input until
the new raster is decoded, plus one animation frame. JS heap is sampled after forced GC.

The verifier fails when evidence is missing or the invalidation contract is broken: the
control lane must do no heat work, camera and resize phases must rebuild no index, grid,
image or contours, density seeks must not touch the field, field refreshes must not
re-index density points, and ramp changes must reuse the retained grid. It writes
`evaluation.json` with the heat lane against the control lane per camera phase.

Limits:

- The pinned collector launches Chromium without WebGPU flags, so both lanes measure the
  Canvas fallback. Heat rasters are drawn by the Canvas overlay on both backends.
- The control lane isolates the cost of the heat surfaces; it is not a reference
  implementation. No reference or parent revision runs this journey, so `evaluation.json`
  records comparison and Moonlight as `unavailable`. This evidence is descriptive, not a Fast
  verdict.
- GPU memory, WASM linear memory, total browser memory and GPU completion time are unavailable.
  No WASM bridge carries heat/scalar data while TypeScript is the authority.

## Temporal playback journey evidence (#172)

`runtime-profiler-scenarios/temporal-playback-journey-browser-v1.yaml` captures the canonical
`temporal-playback-journey-v1` through the same `browser-chromium` collector. Its Maps-owned
journey, `scripts/profile-temporal-playback-journey.ts`, builds
`e2e/fixtures/temporal-playback-journey.html` for production, serves it with the built
`dist/wasm` package and drives the public temporal Convenience Map. It writes a Maps observation
(`maps.temporal-playback-journey-observation/v1`) next to the immutable bundle.
`verify:engine-runtime-evidence` runs it as `verify:engine-temporal-evidence`, under
`temporal/` in the existing artifact:

```sh
RUNTIME_PROFILER_BIN=/path/to/runtime-profiler bun run verify:engine-temporal-evidence
```

The heat/scalar and temporal journeys share their fixture build, static server, in-page timing
and heap sampling (`scripts/browser-journey-support.ts`).

Per phase the observation records `requestAnimationFrame` intervals, long tasks, slow input
events (Event Timing entries of at least 16 ms: input → next paint), and two work sets:

- the temporal work counters (`src/temporal-work.ts`, read through the evidence-only
  `observeTemporalWork()` registry): track preparations (and those by Rust), prepared tracks and
  keyframes, samples, sampled tracks, emitted and changed features, and bridge bytes into and out
  of the Rust/WASM sampler;
- the Map View runtime counters (`e2e/helpers/mixed-layer-work.ts`): aggregation queries and
  released aggregation indexes (one per rebuild), frame plans, projected coordinates, repaints,
  retained point/polygon writes, tile uploads, released runtimes and renderers, and Rust
  temporal samples, each also a measured `runtime-profiler:js-to-wasm:<label>` crossing.

Seeks and source replacements also record input → presented latency: from the input until the
new positions were sampled and repainted, plus one animation frame. JS heap is sampled after
forced GC.

The verifier fails when evidence is missing or the work contract is broken: no phase may
rewrite the static regions, re-upload tiles or (outside teardown) rebuild the runtime; every
sample is one measured Rust crossing over every track with the exact packed bridge bytes;
idle, paused camera and unrelated commits must neither prepare nor sample; playback, seeks,
scrubbing and camera-while-playing must sample without re-preparing; each seek samples once;
each source replacement and remount prepares once, with Rust; the scrub samples at most once
per input; the map-scoped time survives teardown. Load may prepare twice at most: the
TypeScript reference before the Rust runtime is ready, then Rust. It writes `evaluation.json`
with a per-phase summary.

Limits:

- The pinned collector launches Chromium without WebGPU flags, so the capture measures the
  Canvas fallback. WebGPU frame timing is not measured; on WebGPU the static regions are
  GPU-retained, and `e2e/maps-temporal-playback-journey.spec.ts` checks that time changes
  write no retained polygons there, without timing.
- The idle phase is the same Map View paused, not a reference implementation. No reference or
  parent revision runs this journey, so `evaluation.json` records comparison and Moonlight as
  `unavailable`. This evidence is descriptive, not a Fast verdict.
- GPU memory, WASM linear memory, total browser memory and GPU completion time are unavailable.

## Comparability

Runtime evidence may only be compared when runtime-profiler considers it strictly comparable. Missing or incomparable evidence is not reinterpreted as success by Maps or Moonlight.

Reference semantic evidence must identify the reference implementation/version and normalized observation contract. Incidental implementation details (for example MapLibre-internal cluster ids) are excluded unless Maps intentionally adopts them as public semantics.

For numeric camera observations, the browser parity adapter uses a bounded floating-point tolerance while structure, operation order, boolean world-wrap state, scenario identity and declared observation/runtime-phase identity remain exact. A tolerance is not widened to hide a discovered semantic difference; the implementation or normalization contract is corrected instead.

## Promotion/removal rule

A subsystem responsibility can move from MapLibre/TypeScript/reference code into the first-party Rust engine when:

1. the replacement has one explicit semantic owner;
2. representative canonical semantic observations match the adopted contract;
3. runtime evidence shows the replacement is viable for the representative workload rather than merely micro-benchmark-fast;
4. exact-head correctness/browser checks are green;
5. fallback behavior is explicit and fail-closed;
6. the superseded path is removed or reduced to an intentional reference/fallback boundary in the same milestone.

## Performance dimensions

Do not optimize one number in isolation. Depending on scenario capability, evidence should distinguish:

- initialization/index/decode cost;
- repeated camera/query/render-frame cost;
- frame-time distribution;
- long tasks/main-thread occupancy;
- memory/retained-resource behavior;
- JS/WASM bridge cost;
- GPU upload/rebuild cost;
- paint/draw cost;
- picking latency;
- source-level hotspots where supported.

Thresholds and release verdict policy remain outside runtime-profiler and belong in Moonlight/repository evaluation configuration.

## Canonical kernel evidence and retained diagnostics

The temporal/topology/scalar/heat workloads previously embedded in
`verify-benchmark-budgets.mjs` now have canonical `engine-scenarios/*-v1.json`
fixtures and matching `runtime-profiler-scenarios/` command scenarios.
`scripts/engine-kernel-scenarios.mjs` is their single execution body. The ordinary
`verify:benchmarks` gate and profiler target execute that same body through the
existing public processing APIs. Pre-refactor Bun observations at `748166c` protect
fixture, option and output equivalence; the gate retains its two warmups, eight
measured runs, five p95 budgets, warnings and historical baseline unchanged.

Kernel observation hashes cover a canonical numeric form, not raw IEEE-754 bit
patterns: every number is rounded to nine decimal places and twelve significant
digits before hashing, while structure, keys, strings and ordering stay exact.
`Math.hypot` and the other libm-backed `Math` functions are not correctly rounded
and their last bit varies with the engine, C library version and CPU, so a
bit-exact hash is a property of one machine rather than of the kernel. The
canonical form keeps observations comparable across runner images and local
machines without hiding any difference of map-domain size.

These are **kernel harness processes**, not browser Map Views. Profiler wall time
includes Bun startup, imports, fixture/index setup and all repeated kernel calls;
it cannot replace the gate's per-operation p95 or establish frame-rate/Fast
acceptance. The old baseline is historical kernel evidence, not an architectural
performance authority. Existing deterministic retained-work contracts and the
canonical camera runtime/Moonlight path remain separate.

Capture and publish the kernel evidence with the same pinned profiler checkout
and CLI used by CI:

```sh
RUNTIME_PROFILER_BIN=/path/to/runtime-profiler \
RUNTIME_PROFILER_SOURCE=/path/to/pinned/runtime-profiler-checkout \
  bun run profile:engine-kernels -- --output=.runtime-profiler/kernels-run-1
```

The command requires a fresh output directory and preserves all five validated
immutable bundles. `--reference=/path/to/clean-parent-checkout` optionally captures
the actual first-parent source with its own committed entrypoints and frozen
dependencies. It requires equal kernel observations before asking the profiler
to score strictly comparable bundles. No Maps environment/digest override exists.
Missing parent entrypoints, changed observations or incomparable captures produce
an unavailable comparison, never a passing score. Candidate capture failure fails
the command. No new Moonlight thresholds are declared for these processes; their
Moonlight evaluations are explicitly unavailable.

`--previous-history=<directory-or-HTTPS-base>` extends existing per-scenario
`runtime-profiler/score-history/v1` files through the **upstream**
`scripts/append-score-history.mjs`. A missing remote history (404) starts a cohort;
unreadable or malformed history fails rather than resetting it. Scores retain
their upstream descriptive meaning and source/workload/environment identities;
they are not release verdicts or controlled long-term trends. The first main
revision adopting these entrypoints has no parent capture and records that gap.
Development comparisons between the committed adapter and its own same-PR parent
validate transport only, not performance against a previously accepted main.

The remaining standalone commands are intentionally non-authoritative kernel
diagnostics with distinct coverage, not competing runtime acceptance:

| Command | Kernel property retained beyond the representative gate |
| --- | --- |
| `bench:temporal-geojson` | Raw/indexed playback across geometry sizes and three interpolation strategies. |
| `bench:geojson-transition` | Plan versus interpolation cost across algorithms, multipart matching and geometry collections. |
| `bench:scalar-field` | Grid, contour and image kernels at multiple sizes, with the explicit Canvas shim and optional WASM kernel. |
| `bench:heat-layer` | SVG rasterization kernel across source counts, radii and brute-force/indexed density evaluation. |
| `bench:heat-map` | Headless density/query/projection/SVG stages and cache-coverage diagnostics; its emulated viewport is not a first-party renderer. |
| `bench:performance` | Low-level flat resampling, temporal points, density-index build and Voronoi kernels. |

Their canonical family links are declared in each representative fixture's
`relatedKernelDiagnostics`. None replaces canonical browser journeys, publishes
a Moonlight verdict, or establishes first-party runtime authority.

## Versioned tileset observations

`bench:engine:interaction` includes `sourceLifecycle` observations from the public
Map View in the existing Engine Inspector, using the canonical dense
`vector-city-style-v1` fixture. Actual network requests, Rust decode calls,
bucket builds, bounded resource reuse, switch-to-ready latency and descriptive
Chromium JS heap are recorded for cold A, B/A revisits, resolved-paint changes and
an immutable revision change. Two decoder calls per cold WebGPU tile are reported:
the retained GPU bucket decode and the existing Canvas fallback representation.
Warm source/style changes must not repeat either decode or GPU bucket creation.

These observations do not provide total browser/GPU memory or controlled timing
comparisons. The parent lacks the public source-switch capability; that historical
comparison is explicitly unavailable. No Maps-generated success substitutes for
runtime-profiler comparability or a Moonlight evaluation. Rust and Chromium tile
churn checks remain correctness evidence, not camera-churn performance scores.

## Atlas tileset journey evidence (#270)

`maps-atlas-tileset-v1` is the matched reference/candidate comparison for the
content-pinned Atlas tileset. Both sides read the **same** Liechtenstein PMTiles
archives (full and northern, digest-verified by `scripts/fetch-atlas-tiles.ts`) from
one range-serving origin, at a 1280×720 viewport, through one journey:

`cold` → `pan-north` → `zoom-13` → `zoom-14` → `zoom-11` → `warm-revisit` →
`pan-shared` → `source-b` → `source-a`.

- **reference:** MapLibre GL + `pmtiles` (`scripts/engine-reference/maplibre-atlas.ts`)
  with the Maps Shortbread class palette as a MapLibre style. Both regions stay
  loaded once visited, like the candidate's inactive sources.
- **candidate:** the public `MapView flatRuntime="maps"` with the Atlas `tileset`
  (`e2e/fixtures/atlas-tileset-journey-candidate.tsx`) and nothing else on the page.

`e2e/fixtures/atlas-tileset-journey.ts` puts both behind one handle and one settle
rule: a step is done at the first animation frame, at least two frames after it was
applied, in which the runtime reports every visible tile loaded and presented (`idle`
for MapLibre; ready source, no pending tiles and the requested camera for Maps). The Node journey
`scripts/profile-atlas-tileset-journey.ts` cannot tell the two apart. It fails when
an archive response is not an HTTP 206 range read.

```sh
RUNTIME_PROFILER_BIN=/path/to/runtime-profiler \
MOONLIGHT_RUNTIME_PROFILE_BIN=/path/to/moonlight-runtime-profile \
  bun run verify:engine-atlas-tileset-evidence -- --report atlas-tileset-runtime.json
```

The command needs the built `dist/wasm` package and Playwright Chromium. It:

1. builds the fixture once and re-checks each archive against its digest-named file;
2. captures one browser trace per side (`atlas-tileset-browser-v1.yaml`) and asks
   runtime-profiler's `compare-browser` for strict comparability;
3. captures interleaved process rounds (`atlas-tileset-v1.yaml`, one warmup and five
   measured journeys per side), alternating which side runs first (two rounds by
   default; `--rounds`);
4. has Moonlight evaluate every round with the camera foundation policy: at least five
   samples, complete candidate execution, runtime score ≥ 75;
5. writes `evaluation.json` with source revision, archive and WASM digests, the
   environment fingerprint, browser/runtime identity, every raw sample and the outcome.

The outcome is `passed` only when every round passed, both capture orders ran, the
browser bundles are `comparable` and both sides ran the same steps over the same
archive revisions. One failed round is `failed`. Everything else is `inconclusive`. The
command exits 0 only for `passed`; it writes the evidence first in every case.

Read the result with these limits:

- The Moonlight score rates **process wall time and RSS of the journey driver**, which
  includes Chromium launch and teardown. It is a viability guard, not a claim that Maps
  is faster than MapLibre. Absolute timings on a shared runner are advisory.
- The sampled RSS is the driver process, not Chromium. Browser heap and GPU memory are
  unavailable (#76). The candidate's retained tile count and RGBA + MVT lower-bound
  bytes are recorded; GPU-buffer bytes only exist on the WebGPU backend.
- The pinned collector launches Chromium without WebGPU, so the candidate runs its
  Canvas2D backend against MapLibre's WebGL.
- Per-step first-useful-map, warm-revisit and switch-to-ready times, range requests and
  transferred bytes are Maps observations for both sides. Rust decodes, bucket builds
  and cache reuses are counted for the candidate; they are not timed.
- The journey jumps between settled cameras. It measures no frame time during motion.
- The archives are sparse inside their declared bounds and the first-party transport
  fails closed on a missing tile, so the cameras were chosen with every visible and
  neighbouring tile present. The journey does not cover a view over such a gap.

Every Pages deploy build runs the command and publishes the bundles under
`/maps/evidence/atlas-tileset/` and the report at
`/maps/evidence/atlas-tileset-runtime.json`. PR previews skip it.

## MapLibre oracle gate

`bun run oracle` ([oracle/](../oracle/run.ts), [#306](https://github.com/moritzbrantner/maps/issues/306)) renders each named scenario in `oracle/scenarios.ts` through `MapView flatRuntime="maplibre"` and `flatRuntime="maps"` with the same style, tiles, camera and data. Three gates block per scenario:

- **image:** NVIDIA FLIP of the map pixels (controls hidden) on SwiftShader, mean ≤ 0.005 and p99 ≤ 0.05, or MapLibre's own run-to-run floor rounded up when that is higher;
- **interaction:** scripted hovers and clicks pick the same feature ids, and drag/wheel steps end in the same bounds (≤ 1 px per edge);
- **time:** the median rAF interval of a scripted camera loop (vsync and frame-rate cap off) is ≤ 1.10× MapLibre's. It is enforced on a local hardware GPU and advisory on CI's software adapter.

Each timed round also records an advisory frame attribution (#343): per batch, the main-thread time per frame spent in page `requestAnimationFrame` callbacks plus the harness camera update, and the part of it blocked in WebGPU `getCurrentTexture`. The rest of the frame is browser work outside page script. The report shows the breakdown of each runtime's reported round. It never changes timing validity or a verdict.

Rotated and pitched cameras (`bearing`, `pitch`) click at the pixel MapLibre projects for each step. After a move they compare the camera (center, zoom, bearing, pitch, converted to corner displacement in pixels) instead of north-up bounds.

All data is free and served locally through request interception ([#320](https://github.com/moritzbrantner/maps/issues/320)):

- raster tiles are generated in Node (`oracle/tiles.ts`);
- vector tiles are Shortbread-shaped MVT cut on demand with `geojson-vt` and `vt-pbf` from `oracle/data/alpine-foreland.json`, a public-domain Natural Earth 1:10m extract (`oracle/clip-natural-earth.mjs`). Maps reads them through `tileset`; MapLibre reads them through the same Shortbread class palette, written as a data-driven style;
- SDF glyphs are Noto Sans (OFL-1.1, `oracle/glyphs/OFL.txt`), Latin-1 range only, built with `build_pbf_glyphs`. The sprite and the Terrarium DEM tiles are generated.

Every scenario is gated. Earlier ones covered capabilities Maps did not implement at all and were marked `unsupported` until their issue landed: `symbols`, SDF glyph symbol layers (#321); `line-dash-caps-joins` and `tileset-lines`, line dashes, caps and joins (#322); `fill-pattern`, sprite patterns on tileset and GeoJSON fills (#323); `hillshade` and `hillshade-terrain`, raster-dem hillshade and 3D terrain (#324). `symbol-icons` (#346) was gated from the start: plain and SDF sprite icons with joint text/icon collision; so were `symbol-zoom` (camera and composite symbol sizes and paint), `symbol-lines` (line and line-center labels under a bearing) and `symbol-lines-pitch` (line labels on the pitched map plane), #346,, `line-pattern` (sprite patterns on tileset and GeoJSON lines), #349, and `fill-pattern-pitch` and `line-pattern-pitch` (patterned GeoJSON shapes on the projected pitched path), #350. An `unsupported` scenario renders only the MapLibre reference, so the report shows the target; it claims no gate and does not fail the run. New capabilities Maps lacks enter the same way.

A failing gate listed in the scenario's `knownGaps` points to its follow-up issue. A known gap that starts passing fails the run until its entry is removed, so the list only shrinks. CI runs the gate in the `oracle` job and uploads `oracle-report`. Pages publishes the report at `/maps/oracle/`. MapLibre stays the default until a consumer's scenarios pass and the owner approves a switch (ADR 0003).
