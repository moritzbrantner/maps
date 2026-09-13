# First-party wgpu base map

The first GPU slice keeps one geographic authority: `maps-core::MapCamera` and the flat raster runtime compute camera state, projection, tile cover, request scheduling, cancellation, cache state, and final `RasterTilePlacement` screen rectangles.

The wgpu backend is deliberately narrower. It owns the WebGPU surface/device/queue, a viewport uniform, decoded raster-tile textures, and textured-quad compositing. The viewport uniform converts the already-authoritative CSS-pixel tile placements to clip space; it is not an independent geographic camera.

The base canvas uses a device-pixel backing store, while `MapCamera` and `RasterTilePlacement` remain expressed in CSS pixels. Device pixel ratio is therefore a presentation concern of the GPU surface, not part of geographic camera state.

The browser host continues to own network fetch, `AbortController`, and `ImageBitmap` lifetime. Decoded images are retained while resident so the deterministic Canvas2D fallback can take over without refetching if wgpu is unavailable or a renderer operation fails.

The initial slice preserves the existing north-up, zero-pitch camera semantics. Bearing and pitch belong to the follow-up matrix-camera slice so Canvas2D and wgpu can consume one derived camera contract rather than growing renderer-private camera models.
