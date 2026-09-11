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

Read `docs/engine-roadmap.md` before changing camera, projection, tiles/sources, rendering, vector-tile/style, cartography, or engine evidence infrastructure. ADR 0006 records the architectural decision; `docs/engine-scenarios.md` and `docs/engine-evidence.md` define the shared evidence model.

For this program:

- roadmap units represent durable subsystem ownership, not the smallest mergeable edit;
- keep one semantic authority per concern across Rust, TypeScript and renderers;
- Rust owns map-domain results; React owns composition/lifecycle; Canvas/WebGPU own pixels/picking;
- keep `@moritzbrantner/maps/core` server-safe/data-only;
- MapLibre/Leaflet are reference/fallback implementations at explicit edges, not permanent architectural owners;
- `runtime-profiler` captures immutable runtime evidence and Moonlight owns baseline/candidate evaluation policy;
- missing/incomparable required evidence is unavailable/inconclusive, never green;
- authority transfer requires representative parity/evidence and convergence/removal of the superseded path.

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
