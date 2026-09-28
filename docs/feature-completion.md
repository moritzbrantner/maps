# Maps Feature Completion Protocol

The first-party Maps program uses one completion rule for product/runtime features:

> **Developed → Correct → Fast**

A feature is not complete merely because an implementation exists. It is complete only after all three gates have passed on the same authoritative path.

## Gates

### 1. Developed

The feature has a coherent, usable implementation on the intended Maps-owned runtime path.

- It is integrated through the owning map-domain contracts rather than a parallel demo-only implementation.
- Authority boundaries are explicit: Rust owns map-domain results; browser backends own pixels/picking; React owns composition/lifecycle.
- Required fallback behavior is explicit and fail-closed.
- The implementation has an observable end-to-end path, not only scaffolding or isolated helpers.

### 2. Correct

The developed feature is proven before optimization work changes its shape.

- Deterministic unit/integration coverage protects map-domain invariants.
- Browser evidence covers user-visible rendering and interaction where applicable.
- MapLibre/Leaflet reference parity is used only where their behavior is the compatibility target.
- Edge cases that affect semantics are covered, including invalid geometry, world wrapping, holes/order, picking identity, fallback/recovery, and controlled interaction state where relevant.
- Exact-head required checks are green.

A feature with unresolved semantic correctness is **not eligible for Fast work** except diagnostic instrumentation needed to identify the defect.

### 3. Fast

Optimization starts from a correct implementation and is driven by representative evidence.

- Reuse canonical Maps scenarios; do not create a microbenchmark that cannot represent the user path.
- Measure the costs the architecture can move: main-thread work, frame-time distribution, bridge crossings/bytes, allocation, GPU upload, draw submission, memory, and picking latency where supported.
- Remove unnecessary work before adding complexity: retain stable data, separate invalidation domains, batch crossings, reuse buffers/resources, cull invisible work, and avoid React in per-frame engine paths.
- Use 2d-lab for renderer experiments/evidence when useful, then graduate proven techniques into a Maps-owned implementation.
- A data-volume or operation-count reduction is useful evidence but is not, by itself, an FPS or end-to-end performance claim.
- Missing or incomparable runtime evidence is inconclusive, not Fast.

If a performance change breaks correctness, the feature returns to the Correct gate.

## Program sequencing

Work vertically by feature or coherent subsystem:

```text
Develop feature
    ↓
prove correctness
    ↓
profile representative path
    ↓
optimize measured bottlenecks
    ↓
prove correctness again
    ↓
record Fast evidence
    ↓
complete
```

Do not accumulate many half-finished features and postpone correctness/performance to a final cleanup phase. Conversely, do not spend repeated optimization cycles on one already-usable feature while a required neighboring feature is still absent unless evidence shows that feature is the dominant blocker for the Maps experience.

## Core v1 completion boundary

The first-party engine is **v1 complete** when Milestones B through E are complete under this protocol:

- B — independent camera, interaction, raster source/tile runtime;
- C — first-party rendering for the Leaflet-class application feature set;
- D — practical vector-tile/style engine;
- E — credible labels/symbol cartography.

Milestone F remains an advanced program. Terrain, globe, native/offline, extrusion and similar work must not hide unfinished B-E foundations.

MapLibre remains a reference/fallback at explicit edges until the replacement responsibility has passed Developed, Correct and Fast. Once a replacement is proven, converge by deleting the superseded production authority rather than keeping two engines indefinitely.

## Current completion matrix

This is a planning snapshot, not a substitute for issue/PR evidence. Update a row only when the owning issue or merged evidence changes.

| Capability | Developed | Correct | Fast | Current direction |
| --- | --- | --- | --- | --- |
| Geographic camera, project/unproject, fit/interaction | Yes | Yes | In progress | Keep Rust authoritative; profile the full camera presentation path, not camera math in isolation. |
| Raster tile/source lifecycle and first-party base map | Yes | Yes | In progress | Retain GPU resources, prove churn/overzoom/world-copy/memory behavior, then retire superseded paths. |
| Points and clusters | Yes | Yes | In progress | Circle instancing landed in #153; finish packed/retained application transport under #154/#60 with representative density evidence. |
| Lines and flows | Yes | Yes | In progress | Keep the shared render frame; profile triangle generation/upload and retain stable geometry before adding specialized paths. |
| GeoJSON polygon fills/strokes and holes | Yes via Canvas reference | Yes via Canvas reference | Not yet | Add hole/order-correct WebGPU coverage first, prove Canvas parity, then retain/chunk/cull polygon GPU geometry. |
| Picking, hover and selection | Yes | Yes | In progress | Preserve Maps feature/primitive identity; optimize misses/broad phase only from representative pointer evidence. |
| Heat/scalar surfaces | Existing product capability | Existing correctness coverage | Needs first-party performance pass | Integrate through the common rendering/runtime evidence path before calling the first-party path complete. |
| Measurement and GeoJSON editing | Existing product capability | Existing correctness coverage | Needs first-party integration audit | Preserve editor/measurement authority while removing accidental dependency on legacy rendering responsibilities. |
| MVT/vector source lifecycle | Partial | Partial | Not yet | Finish the production source/cache contract and polygon geometry path before performance promotion. |
| Style-spec-compatible vector layers/expressions | Not complete | Not complete | Not started | Develop background/fill/line/circle/raster + filters/expressions, then parity, then bucket/render optimization. |
| Labels, icons and collision placement | Not complete | Not complete | Not started | Develop the cartography model first; correctness includes shaping/collision/stability; optimize only afterward. |
| MapLibre responsibility retirement | Partial | Evidence-gated | Evidence-gated | Remove each responsibility only after its first-party replacement passes all three gates. |

## Near-term order

1. Finish the **Fast** gate for dense points/clusters without broadening semantics.
2. Take **polygons** through Developed → Correct → Fast on WebGPU, using the existing Canvas even-odd/hole behavior as the correctness oracle and 2d-lab retained/chunk/culling work as experiment input.
3. Finish lines/flows and heat/scalar performance on the same retained/batched renderer foundation.
4. Complete vector-source/style features one vertical layer family at a time: develop, parity-test, then optimize.
5. Complete labels/symbols the same way.
6. Retire MapLibre responsibilities immediately after their replacements pass all three gates; do not defer convergence indefinitely.
