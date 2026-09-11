# Engine ownership

- Rust core: map-domain semantic state/computation and deterministic render preparation.
- WASM boundary: transport/lifecycle only; no duplicate semantics.
- TypeScript/React: public API, browser capability loading, lifecycle, event plumbing and application state integration.
- Canvas/WebGPU: pixels and picking over Maps-owned render data.
- MapLibre/Leaflet: temporary reference/fallback at explicit edges, never new semantic ownership.
