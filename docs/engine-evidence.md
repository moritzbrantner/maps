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

The current runtime-profiler command collector records process wall time, process success/timeout state and supported process memory evidence around the real browser journey. Rich Chromium trace ingestion, long-task attribution, React render summaries and source-level browser hotspots remain runtime-profiler platform work. Maps does not fabricate those metrics locally or claim they are already covered by this milestone.

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
