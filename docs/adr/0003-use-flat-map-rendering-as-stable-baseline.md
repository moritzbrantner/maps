# Use Flat Map Rendering As Stable Baseline

Flat MapLibre-backed rendering is the stable baseline for rendering and editing.
Globe and engine-backed paths are advanced display modes with narrower behavior
guarantees, so new map behavior should first be correct on Flat Maps before
being extended to those paths.
