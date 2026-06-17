# Agent Development Contract

This repository is built for red/green development. Work in vertical slices:
write one failing behavior test, make it pass with the smallest production
change, then repeat.

## Project Vocabulary

Read `CONTEXT.md` before naming tests or public interfaces. Use the map library
terms there: Map View, Map Layer, Convenience Map, Native Map Data, GeoJSON
Source, Map Feature, GeoJSON Feature, Flat Map, Globe Map, GeoJSON Editor,
Map-Scoped Timeline, and Map UI.

## TDD Loop

1. Pick one observable behavior through a public interface.
2. Add or update exactly one focused test for that behavior.
3. Run the narrowest red check:

   ```sh
   bun run test:tdd:run -- src/example.test.ts
   ```

   For source-driven changes, use related tests:

   ```sh
   bun run test:tdd:related -- src/example.ts
   ```

4. Implement the minimum code needed for green.
5. Re-run the same command until green.
6. Refactor only while green, then re-run the same test command.

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

## Test Shape

Prefer integration-style tests that exercise real code through public exports,
rendered components, or documented helpers. Do not mock internal collaborators
just to observe implementation details.

Avoid horizontal slices. Do not write a batch of speculative failing tests and
then fill in production code afterward. Each test should describe behavior the
current slice is about to make real.

Snapshot changes must be intentional. Use `bun run test:browser:update` only
after reviewing the visual diff.
