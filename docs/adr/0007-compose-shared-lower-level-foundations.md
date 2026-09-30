# ADR 0007: Compose shared lower-level foundations

## Status

Accepted; clarified 2026-09-19.

## Context

ADR 0006 makes `maps` a first-party Rust/WASM map engine. "First-party" means Maps owns map-domain semantics; it does not mean Maps should grow private copies of generic foundations that already exist elsewhere in the workspace.

The repository already consumes `moenarch-geo-core` for generic geo primitives and uses `runtime-profiler`, Moonlight, and `coding-tooling` at explicit evidence boundaries. The wider workspace also has 3D foundations in `3d-lab` (`three-d-core`, `three-d-animation`, `three-d-camera`, and `three-d-spatial`), asset generation/provenance in `asset-tooling`, and a Rust/WASM 2D rendering decision lab in `2d-lab`.

The next camera/rendering work has two opposite risks: duplicating genuinely generic 3D/spatial foundations inside Maps, or forcing Maps-specific 2D rendering into a shared lab/foundation merely because some machinery looks reusable. This ADR draws that seam explicitly.

## Decision

Maps is a product/domain engine built on lower-level foundations where those foundations already own the generic concern.

### Maps remains authoritative for map semantics

`maps-core` owns:

- geographic camera meaning: longitude, latitude, zoom, bearing, pitch, viewport and map constraints;
- Web Mercator projection, world wrapping and geographic project/unproject behavior;
- map bounds, tile cover, tile/source scheduling, cancellation and cache policy;
- map feature/layer identity, style/cartography semantics, label placement and map-specific picking identity;
- map-specific render preparation and the deterministic conversion from geographic state to renderer inputs.

No lower-level rendering or 3D repository becomes the semantic authority for those concerns.

### Reuse renderer-independent 3D math instead of cloning it

When Maps needs genuinely 3D vector, transform, view-matrix, perspective-projection, camera-basis, or related 3D machinery, first reuse the existing `3d-lab` Rust foundations where their contracts match. Ordinary flat-map camera/projection and map-specific render planning remain Maps-owned.

For the matrix-backed Maps camera specifically:

1. `MapCamera` remains the single geographic camera model.
2. Maps performs the map-specific conversion from geographic/mercator state into a stable local render coordinate frame.
3. Shared 3D primitives perform generic camera/view/projection mathematics only where the view is genuinely 3D and their precision and contract are suitable.
4. Maps converts the resulting renderer-neutral matrix/state into Canvas/wgpu inputs.

Do not add a private general-purpose `Mat4`, `Vec3`, `PerspectiveCamera`, 3D scene graph, transform hierarchy, or equivalent abstraction to Maps merely to complete a genuinely 3D map feature. This does not require ordinary 2D map camera/projection math to move out of Maps.

If the shared 3D API is missing a required generic primitive, improve or extract that primitive at the shared boundary first. A narrow Maps adapter is preferred over a forked implementation.

Precision is part of the boundary: geographic/world calculations remain in the precision required by Maps. Shared `f32` camera/matrix primitives may be used only after Maps has rebased into a numerically safe local frame; they must not replace authoritative `f64` geographic state.

### Keep the wgpu backend map-specific

Maps may own wgpu surface/device/queue integration, map-specific shaders, tile textures, map render batches, GPU picking and fallback/recovery behavior because those are the pixel backend for Maps-owned render frames.

Do not turn that backend into another general renderer or 3D engine. Extract generic GPU infrastructure only when there is a concrete second consumer and the shared contract removes duplicated correctness logic rather than merely deduplicating boilerplate.

### Respect the other workspace authorities

- `moenarch-geo-core` / `geo-analysis`: generic geospatial geometry and algorithms. Maps owns map-product semantics layered on top.
- `3d-lab`: genuinely 3D mesh/transform/camera/spatial primitives. Maps consumes or extends those through narrow adapters only where the concern is actually 3D; it does not move flat-map camera/projection or GIS/map semantics into them.
- `asset-tooling`: generated/static asset production, provenance and reproducibility for future map-native 3D/cartographic assets. It does not own live map sources or runtime tile state.
- `2d-lab`: 2D Rust/WASM renderer experiments, representative workloads and performance evidence. Maps consumes findings by default, not the lab's `BenchmarkWorkload` or display-list model as a runtime contract. It does not own geographic camera, tile, style, label, interaction or map render-planning semantics.
- `runtime-profiler`, Moonlight and `coding-tooling`: evidence capture, evaluation policy and deterministic capability discovery respectively, as defined by ADR 0006.

## Foundation seam check

Before implementing a new Maps subsystem, explicitly classify the work:

1. **Map semantic** — implement in Maps.
2. **Existing generic foundation** — consume it through a narrow adapter.
3. **Missing generic primitive with multiple real consumers** — improve/extract the shared foundation before building a Maps-private substitute.
4. **Maps-specific renderer/backend detail** — keep it local, but do not let it acquire semantic authority.
5. **Speculative reuse only** — keep it local until a real second consumer exists; do not create a generic framework for hypothetical reuse.

The seam check is especially required before adding genuinely 3D camera/matrix math, generic spatial structures, asset pipelines, or a proposed new cross-project renderer contract. Maps-specific 2D renderer lifecycle and render planning may remain local when they carry map-specific leverage.

## Consequences

- The first-party Maps engine remains genuinely Maps-owned without becoming self-contained for its own sake.
- Perspective/3D camera work should reuse or deliberately extend shared `3d-lab` primitives where the contracts fit; ordinary flat-map camera/projection remains Maps-owned.
- Current map-specific wgpu rendering remains valid: pixel-backend code may stay local when it is map-specific, and `2d-lab` experiments do not create a runtime dependency or authority transfer.
- Future globe, terrain, extrusion and 3D-overlay work must begin with an authority review across Maps, `3d-lab`, geo foundations and asset tooling rather than starting from a minimal local implementation.
- Cross-repository dependencies must be explicit and pinned/reproducible; dependency convenience is never a reason to duplicate an existing correctness authority.
