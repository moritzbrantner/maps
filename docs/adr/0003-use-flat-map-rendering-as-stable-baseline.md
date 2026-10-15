# ADR 0003: Keep Flat MapLibre rendering as the stable baseline

## Status

Accepted; clarified 2026-10-15 from the existing Map View implementation, [ADR 0006](0006-build-first-party-rust-wasm-map-engine.md), [ADR 0007](0007-compose-shared-lower-level-foundations.md), and [Maps #232](https://github.com/moritzbrantner/maps/issues/232). No renderer-default cutover is approved by this clarification.

## Context

Applications need reliable Flat Map rendering, interaction and editing while the first-party engine is still completing application parity. MapLibre GL JS is the established external renderer; the first-party Rust/WASM runtime is an intentional replacement candidate, not yet a blanket substitute. Globe and engine-backed paths have narrower guarantees than the stable Flat Map baseline. The legacy private Three/WebGL flat runtime has separate retirement work in [#104](https://github.com/moritzbrantner/maps/issues/104).

The public [MapView](../../src/map-view.tsx) already exposes the narrow choice: omitted `flatRuntime` selects `"maplibre"`, while `flatRuntime="maps"` selects the first-party Flat Map path. The package currently declares `maplibre-gl` version `6.4.1` in [package.json](../../package.json). A demonstration may default to the candidate for diagnostics, but that does not change the public Map View default.

## Decision

1. **Retain the proven default.** Flat MapLibre-backed rendering remains the default and the supported reference/fallback while the first-party runtime is incomplete. New public map behavior must be correct on this baseline before narrower modes can claim parity. Do not silently change consumer defaults or treat a successful standalone engine demo as a production cutover.
2. **Compare through the existing public seam.** Use `MapView.flatRuntime="maplibre" | "maps"` for real-consumer comparisons. Keep domain data and intended camera/selection journeys identical. Do not add a new provider framework, a second map-domain model, a hidden MapLibre instance behind `"maps"`, or a consumer-specific clone of Maps semantics. Unsupported Maps-only operations must be disclosed, not simulated with reference-engine internals.
3. **Preserve semantic ownership.** Under ADRs 0006–0007, Maps Rust owns first-party geographic and map-domain results; React owns composition; Canvas2D/WebGPU own pixels and picking. MapLibre is an external reference and usable fallback, not the first-party engine's permanent semantic authority. Reuse existing lower-level foundations at their established boundaries.
4. **Require comparable, consumer-relevant evidence.** Use the canonical engine scenarios, MapLibre reference adapters, browser journeys, and [engine evidence contract](../engine-evidence.md). Compare correctness (visible features, camera, picking, selections and supported layer behavior), then representative startup/navigation/interaction latency, memory, JS/WASM bridge, resource retention and fallback. Record exact commits/versions and unavailable capabilities. The existing [renderer comparison](../../demo/RendererComparison.tsx) and [benchmark page](../../demo/BenchmarksPage.tsx) are diagnostics, not themselves a Moonlight verdict or evidence of full consumer parity.
5. **Promote deliberately and converge.** Change a supported consumer to `"maps"` by default only after its actual requirements pass Developed → Correct → Fast, representative browser acceptance confirms the real journey, and the owner approves that consumer's cutover. [#176](https://github.com/moritzbrantner/maps/issues/176) owns broader package/application promotion. Retire superseded responsibilities when proven, but keep useful reference/fallback boundaries; do not maintain duplicate semantic authorities indefinitely.

## Alternatives considered

- **Switch all consumers to the first-party engine now:** rejected; editor/measurement and other application features still lack established parity. A synthetic speed result cannot substitute for a working application.
- **Keep MapLibre as permanent map-domain authority:** rejected by accepted ADR 0006; first-party Rust/WASM independence remains the architectural objective.
- **Introduce another renderer abstraction or benchmark platform:** unnecessary; the public `flatRuntime` seam, existing comparison pages, canonical Maps scenarios, runtime-profiler and Moonlight already define those responsibilities.

## Evidence and current limits

- [Maps #232](https://github.com/moritzbrantner/maps/issues/232) tracks reproducible comparison using the existing real-consumer journeys: [Historical Source Atlas #63](https://github.com/moritzbrantner/historical-source-atlas/issues/63) (source-location map) and [Church Atlas #8](https://github.com/moritzbrantner/church-atlas/issues/8) (site discovery). Each consumer owns its renderer selector, URL state and domain experience; Maps owns shared map semantics and comparative engine evidence.
- [Maps #170](https://github.com/moritzbrantner/maps/issues/170) owns first-party Map View composition/interaction parity; [#176](https://github.com/moritzbrantner/maps/issues/176) owns complete application parity and cutover. The current first-party [MapsMapView](../../src/maps-map-view.tsx) explicitly rejects MapLibre-only callbacks and unsupported editor/measurement registration. These are gaps, not reasons to bypass the public API.
- The [benchmark lab](../../demo/BenchmarksPage.tsx) includes first-party Maps, Canvas2D, Leaflet and MapLibre lanes. Its local measurements are descriptive; [engine performance notes](../engine-performance.md) contain dated, bounded observations, not a fresh all-consumer comparison or a release verdict.
- Current historical-source-atlas usage of `MapView` has no explicit `flatRuntime` prop. Its installed package support for the candidate must be verified by that consumer before publishing a selector, as required by its issue #63.

## Revisit when

A named consumer has exact-version parity evidence and a proposed, owner-approved default switch; the first-party engine's supported scope changes; or measured maintenance/performance/compatibility costs justify revisiting the fallback. If the candidate does not meet a consumer's needs, continue using MapLibre without treating the experiment as failed product delivery.
