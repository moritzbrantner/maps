# First-Party Maps Engine Roadmap

This document is the authoritative long-term roadmap for evolving `@moritzbrantner/maps` into a first-party Rust/WASM map engine.

The target is not "MapLibre rewritten in Rust". The target is a Maps-owned geographic engine with deterministic Rust semantics, a thin browser host, and replaceable Canvas2D/WebGPU pixel backends. The project should first reach Leaflet-class independence, then incrementally pursue MapLibre-class vector-map and cartography capabilities.

"First-party" describes semantic ownership, not implementation isolation. Maps should own map behavior while composing existing lower-level workspace foundations for generic geo, assets, evidence and genuinely 3D primitives. For 2D rendering, `2d-lab` supplies experiments and evidence rather than runtime authority. ADR 0007 defines that boundary.

## Target architecture

```text
Application
    |
    v
@moritzbrantner/maps React / TypeScript API
    |
    v
Thin browser host
(events, canvas, workers, WebGPU device)
    |
    v
maps-wasm
(stable packed boundary)
    |
    v
Maps Rust Engine
  - geographic camera semantics
  - Web Mercator + world wrapping
  - viewport + map constraints
  - tile addressing + scheduling
  - tile/source cache
  - vector/raster sources
  - spatial indexes + clustering
  - map geometry + topology
  - style evaluation
  - label placement
  - render preparation
    |
    +--> narrow adapters to existing lower-level foundations
    |      - moenarch-geo-core / geo-analysis
    |      - 3d-lab for genuinely 3D math/camera/spatial primitives
    |      - asset-tooling for reproducible generated/static assets
    |      - runtime-profiler / Moonlight / coding-tooling evidence boundaries
    |
    v
typed Maps render frames
    |
    +--> Canvas2D reference backend
    +--> wgpu/WebGPU production backend
```

The arrow to shared foundations is not an authority transfer. Maps converts between map-domain state and generic primitives through narrow adapters; longitude/latitude/zoom/bearing/pitch, projection behavior, tile semantics, style/cartography behavior and map interaction identity remain Maps-owned. `2d-lab` is intentionally outside this runtime dependency chain: it is a 2D rendering lab whose findings may inform Maps-owned backend choices.

## Foundation authority map

Before adding a local subsystem, check the existing workspace authorities first.

| Concern | Authority / source of primitives | Maps responsibility |
| --- | --- | --- |
| Geographic geometry and generic geo algorithms | `moenarch-geo-core` / `geo-analysis` | Map-product semantics, projection/runtime policy and public map behavior |
| Genuinely 3D vectors, transforms, view/projection camera math | `3d-lab` Rust foundations when compatible | Use only after Maps converts geographic state into a safe local render frame; ordinary flat-map camera/projection remains Maps-owned |
| Generic 3D/spatial interoperability | `3d-lab` spatial contracts | Define map-specific anchoring/overlay semantics and never move GIS truth into the 3D layer |
| Generated/static assets and provenance | `asset-tooling` | Define map/cartographic asset requirements and consume reproducible outputs |
| 2D renderer/backend experiments and performance evidence | `2d-lab` as a lab, not a runtime authority | Consume findings through Maps-owned adapters/implementations; do not adopt the lab display list or workload model as the Maps scene/render contract |
| Runtime evidence | `runtime-profiler` | Own representative Maps scenarios |
| Evidence verdict policy | Moonlight | Supply map-specific comparable evidence, not duplicate threshold logic |
| Deterministic capability/conformance discovery | `coding-tooling` | Declare Maps capabilities and consume the shared checks |
| Map-specific Canvas/wgpu pixels and picking | Maps render backends | Consume Maps-owned frames; never acquire independent geographic truth |

When a shared API is close but incomplete, prefer improving or extracting the generic foundation before writing a parallel Maps implementation. Do not create a generic abstraction merely because reuse is imaginable; a concrete second consumer and a stable authority boundary are required.

## Milestone A — Engine Contract & Evidence Platform

Establish the contracts and evidence system every later subsystem uses.

Deliverables:

- Maps-owned engine vocabulary for camera, viewport, projection, tile identity, source identity, features, layers, render frames and picks.
- A canonical scenario corpus shared by correctness tests, profiling, CI and compatibility checks.
- Reference harnesses for MapLibre/Leaflet behavior where their semantics are relevant.
- `runtime-profiler` scenarios that capture immutable reference/candidate evidence.
- Moonlight evaluation of semantic and performance evidence through neutral `agent.evidence/v1` / `agent.evaluation-result/v1` boundaries.
- Exact-head CI that reuses the exact validated build/evidence artifacts instead of recomputing them downstream.
- An explicit foundation seam check for work that touches genuinely 3D math/camera, generic spatial structures, assets/evidence infrastructure, or a proposed new cross-project renderer contract.

Exit criterion: one named Maps scenario can be executed against an immutable reference and candidate, profiled with strictly comparable evidence, and evaluated by Moonlight without bespoke one-off glue.

## Milestone B — Independent Map Runtime

Build a complete Rust-owned geographic camera, interaction and raster-tile runtime rather than isolated camera experiments.

Deliverables:

- Web Mercator projection and world wrapping.
- Canonical geographic camera state: center, zoom, bearing, pitch, viewport.
- Project/unproject and fit-bounds semantics.
- Visible-world and visible-tile calculation.
- Drag, wheel, pinch/touch, resize and kinetic camera transitions through a thin browser input adapter.
- Canonical XYZ tile identity, overzoom and world-copy behavior.
- Source scheduling, cancellation, request deduplication, bounded cache and deterministic eviction.
- Raster source loading and Canvas2D rendering.
- MapLibre-free `MapView` mode with point/GeoJSON overlays.
- For perspective/pitched work that genuinely needs 3D view mathematics, Maps-owned conversion from precise geographic/Mercator state into a stable local render frame may be followed by reuse of `3d-lab` camera/matrix primitives where their contracts are suitable. Do not force ordinary 2D map camera/projection through a 3D foundation, and do not add a second general-purpose 3D camera/math stack to Maps.

Exit criterion: a useful `MapView` renders and interacts with raster basemaps and application data with no MapLibre instance or runtime dependency in the execution path. This is Leaflet-class independence v1.

## Milestone C — Maps Rendering Platform

Generalize the Maps-owned render architecture into a complete flat-map rendering platform.

Deliverables:

- Typed render batches for points/clusters, lines, polygon fills/strokes, raster quads, flows and scalar/heat surfaces.
- Stable Maps-owned feature and picking identity.
- Canvas2D as the deterministic correctness/reference backend.
- wgpu resource lifetime, packed buffers, dirty-range updates, batching, map-specific reusable pipelines, viewport uniforms and GPU picking.
- Device-loss handling and deterministic Canvas fallback.
- Measured renderer selection using canonical scenarios rather than "WebGPU whenever available".

The wgpu backend is allowed to own the GPU surface/device/queue and map-specific pipelines/textures because it is a Maps pixel backend. It must not become a general scene graph, transform hierarchy, asset system, camera authority or second 3D engine. Extract shared GPU infrastructure only when a concrete second consumer demonstrates a stable generic contract.

Exit criterion: the complete Leaflet-class feature set renders without MapLibre; Canvas2D and wgpu consume the same map-domain render model.

## Milestone D — Vector Map Engine

Build the vector-tile and style pipeline required for practical MapLibre replacement.

Deliverables:

- MVT decoding in Rust.
- Vector-source lifecycle integrated with the tile scheduler/cache.
- MapLibre Style Specification compatibility where practical rather than a proprietary style language.
- Background, fill, line, circle and raster layers first.
- Filters, zoom expressions, data-driven properties, ordering, opacity and visibility.
- Geometry clipping/transformation and typed render buckets.
- MapLibre reference fixtures evaluated through the canonical scenario/evidence system.

Exit criterion: a normal vector street/map style can run on the first-party engine without MapLibre runtime involvement.

## Milestone E — Cartography Engine

Implement the symbol and label system required for high-quality maps.

Deliverables:

- Font/glyph acquisition and shaping.
- Glyph and sprite atlases.
- Point and line symbol candidates.
- Variable anchors and collision detection.
- Cross-tile symbol identity and stable placement during pan/zoom.
- Icon/text render batches and WebGPU rendering.
- Label-heavy compatibility and performance scenarios.

Exit criterion: the engine can produce visually credible city/street cartography rather than only vector geometry.

## Milestone F — Advanced Maps Platform

Build advanced capabilities only after the flat-map foundation is strong.

Candidates:

- terrain and DEM processing;
- globe projection;
- 3D extrusion and advanced map-native 3D;
- offline packages;
- native/Tauri hosts;
- extreme-scale datasets;
- advanced temporal mapping.

Advanced work starts with an authority review across Maps, the existing 3D foundations, geo-analysis and asset-tooling. Maps owns geographic/cartographic meaning; shared repositories own their generic primitives. Do not start terrain, globe, extrusion, scene/camera, mesh or asset work by creating a minimal Maps-local substitute for an existing foundation.

## Evidence architecture

The development loop is:

```text
coding-tooling
  discovers deterministic capabilities + named scenarios
        |
        v
runtime-profiler
  captures immutable reference/candidate runtime evidence
        |
        v
Moonlight
  evaluates semantic/performance policy
        |
        v
exact-head CI
  integrates or rejects the candidate
```

`runtime-profiler` owns capture, normalization, validation and immutable evidence. Moonlight owns comparison thresholds and pass/fail/inconclusive policy. Maps owns representative scenarios and map-specific semantic comparison adapters, but must not fork profiler or evaluator responsibilities.

## Canonical scenario families

The scenario corpus should grow by representative workload family, not by implementation detail:

- camera/world: pan, zoom, resize, bearing/pitch, antimeridian, fit-bounds;
- raster tiles: cold start, warm cache, rapid pan/cancellation, overzoom, world copies;
- point density: 10k, 100k and 1M datasets where CI capacity permits;
- geometry: dense lines/polygons, clipping, editing and hit testing;
- vector tiles: decode, style evaluation, bucket building and tile churn;
- labels: dense city labels, line labels, collisions and zoom transitions;
- interaction: selection, hover, context, editing and picking;
- temporal: playback, transitions and changing geometry;
- constrained runtime: memory pressure, device loss and unsupported-backend fallback.

A scenario identity must remain stable enough to compare baseline/candidate evidence. Extend an existing scenario instead of creating a bespoke benchmark when it represents the same workload.

## Program rules

1. Roadmap units represent durable subsystem ownership, not the smallest mergeable edit.
2. Prefer foundation PRs that establish coherent contracts plus representative end-to-end behavior. Do not manufacture one issue per internal class or function.
3. One semantic authority per concern. Never maintain independent geographic truth across Rust, TypeScript and renderers.
4. Rust determines map-domain results. Browser renderers turn prepared Maps data into pixels and picks.
5. React owns composition/lifecycle, never map semantics or per-frame geographic computation.
6. WebGPU is an optimization backend, never a second map engine.
7. Preserve `@moritzbrantner/maps/core` as server-safe and data-only.
8. Keep public APIs stable where practical, but do not preserve an abstraction that prevents correct engine ownership.
9. Compatibility changes require normalized reference evidence before authority transfer or removal of the previous path.
10. Keep MapLibre as a reference/fallback until each responsibility has independently proven replacement behavior; remove it deliberately rather than by drift.
11. Use established standards (XYZ, GeoJSON, MVT and MapLibre Style Specification where practical) instead of inventing proprietary equivalents.
12. Runtime claims require comparable evidence. Missing or incomparable profiling is unavailable/inconclusive, never green.
13. Measure the costs that architectural choices can move: frame-time distribution, long tasks/main-thread work, memory, WASM bridge cost, GPU upload cost, picking latency and source-level hotspots where supported.
14. Compute once and reuse exact validated artifacts/evidence across downstream jobs.
15. Before implementing generic **3D** camera/matrix/spatial, asset or evidence infrastructure locally, inspect the existing lower-level repositories and reuse or improve the established authority when one exists. Treat 2D map camera/projection and map-specific render planning as Maps concerns unless a separate shared contract has been proven.
16. Reuse lower-level foundations through narrow adapters. Do not let a generic scene/visualization/3D layer become the semantic authority for Maps.
17. Promote implementation authority only after deterministic parity and representative performance evidence; once promoted, fail closed rather than silently switching authorities mid-session.
18. Keep fallback boundaries explicit and testable (SSR/no-WASM/no-WebGPU/device loss) instead of sprinkling best-effort fallback throughout semantic code.
19. Delete superseded implementations and stale benchmark harnesses after their replacement is proven; convergence is part of the milestone, not optional cleanup.
20. Do not create a new shared abstraction for hypothetical reuse. Extraction requires a concrete second consumer and a contract that removes duplicated correctness logic rather than only boilerplate.
21. Treat `2d-lab` as a 2D rendering evidence lab. Products consume findings by default; a shared production 2D renderer requires a separate promotion decision and must not make the lab workload/display-list model authoritative.
