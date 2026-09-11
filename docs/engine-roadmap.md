# First-Party Maps Engine Roadmap

This document is the authoritative long-term roadmap for evolving `@moritzbrantner/maps` into a first-party Rust/WASM map engine.

The target is not "MapLibre rewritten in Rust". The target is a Maps-owned geographic engine with deterministic Rust semantics, a thin browser host, and replaceable Canvas2D/WebGPU pixel backends. The project should first reach Leaflet-class independence, then incrementally pursue MapLibre-class vector-map and cartography capabilities.

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
  - camera + projection
  - viewport + transforms
  - tile addressing + scheduling
  - tile/source cache
  - vector/raster sources
  - spatial indexes + clustering
  - geometry + topology
  - style evaluation
  - label placement
  - render preparation
    |
    v
typed Maps render frames
    |
    +--> Canvas2D reference backend
    +--> WebGPU production backend
```

## Milestone A — Engine Contract & Evidence Platform

Establish the contracts and evidence system every later subsystem uses.

Deliverables:

- Maps-owned engine vocabulary for camera, viewport, projection, tile identity, source identity, features, layers, render frames and picks.
- A canonical scenario corpus shared by correctness tests, profiling, CI and compatibility checks.
- Reference harnesses for MapLibre/Leaflet behavior where their semantics are relevant.
- `runtime-profiler` scenarios that capture immutable reference/candidate evidence.
- Moonlight evaluation of semantic and performance evidence through neutral `agent.evidence/v1` / `agent.evaluation-result/v1` boundaries.
- Exact-head CI that reuses the exact validated build/evidence artifacts instead of recomputing them downstream.

Exit criterion: one named Maps scenario can be executed against an immutable reference and candidate, profiled with strictly comparable evidence, and evaluated by Moonlight without bespoke one-off glue.

## Milestone B — Independent Map Runtime

Build a complete Rust-owned camera, interaction and raster-tile runtime rather than isolated camera experiments.

Deliverables:

- Web Mercator projection and world wrapping.
- Canonical camera state: center, zoom, bearing, pitch, viewport.
- Project/unproject and fit-bounds semantics.
- Visible-world and visible-tile calculation.
- Drag, wheel, pinch/touch, resize and kinetic camera transitions through a thin browser input adapter.
- Canonical XYZ tile identity, overzoom and world-copy behavior.
- Source scheduling, cancellation, request deduplication, bounded cache and deterministic eviction.
- Raster source loading and Canvas2D rendering.
- MapLibre-free `MapView` mode with point/GeoJSON overlays.

Exit criterion: a useful `MapView` renders and interacts with raster basemaps and application data with no MapLibre instance or runtime dependency in the execution path. This is Leaflet-class independence v1.

## Milestone C — Maps Rendering Platform

Generalize the Maps-owned render architecture into a complete flat-map rendering platform.

Deliverables:

- Typed render batches for points/clusters, lines, polygon fills/strokes, raster quads, flows and scalar/heat surfaces.
- Stable Maps-owned feature and picking identity.
- Canvas2D as the deterministic correctness/reference backend.
- WebGPU resource lifetime, packed buffers, dirty-range updates, batching, reusable pipelines, viewport uniforms and GPU picking.
- Device-loss handling and deterministic Canvas fallback.
- Measured renderer selection using canonical scenarios rather than "WebGPU whenever available".

Exit criterion: the complete Leaflet-class feature set renders without MapLibre; Canvas2D and WebGPU consume the same map-domain render model.

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

Reuse lower-level 3D, shader, geo or asset tooling only at clear primitive boundaries. Those projects do not become semantic authorities for Maps.

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
15. Reuse lower-level foundations only when they reduce duplicate correctness logic; do not introduce a generic scene-graph/visualization authority into Maps.
16. Promote implementation authority only after deterministic parity and representative performance evidence; once promoted, fail closed rather than silently switching authorities mid-session.
17. Keep fallback boundaries explicit and testable (SSR/no-WASM/no-WebGPU/device loss) instead of sprinkling best-effort fallback throughout semantic code.
18. Delete superseded implementations and stale benchmark harnesses after their replacement is proven; convergence is part of the milestone, not optional cleanup.
