# Label/cartography boundary

The cartography engine owns deterministic shaping inputs, symbol candidate generation, collision/placement and cross-tile symbol identity. Renderer backends consume positioned glyph/icon batches. Font/sprite asset acquisition may use shared asset tooling, but asset tooling does not decide map label placement or style semantics.
