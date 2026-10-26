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
| Points and clusters | Yes | Yes | In progress | Circle instancing landed in #153; finish packed/retained application transport under #154/#60 with representative density evidence. Labeled points are GPU-retained like the others; camera frames project only the labeled points, for the Canvas label pass (#204). Deterministic work contracts (#189, `performance:work`) hold camera pan/zoom/bearing/pitch at 1k/10k/100k points to zero point encoding and upload, and in-place updates to work linear in the changed points only. Cluster layers still use the projected path. |
| Lines and flows | Yes | Yes (#195: retained WebGPU lines and flows match the Canvas oracle) | In progress | Lines, flow direction markers and flow endpoints are GPU-retained in shape groups (#195). Frames with labeled points stay retained too (#204), and the MapLibre/Leaflet comparison is #197. |
| GeoJSON polygon fills/strokes and holes | Yes | Yes (#161: WebGPU matches the Canvas oracle) | In progress | Polygons are GPU-retained (#196): Rust lowers rings once and camera frames upload nothing. Frames that mix polygons, lines and points keep them retained as point and shape groups in one painter order (#195). |
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

### Versioned Maps Tilesets (#268)

The public source contract and source-aware runtime have focused Rust/TypeScript
and Chromium coverage, including both renderers, warm data/style reuse,
revision changes, reversed responses, camera/application selection and bounded
eviction. The existing canonical interaction artifact now includes dense-fixture
source lifecycle observations. Executed gates and measurements are recorded in
the owning PR; an unavailable historical source-switch comparison remains
unavailable and is not a comparative performance pass. This scoped work does not
complete the general vector-style/cartography milestones.

Executed at `f034eedf9a8ef39a84cf4ab5e4b048bb9a274ea9` (shared convention
source revision `c104800c7aaeaea12d56f9093e71bdef6a2ce6fa`):

- Rust/WASM gate passed; the source contract has five native integration tests.
- `verify:agent` passed 64 files / 579 tests. Chromium smoke passed 70/70 on the
  fresh isolated candidate; the later metadata-only refactor passed its 14
  focused tests, typecheck and all eight affected browser cases.
- The existing five-sample canonical interaction command stayed on WebGPU. Cold
  A used one network request, two Rust decodes and one bucket build; after loading
  B, five A revisits and five resolved-paint changes added **zero** requests,
  decodes or bucket builds. A revision bump added one request, two decodes and one
  bucket build. Warm A switch-to-ready latency was 17.9 ms median (17.3–22.1 ms).
- Retaining A/B recorded 2,231,552 RGBA/MVT lower-bound bytes and 6,790,480 actual
  GPU geometry-buffer bytes; retaining revision 2 increased these to 3,347,328
  and 10,185,720 bytes. These exclude decoded JS object overhead, driver memory,
  other GPU allocations and total browser memory. The privacy-coarsened reported
  JS heap was 10 MB and cannot establish precise growth.
- The canonical interaction frame interval p95 was 16.8 ms in this descriptive
  software-GPU run. It is not GPU-completion FPS, a controlled historical
  comparison or a Moonlight verdict. The parent source-switch comparison remains
  unavailable. Capture SHA-256:
  `4562ad2b871d98886c15304ae18a7e96f05fa54f740c94a6b1c6117dcb8d3585`.
- Six SHA/byte-verified real MVT samples from the owning asset-tooling producer
  passed both current Rust/WASM geographic and pixel decoders, including the
  expected two water holes. Production ODbL bytes remain outside Maps Git.
- Full package validation passed API, unit/integration, build, entry bundles and
  clean packed consumers, then **failed the unchanged size gate**: compressed
  package 466,311 > 446,000 bytes; WASM 678,690 > 625,500 bytes. Unpacked
  1,600,239 < 1,752,500 bytes, 75 < 84 entries and both stylesheet budgets passed.
  The equivalent main baseline was 442,200 compressed / 1,525,127 unpacked /
  624,781 WASM bytes. This feature is not declared complete while required size
  acceptance remains unresolved.
