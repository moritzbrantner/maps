# Own Map Computation In Maps Rust

Maps owns its map-domain computation contract directly. Deterministic geographic
work may reuse lower-level Moenarch geo crates, but those crates remain
implementation primitives rather than owners of the Maps public model.

The browser boundary is a thin Maps-owned TypeScript/WASM adapter. New Maps
functionality must not route through `@moritzbrantner/viz-engine`. Existing
`viz-engine` integration may remain temporarily only until a Maps-owned vertical
slice replaces the same behavior with parity evidence.

React and MapLibre continue to own presentation, camera behavior, browser
interaction, and rendering. Rust owns computational map results such as point
normalization, bounds, clustering, scalar fields, flows, temporal geometry, and
spatial indexes as those slices migrate.
