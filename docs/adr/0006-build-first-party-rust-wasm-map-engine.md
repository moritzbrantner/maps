# ADR 0006: Build a first-party Rust/WASM map engine

## Status

Accepted.

## Context

Maps already owns its public React API, map-domain dataset/layer runtime, authoritative Rust/WASM point aggregation, a Maps-owned point/cluster render frame, and a Canvas2D reference renderer. MapLibre still owns camera, projection-to-screen integration, basemap/tile lifecycle and most production rendering.

The previous architecture deliberately stopped before rebuilding those MapLibre responsibilities. That constraint was useful while the Maps-owned Rust/WASM boundary was unproven, but it now prevents the project from becoming an independently useful mapping engine.

## Decision

Build a first-party Rust/WASM map engine in `maps`.

The program first targets Leaflet-class independence (camera/projection, interaction, raster tile/source/cache lifecycle and independent rendering), then MapLibre-class vector-map/cartography capabilities (MVT, style evaluation, labels/symbols), and only then advanced globe/terrain/3D capabilities.

Rust is the map-domain semantic authority. TypeScript/React is the browser/public-API host. Canvas2D and WebGPU are replaceable pixel/picking backends. MapLibre remains a reference/fallback until each responsibility is independently proven and deliberately retired.

The authoritative roadmap and development rules live in `docs/engine-roadmap.md` and epic #75.

## Consequences

- New map-engine foundations must not be shaped around permanent MapLibre ownership.
- MapLibre compatibility is evidence, not architecture.
- Roadmap units are durable subsystem foundations rather than minimal migration slices.
- `runtime-profiler` captures immutable runtime evidence; Moonlight evaluates baseline/candidate policy.
- `@moritzbrantner/maps/core` remains server-safe/data-only.
- Generic lower-level repositories may supply primitives but do not become Maps semantic authorities.
