# Maps engine evidence contract

Maps uses shared tooling instead of growing a private performance/evaluation platform.

## Ownership

- **Maps** owns canonical scenario identity, deterministic fixtures, map-domain observations and reference adapters.
- **coding-tooling** discovers/invokes repository-declared deterministic scenario capabilities.
- **runtime-profiler** captures, validates and summarizes immutable runtime evidence. It owns profiler-specific bundle formats.
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

## Comparability

Runtime evidence may only be compared when runtime-profiler considers it strictly comparable. Missing or incomparable evidence is not reinterpreted as success by Maps.

Reference semantic evidence must identify the reference implementation/version and normalized observation contract. Incidental implementation details (for example MapLibre-internal cluster ids) are excluded unless Maps intentionally adopts them as public semantics.

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
