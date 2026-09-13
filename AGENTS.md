# Agent Development Contract

This repository uses red/green development, but substantial engine work is organized around durable subsystem foundations rather than a micro-slice treadmill. Keep iterations testable and reviewable while ensuring each implementation body connects to a coherent runtime/evidence outcome.

## Agent skills

This repository is configured for the Matt Pocock workflow skills and the agent-loop control plane.

- Issue tracker: `docs/agents/issue-tracker.md`
- Triage labels: `docs/agents/triage-labels.md`
- Domain context: `docs/agents/domain.md`
- Planning workflow: `docs/agents/planning-workflow.md`

### Planning workflow

Substantial new work should be planned into GitHub PRD/milestone issues instead of implemented as unconnected edits. See `docs/agents/planning-workflow.md`.

### First-party engine program

Read `docs/engine-roadmap.md` before changing camera, projection, tiles/sources, rendering, vector-tile/style, cartography, or engine evidence infrastructure. ADR 0006 records the first-party Maps decision. ADR 0007 records how that decision composes existing lower-level workspace foundations. `docs/engine-scenarios.md` and `docs/engine-evidence.md` define the shared evidence model.

For this program:

- roadmap units represent durable subsystem ownership, not the smallest mergeable edit;
- keep one semantic authority per concern across Rust, TypeScript and renderers;
- Rust owns map-domain results; React owns composition/lifecycle; Canvas/WebGPU own pixels/picking;
- keep `@moritzbrantner/maps/core` server-safe/data-only;
- MapLibre/Leaflet are reference/fallback implementations at explicit edges, not permanent architectural owners;
- `runtime-profiler` captures immutable runtime evidence and Moonlight owns baseline/candidate evaluation policy;
- missing/incomparable required evidence is unavailable/inconclusive, never green;
- authority transfer requires representative parity/evidence and convergence/removal of the superseded path.

#### Foundation seam check

Before adding a new engine subsystem or generic helper layer, classify the work before implementation:

1. **Map semantic** — implement it in Maps and keep Maps authoritative.
2. **Existing generic foundation** — consume it through a narrow adapter instead of duplicating it locally.
3. **Missing generic primitive with multiple real consumers** — improve or extract the shared foundation before adding a Maps-private substitute.
4. **Maps-specific renderer/backend detail** — keep it local, but do not let it acquire semantic authority.
5. **Speculative reuse only** — keep it local and narrow until there is a concrete second consumer; do not create a framework for hypothetical reuse.

For camera/matrix, generic spatial, rendering-infrastructure, asset-pipeline, or cross-project frame work, inspect the relevant existing repositories before creating local equivalents. In particular:

- use `moenarch-geo-core` / `geo-analysis` for generic geospatial geometry and algorithms while Maps retains map-product semantics;
- reuse or deliberately extend the renderer-independent `3d-lab` Rust foundations (`three-d-core`, `three-d-animation`, `three-d-camera`, `three-d-spatial`) for generic vectors, transforms, view/projection math and spatial interoperability;
- use `asset-tooling` for reproducible generated/static asset production and provenance rather than creating a Maps-specific asset pipeline;
- use `viz-engine` only where a genuinely renderer-agnostic data/frame contract already fits; it must not own geographic camera, tile, style, label or interaction semantics.

Do not add a Maps-local general-purpose `Vec3`, `Mat4`, perspective-camera abstraction, scene graph, transform hierarchy or equivalent simply to finish a map slice when the generic primitive already exists elsewhere. If the shared primitive is almost suitable, improve the shared boundary and keep only a narrow Maps adapter.

Precision remains a Maps concern at the geographic boundary. Longitude/latitude, Mercator/world calculations and other authoritative geographic state keep the precision required by Maps. Shared `f32` camera/matrix primitives are suitable only after Maps has converted to a numerically safe local render frame; they must not replace authoritative `f64` geographic state.

The Maps wgpu backend may own its surface/device/queue, map-specific pipelines, tile textures, GPU picking and fallback/recovery behavior. Do not turn it into a generic renderer, scene engine or second camera authority. Extract common GPU infrastructure only when a concrete second consumer demonstrates a stable correctness contract rather than merely similar boilerplate.

A small PR is acceptable when needed for safe review, but avoid chains of unused scaffolding whose only value depends on many future micro-slices. Milestone progress is measured by integrated subsystem outcomes and exit criteria.

## Project Vocabulary

Read `CONTEXT.md` before naming tests or public interfaces. Use the map library
terms there: Map View, Map Layer, Convenience Map, Native Map Data, GeoJSON
Source, Map Feature, GeoJSON Feature, Flat Map, Globe Map, GeoJSON Editor,
Map-Scoped Timeline, and Map UI.

## TDD Loop

1. Pick an observable behavior or subsystem invariant that advances the current coherent implementation body.
2. Add or update the narrowest useful test/evidence for that behavior.
3. Run the narrowest red check:

   ```sh
   bun run test:tdd:run -- src/example.test.ts
   ```

   For source-driven changes, use related tests:

   ```sh
   bun run test:tdd:related -- src/example.ts
   ```

4. Implement the production change needed for green without violating the subsystem ownership contract.
5. Re-run the same command until green.
6. Refactor only while green, then re-run the same test command.
7. Continue within the same coherent foundation until it has independently useful acceptance value; do not stop merely because one helper is green.

Use watch mode when actively iterating:

```sh
bun run test:tdd -- src/example.test.ts
```

## Agent Verification

Before handing work back, run:

```sh
bun run verify:agent
```

This is the default agent gate: TypeScript, lint/static repository checks, and
the unit/integration Vitest suite with an agent-friendly reporter.

Run browser smoke tests when the change affects Map View rendering, Map UI,
MapLibre integration, pointer interactions, or demo behavior:

```sh
bun run test:browser:smoke
```

Run full package validation for release-facing changes:

```sh
bun run verify:fast
```

Run `bun run verify:rust` for Rust/WASM engine work and the canonical scenario verification once declared by the package scripts.

## Test Shape

Prefer integration-style tests that exercise real code through public exports,
rendered components, documented helpers, or stable engine contracts. Do not mock internal collaborators just to observe implementation details.

Avoid horizontal speculative rewrites. Do not write a batch of disconnected failing tests and then fill in production code afterward. Tests should advance a coherent current foundation and its representative end-to-end evidence.

Snapshot changes must be intentional. Use `bun run test:browser:update` only
after reviewing the visual diff.
