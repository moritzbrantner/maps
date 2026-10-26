# Maps CI execution

The CI caller preserves the repository's validation commands and required
`merge-ready` check. It changes where work executes:

- Rust format, Clippy, native tests and the WASM-target check run in the Nix job.
- Clean Git-source acceptance runs independently in the same Nix environment.
  Its real install, frozen reinstall, stale-stylesheet rebuild and installed-WASM
  runtime proof remain unchanged. This job never consumes a prepared Maps
  artifact. Its only Actions cache contains downloaded Cargo registry/Git inputs,
  keyed by the lockfile and toolchain/environment declarations, not `target` or
  a prepared Maps dependency. A fresh runner still performs the real prepare
  lifecycle.
- Source-related PR/main changes and manual dispatches invoke the existing
  verified build-artifact producer. Its package includes both `dist` and browser
  WASM. The full browser suite and dispatch-only consumers receive the producer's
  exact source SHA, receipt, artifact digest and identity digest through the
  existing shared consumer action. Browser jobs do not install a Rust compiler
  or rebuild WASM.
- Full Chromium tests are split at the test level with Playwright's native
  `--fully-parallel --shard=N/2`, while `--workers=1` keeps GPU work sequential on
  each independent runner. At the parent source, discovery proves that the two
  shards contain 49 + 49 distinct cases: their disjoint union is all 98 cases in
  the unchanged full Chromium suite. No test selection/expectation is removed.
- Both shards and smoke use distinct concurrency groups and failure-artifact
  names. One shard cannot cancel the other or overwrite its evidence. A failed
  shard does not prevent the other from running, and the matrix result remains
  required by `merge-ready`.
- New commits cancel superseded runs of the same PR. Main/manual runs are not
  cancelled by this policy. No unrelated PR's run is cancelled.

The ordinary event policy remains intact: full browser validation is
path-conditional; smoke, packed-package, WASM-package and runtime-evidence jobs
remain manual-dispatch tiers. Git installation and Rust checks remain required
on every CI run. The ruleset requires `merge-ready`, so matrix display names do
not retire a required check.

## Measurement boundary

Same-product parent [main CI run 40378190126](https://github.com/moritzbrantner/maps/actions/runs/40378190126)
at `4fd0ebf` ran the unchanged 98-case Chromium suite. Its combined Rust/Git
job took 8m59s, full browser validation 14m50s (11m57s in tests), and Fast
Validation 2m25s. CI completed 15m08s after creation.

A second nearby baseline [CI run 40395272400](https://github.com/moritzbrantner/maps/actions/runs/40395272400)
at source `d782c8e` spent 9m01s in the combined Rust/Git-install job and 9m33s in
full browser validation (7m19s in its test command). Fast validation took 2m02s.
The Rust log attributes approximately 115s + 112s to two real consumer installs,
then a further prepare rebuild; its first release WASM compile itself took 38s.
These are shared-runner observations, not stable benchmark thresholds.

The candidate keeps all acceptance work but overlaps independent jobs and
removes browser-local WASM compilation. Hosted run job/step timestamps establish
actual execution time and runner-minutes; workflow creation-to-start records
queue delay separately. A change in runner-minutes is not interchangeable with
critical-path latency. The PR records the executed candidate comparison; no
speedup is inferred solely from the new topology. This CI timing comparison is
not a Maps runtime-profiler/Moonlight performance verdict.
