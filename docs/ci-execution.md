# Maps CI execution

The CI caller preserves the repository's validation commands and required
`merge-ready` check. It changes where work executes:

- Rust format, Clippy, native tests and the WASM-target check run in the Nix job.
- Clean Git-source acceptance runs independently in the same Nix environment.
  Its real install, frozen reinstall, stale-stylesheet rebuild and installed-WASM
  runtime proof remain unchanged. This job never consumes a prepared Maps
  artifact. Its only Actions cache contains downloaded Cargo registry/Git inputs,
  keyed by the lockfile and toolchain/environment declarations, not `target` or
  a prepared Maps dependency. The outer checkout acquires dependencies without
  redundant Git lifecycle builds: the verifier only needs source MapLibre CSS
  there. The separate clean consumer still runs every real prepare lifecycle.
- Source-related PR/main changes and manual dispatches invoke the existing
  verified build-artifact producer. Ordinary browser consumers need WASM and the
  compiled outputs of three locked Git dependencies, not a full Maps JS package.
  The producer runs their ordinary frozen install/prepare once and builds WASM.
  Manual dispatch still builds the full Maps package for its package/evidence
  tiers. Runtime and full-package artifacts have distinct semantic keys.
- The artifact includes `public/wasm` and three explicit dependency `dist` trees:
  `@moritzbrantner/ui`, `@moritzbrantner/timeline-editor`, and
  `@moenarch/editor-core` (about 4.2 MB uncompressed at the parent lockfile).
  Browser consumers acquire frozen source dependencies with `--ignore-scripts`,
  verify the producer receipt, exact source, artifact digest and identity digest
  using the existing shared consumer action, then stage those compiled outputs.
  Every shared byte is covered by that receipt and the lockfile-bound source.
  There is no persistent prepared Maps cache, and this reuse never enters the
  independent Git-install acceptance job.
- Full Chromium validation uses two native complementary `--grep` /
  `--grep-invert` selections over the three slower files `maps-demo.spec.ts`,
  `maps-runtime.spec.ts` and `maps-engine-tiles.spec.ts`. Their first hosted
  measurements totaled 363s; all other files totaled 365s. Discovery proves the
  groups contain 39 + 59 distinct cases: their disjoint union is all 98 cases in
  the unchanged full Chromium suite. New/unrecognized files automatically enter
  the complement. These are explicit workload groups, not a duration scheduler;
  equal future runtime is not guaranteed. Each runner keeps one software-GPU
  worker. No test selection/expectation is removed.
- Browser groups and smoke use distinct concurrency groups and failure-artifact
  names. One cannot cancel another or overwrite its evidence. A failed group
  does not prevent the other from running, and the matrix result remains
  required by `merge-ready`.
- New commits cancel superseded runs of the same PR. Main/manual runs are not
  cancelled by this policy. No unrelated PR's run is cancelled.

The ordinary event policy remains intact: full browser validation is
path-conditional; smoke, packed-package, WASM-package and runtime-evidence jobs
remain manual-dispatch tiers. Git installation and Rust checks remain required
on every CI run. The ruleset requires `merge-ready`, so matrix display names do
not retire a required check.

Bun package-cache restores are disabled in these CI roles. In the first hosted
candidate they took 10–20s per job, followed by 49–54s of Git lifecycle builds
that the cache did not avoid. A clean dependency-only acquisition with an empty
cache and `--ignore-scripts` took 2.99s locally. That local observation is not a
hosted speedup claim; the candidate's actual cold hosted jobs remain the test.
Exact validated producer artifact reuse remains enabled.

## Measurement boundary

Same-product parent [main CI run 40378190126](https://github.com/moritzbrantner/maps/actions/runs/40378190126)
at `4fd0ebf` ran the unchanged 98-case Chromium suite. Its combined Rust/Git
job took 8m59s, full browser validation 14m50s (11m57s in tests), and Fast
Validation 2m25s. CI completed 15m08s after creation; summed executing-job time
was 26m24s.

A nearby baseline [CI run 40395272400](https://github.com/moritzbrantner/maps/actions/runs/40395272400)
at source `d782c8e` spent 9m01s in the combined Rust/Git-install job and 9m33s in
full browser validation (7m19s in its test command). Fast validation took 2m02s.
This source has additional source-switch tests and is not the same product head.
The Rust log attributes approximately 115s + 112s to two real consumer installs,
then a further prepare rebuild; its first release WASM compile itself took 38s.
These are shared-runner observations, not stable benchmark thresholds.

The first candidate [run 40400192854](https://github.com/moritzbrantner/maps/actions/runs/40400192854)
at `78bdc10` passed all 98 browser cases, Rust, Git installation, Fast and audit
checks, but was not accepted as the optimization result. It took 13m03s after
creation and 30m58s summed executing-job time, versus 15m08s / 26m24s on the
parent. Its extra workflow-change audit accounts for 1m20s; even excluding that,
29m38s remained higher than the parent's runner time. Equal 49-case contiguous
shards took 8.2m and 4.1m of testing, exposing workload skew. The second iteration
addresses that observed skew and redundant dependency builds; the first green
run does not justify a cost-reduction claim.

Hosted job/step timestamps establish execution time and runner-minutes; workflow
creation-to-start and dependency-ready-to-job-start record queue delay
separately. Runner-minutes are not interchangeable with critical-path latency.
The PR records the final executed comparison, including raw and audit-normalized
cost. This CI timing comparison is not a Maps runtime-profiler/Moonlight verdict.
