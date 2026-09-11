# React boundary

React components compose map sources/layers, connect application state and own browser component lifecycle. Per-frame projection, geographic normalization, clustering, tile selection, style evaluation and other map-domain computation do not move into React merely because the public API is React-based. React render frequency must not become an engine clock.
