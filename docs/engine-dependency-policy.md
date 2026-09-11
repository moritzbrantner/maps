# Engine dependency policy

Prefer standards-compatible, well-bounded primitives over wholesale runtime ownership by dependencies. Reuse lower-level geo/kernel crates where they reduce duplicate correctness logic. Renderer, tile, style and cartography dependencies must remain replaceable implementation details behind Maps-owned contracts unless a separate decision explicitly adopts their public contract. Do not introduce another generic visualization engine.
