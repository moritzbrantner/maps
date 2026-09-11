# Style boundary

Maps owns the style semantics it supports. Compatibility with MapLibre Style Specification is an input/behavior contract at the edge, not permission for MapLibre runtime objects to leak into the engine. Rust style evaluation should produce Maps-owned typed render preparation consumed by renderers.
