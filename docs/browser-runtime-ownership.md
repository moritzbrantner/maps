# Browser runtime and retained Map Layers

`maps-browser-runtime.ts` owns the imperative browser host. `canvas-flat-runtime.tsx`
is its React lifecycle adapter, not the input/frame engine. The host and native
layer preparation bundle without a runtime import of React or React DOM.

## Ownership and lifetime

Rust remains authoritative for camera, projection, constraints, tile identity,
scheduling and map-domain results. The browser host owns canvases, listeners,
ordered input commands, animation scheduling, fetch/ImageBitmap lifetime and the
existing Canvas/WebGPU pixel backends. React publishes committed configuration
through layout effects and subscribes for controls and feature UI.

`createMapsBrowserRuntime(baseCanvas, fallbackCanvas, options)` returns a host
with `ready`, `controller`, `update` and idempotent `dispose`. This is an internal
boundary, not a new package export. Raster source, max bounds and WASM identity
are fixed per host lifetime; the React adapter replaces the host when they change.
Camera/configuration updates committed while loading are applied before the first
ready notification. An abandoned React render cannot publish a new callback to an
already-running host. A disposed controller rejects camera/project commands.

A stable public React controller facade delegates to current committed actions;
camera changes do not recreate it or emit `onMapControllerReady` again. Camera
notifications and lifecycle notifications are separate. The facade does not
become a second camera: its getters consult the current Rust runtime.

## Native layer invalidation

`maps-native-layer-runtime.ts` is shared by the React Map Layer adapter and the
plain-browser acceptance fixture. It reuses the existing point/flow preparation
algorithms extracted to data-only modules. Datasets, coordinates and semantic
accessors are treated as immutable: replace their identity when their meaning
changes; mutating a closure's captured values without changing the accessor is
not an invalidation signal.

- Point data/filter changes rebuild normalized features. Radius, color and ID
  accessors invalidate prepared paint/identity, not the source normalization.
- Flow data/weight/width changes rebuild weighted features. Shape values invalidate
  paths. Color/ID changes invalidate paint/identity without rebuilding paths.
- Hover/selection change interaction paint and selected widths, not point filters,
  flow weights or path coordinates. Previously presented primitives are immutable.
- Camera/viewport changes invalidate screen coordinates only. Weak geometry caches
  retain projection across paint-only replacements with the same coordinates.
- Layer removal releases retained native data. The adapter refreshes interaction
  callbacks even when identical screen primitives allow it to skip pixel submission.

Cluster queries are retained for identical geographic bounds and zoom. GeoJSON
retains its existing independent preparation boundaries. Heat/raster rendering is
not subject to the unchanged-vector-frame submission shortcut.

## Verification

`maps-runtime-ownership.test.tsx` covers committed startup updates, speculative
React renders, controller lifetime, cancellation during WASM/GPU initialization,
resource disposal, updated fit options and controlled-map echo suppression.
`maps-native-retention.test.tsx` counts work for 1k/10k points and arc/S-curve flows.
`maps-native-layer-runtime.test.ts` covers data/paint/path/identity invalidation,
projection and picking parity, immutable frames, removal and the no-React import
boundary. Existing camera-presentation tests retain gesture/fallback coverage.

`e2e/maps-runtime-performance.spec.ts` exercises real Rust/WASM and WebGPU or
Canvas with a controlled React consumer and a standalone browser consumer.
Correctness ratchets assert work counts, alignment and picking, not elapsed time.
The retained screenshot is exactly the map-local image whose pixels passed the
visibility assertion. The standalone fixture also rejects React network imports.

An observational test records synchronous camera preparation/submission CPU
samples for 10k native points and 100 arcs under `camera-world-pan-v1`. These
samples are descriptive, not GPU completion, input-to-photon latency, FPS, a
MapLibre comparison or a Moonlight performance verdict. Shared runtime-profiler
and Moonlight remain the authorities for comparable profiling and evaluation.

## Remaining boundaries

The React UI context still exposes camera and hover state to existing consumers;
this is not the complete cross-MapLibre subscription split in issue #119.
Heat-layer registration, GeoJSON composition and the demo Shortbread source hook
retain their existing React adapters. No claim is made that every source/Map Layer
can now be registered through a public framework-independent API, or that cached
GPU vector tiles / batched geographic projection are implemented by this change.
