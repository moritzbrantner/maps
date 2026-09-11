# `maps-core` boundary

`maps-core` contains deterministic map-domain contracts and computation and must remain usable without browser/React/MapLibre/Canvas/WebGPU runtime dependencies. It may model camera/projection/tile/style/render-preparation concepts when they are browser-independent. Browser device/resource objects belong in adapters outside the core crate.
