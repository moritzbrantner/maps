# GitHub Pages evidence surface

Maps keeps its interactive showcase authoritative at the project root and consumes `moritzbrantner/github-pages-template` only for the standardized `/stats/` and `/evidence/` routes.

The Pages build pins the template to an exact Git commit and runs it in `--augment` mode after the normal Vite build. The template therefore cannot replace Maps domain behavior or renderer logic.

## Evidence sources

- `coding-tooling` supplies repository verification KPIs and their freshness semantics.
- `runtime-profiler` remains authoritative for runtime capture.
- Moonlight remains authoritative for comparable baseline/candidate evaluation and verdicts.
- `pages.config.json` declares the future normalized runtime evidence URL at `/maps/evidence/runtime.json`.

Until the runtime/Moonlight artifact is durably published to that URL for the exact source revision, the shared evidence page must show that source as unavailable. Missing runtime evidence is never treated as passing evidence.

This intentionally separates the presentation rollout from the next transport slice: publishing normalized `project-evidence-v1` runtime observations from CI without re-running or reinterpreting benchmarks in the browser.


## Benchmark lab

GitHub Pages also publishes `/benchmarks/` as an interactive, non-authoritative browser lab.

- The Maps, Leaflet, and MapLibre lanes consume the same deterministic dense-point fixture and camera journey.
- The Canvas2D lane is deliberately a post-projection pixel baseline; it does not implement or own geographic projection.
- Leaflet is loaded only by the benchmark page as a pinned reference runtime. Failure to load that reference is shown as unavailable rather than hidden or treated as a passing result.
- p50/p95 values are local-session presentation timings. They are useful for interactive inspection but are not accepted as runtime-profiler evidence and do not participate in Moonlight verdicts.
- Canonical performance claims remain attached to stable engine scenarios and exact-head CI/runtime-profiler evidence.
- The lab also charts the history of `scripts/benchmark-interactions.mjs` (drag, wheel-zoom and rotate over deterministic raster and Shortbread-style vector basemaps; Maps WebGPU, Maps Canvas2D and MapLibre). Every Pages build on `main` runs that benchmark and appends the run to `/maps/benchmarks/history.json` (`maps.interaction-benchmark-history/v1`, built by `scripts/build-benchmark-history.mjs`). The history exists only on Pages: each build extends the published file, a failed benchmark republishes the previous history, and an unreadable history fails the build rather than silently resetting it. These runs use a software GPU on shared runners; they are descriptive and never gate a change.

## Engine inspector

`/maps/engine/?view=inspector` is the renderer inspector on the engine page: a full-viewport first-party Map View over the live Shortbread basemap, with the base renderer (retained WebGPU buckets, Canvas overlay, or the Canvas2D fallback via `gpu=off`), frame cadence, per-frame draw calls, retained GPU resources, camera presets, style-class toggles and a scripted camera sweep. URL parameters: `lon`, `lat`, `zoom`, `bearing`, `path=overlay`, `gpu=off`, `tiles=<MVT URL template>`.
