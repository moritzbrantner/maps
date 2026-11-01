# Maps engine evidence contract

Maps uses shared tooling instead of growing a private performance/evaluation platform.

## Ownership

- **Maps** owns canonical scenario identity, deterministic fixtures, map-domain observations and reference adapters.
- **coding-tooling** discovers/invokes repository-declared deterministic scenario capabilities.
- **runtime-profiler** captures, validates and summarizes immutable runtime evidence. It owns profiler-specific bundle formats and strict comparability.
- **Moonlight** owns baseline/candidate comparison policy and verdicts.
- **reusable-workflows** may transport/reuse exact build and evidence artifacts; it does not reinterpret evidence.

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

## MapLibre oracle gate

`bun run oracle` ([oracle/](../oracle/run.ts), [#306](https://github.com/moritzbrantner/maps/issues/306)) renders each named scenario in `oracle/scenarios.ts` through `MapView flatRuntime="maplibre"` and `flatRuntime="maps"` with the same style, tiles, camera and data. Three gates block per scenario:

- **image:** NVIDIA FLIP of the map pixels (controls hidden) on SwiftShader, mean ≤ 0.005 and p99 ≤ 0.05, or MapLibre's own run-to-run floor rounded up when that is higher;
- **interaction:** scripted hovers and clicks pick the same feature ids, and drag/wheel steps end in the same bounds (≤ 1 px per edge);
- **time:** the median rAF interval of a scripted camera loop (vsync and frame-rate cap off) is ≤ 1.10× MapLibre's. It is enforced on a local hardware GPU and advisory on CI's software adapter.

Rotated and pitched cameras (`bearing`, `pitch`) click at the pixel MapLibre projects for each step. After a move they compare the camera (center, zoom, bearing, pitch, converted to corner displacement in pixels) instead of north-up bounds.

All data is free and served locally through request interception ([#320](https://github.com/moritzbrantner/maps/issues/320)):

- raster tiles are generated in Node (`oracle/tiles.ts`);
- vector tiles are Shortbread-shaped MVT cut on demand with `geojson-vt` and `vt-pbf` from `oracle/data/alpine-foreland.json`, a public-domain Natural Earth 1:10m extract (`oracle/clip-natural-earth.mjs`). Maps reads them through `tileset`; MapLibre reads them through the same Shortbread class palette, written as a data-driven style;
- SDF glyphs are Noto Sans (OFL-1.1, `oracle/glyphs/OFL.txt`), Latin-1 range only, built with `build_pbf_glyphs`. The sprite and the Terrarium DEM tiles are generated.

Some scenarios cover capabilities Maps does not implement at all: hillshade/terrain (#324). (`symbols`, SDF glyph symbol layers, is gated since #321; `line-dash-caps-joins` and `tileset-lines`, line dashes, caps and joins, since #322; `fill-pattern`, sprite patterns on tileset and GeoJSON fills, since #323.) They are marked `unsupported` and render only the MapLibre reference, so the report shows the target. They claim no gate and do not fail the run. Each becomes gated once its issue lands.

A failing gate listed in the scenario's `knownGaps` points to its follow-up issue. A known gap that starts passing fails the run until its entry is removed, so the list only shrinks. CI runs the gate in the `oracle` job and uploads `oracle-report`. Pages publishes the report at `/maps/oracle/`. MapLibre stays the default until a consumer's scenarios pass and the owner approves a switch (ADR 0003).
