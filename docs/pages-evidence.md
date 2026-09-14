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
