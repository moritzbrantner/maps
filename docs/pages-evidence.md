# GitHub Pages evidence surface

Maps publishes the first-party Rust/WASM Map View at the project root and at
`/engine/`. Both entrypoints exercise Maps' own camera, tile scheduler, MVT
decoder, WebGPU/Canvas2D renderer, clustering and selection. The default tile
source is a small, reproducibly generated **synthetic CC0 PMTiles v3 archive**
with complete z0–z2 coverage, served from the same Pages origin with HTTP 206
range reads. The alternate direct-MVT source uses the same first-party source
contract and renderer. These fixtures are **not real geography**. Publishing a
content-pinned, licensed real-world Atlas region remains the separate [#270](https://github.com/moritzbrantner/maps/issues/270)
work item, dependent on the asset-tooling artifact.

The former OpenStreetMap-backed library showcase is no longer a public Pages
entrypoint; it survives only at `/demo-reference/` in the development server
as a regression harness. `/benchmarks/` remains a distinct, explicitly
non-authoritative reference lab rather than the homepage. Maps consumes
`moritzbrantner/github-pages-template` only for the standardized `/stats/` and
`/evidence/` routes.

The Pages build pins the template to an exact Git commit and runs it in `--augment` mode after the normal Vite build. The template therefore cannot replace Maps domain behavior or renderer logic.

## Evidence sources

- `coding-tooling` supplies repository verification KPIs and their freshness semantics.
- `runtime-profiler` remains authoritative for runtime capture.
- Moonlight remains authoritative for comparable baseline/candidate evaluation and verdicts.
- `pages.config.json` declares the future normalized runtime evidence URL at `/maps/evidence/runtime.json`.

Until the runtime/Moonlight artifact is durably published to that URL for the exact source revision, the shared evidence page must show that source as unavailable. Missing runtime evidence is never treated as passing evidence.

This intentionally separates the presentation rollout from the next transport slice: publishing normalized `project-evidence-v1` runtime observations from CI without re-running or reinterpreting benchmarks in the browser.

## Canonical kernel runtime publication

The separate `kernel-runtime` source publishes profiler-owned kernel harness
observations at `/maps/evidence/kernel-runtime.json`. It does not fill the
unpublished camera/Moonlight URL or claim a renderer Fast verdict. The existing
Pages build captures five canonical Bun processing scenarios, transports their
validated immutable bundles under `/maps/evidence/kernels/<scenario>/candidate/`,
and renders their process metrics through the shared `/stats/` and `/evidence/`
surfaces. Each report links the upstream profiler's result explorer, which owns
bundle validation and detailed inspection.

Each `<scenario>.history.json` in that directory is retained across Pages builds
by the pinned upstream history writer. The actual clean first parent is captured
when it contains the committed workload entrypoints; the initial adoption's
missing parent is unavailable, not a fabricated baseline. Existing history is
never reset after a network/parse failure. Each score is descriptive adjacent
revision evidence on a shared runner; Moonlight evaluation remains unavailable
until a calibrated policy for that process workload is adopted. Per-kernel p95
budgets continue to belong to the ordinary repository kernel gate.


## Benchmark lab

GitHub Pages also publishes `/benchmarks/` as an interactive, non-authoritative browser lab.

- The Maps, Leaflet, and MapLibre lanes consume the same deterministic dense-point fixture and camera journey.
- The Canvas2D lane is deliberately a post-projection pixel baseline; it does not implement or own geographic projection.
- Leaflet is loaded only by the benchmark page as a pinned reference runtime. Failure to load that reference is shown as unavailable rather than hidden or treated as a passing result.
- p50/p95 values are local-session presentation timings. They are useful for interactive inspection but are not accepted as runtime-profiler evidence and do not participate in Moonlight verdicts.
- Canonical performance claims remain attached to stable engine scenarios and exact-head CI/runtime-profiler evidence.
- The `vector-city-style-v1` interaction capture uses the explicit
  `/engine/?view=benchmark` fixture route. It retains the prior map camera,
  1,000-point workload and canonical dense MVT bytes supplied by the benchmark
  runner, now under a same-origin fixture URL. This keeps the measurement scope
  distinct from the new Pages homepage and prevents a synthetic fixture from
  being misidentified as geographic Atlas data.
- `scripts/benchmark-point-journey.mjs` runs the deterministic 10k/100k dense-point camera journey of the retained-point spec on the Maps WebGPU and Canvas2D lanes, MapLibre and Leaflet without basemap tiles, and publishes `/maps/evidence/point-journey.json` on every Pages build (see `docs/engine-performance.md`). It is descriptive and never gates a change.
- The lab also charts the history of `scripts/benchmark-interactions.mjs` (drag, wheel-zoom and rotate over deterministic raster and Shortbread-style vector basemaps; Maps WebGPU, Maps Canvas2D and MapLibre). Every Pages build on `main` runs that benchmark and appends the run to `/maps/benchmarks/history.json` (`maps.interaction-benchmark-history/v1`, built by `scripts/build-benchmark-history.mjs`). The history exists only on Pages: each build extends the published file, a failed benchmark republishes the previous history, and an unreadable history fails the build rather than silently resetting it. These runs use a software GPU on shared runners; they are descriptive and never gate a change.

## Engine inspector

`/maps/engine/?view=inspector` is the renderer inspector on the engine page:
a full-viewport first-party Map View over the local synthetic PMTiles source by
default, with retained WebGPU buckets or the Canvas2D fallback via `gpu=off`,
frame cadence, draw calls, retained GPU resources, camera presets, style-class
toggles and a scripted sweep. Optional fixture A/B and revision-2 source
selection exercises invalidation; the inspector does not load external
OpenStreetMap tiles by default. URL parameters: `lon`, `lat`, `zoom`,
`bearing`, `source=a|b|a2`, `gpu=off`.
