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
