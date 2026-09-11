# Public API boundary

The first-party engine should normally preserve the existing `MapView`/layer-oriented application API while internal ownership changes. Compatibility is not absolute: if a public abstraction would force duplicated authority or leak MapLibre internals into the first-party engine, change it deliberately through normal API review rather than preserving a structurally wrong boundary.
