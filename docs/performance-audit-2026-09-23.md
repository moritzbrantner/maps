# Maps performance and architecture audit — 2026-09-23

Reviewed main `9e80522d9c64d86154133632ec781dcb8c135e11` and the existing
retained-geometry work in PRs #133 and #134. This is a source-level audit with
executed deterministic picking evidence, not a measured ranking of end-to-end
frame-time bottlenecks. Existing issues remain the owners of the larger changes.

## 1. Separate geometry, camera and interaction invalidation

**Observed:** `src/maps-overlay-layers.tsx`'s draw effect depends on `surface` as
well as camera-related callbacks and layer entries. Every draw calls
`createOverlaySnapshot` and `createCanvasMapScene`, rebuilding semantic wrappers,
interaction maps and projected geometry. The Canvas path additionally builds a
primitive-ID lookup. PR #133 caches GeoJSON normalization, but its draw path still
rebuilds the projected frame.

**Change direction:** finish #119's focused subscriptions and give retained layer
geometry, projection and interaction paint separate invalidation boundaries.
Hover must update hover visuals, but should not normalize, cluster, reproject or
repack unchanged geometry. Camera changes invalidate screen positions, not source
geometry. Data/style changes must invalidate every affected derived resource.
Callbacks with data- or zoom-dependent styling need explicit dependencies; a
stable FeatureCollection identity alone is not a universal cache key.

**Proof required:** deterministic counts for normalization, viewport queries,
projection and buffer packing on hover-only, camera-only and data/style updates.
Preserve controlled camera behavior, callback freshness, context restoration,
heat-layer lifecycle and device-loss fallback. Do not use ref tricks to suppress
necessary visual updates, blanket memoization, a global store, or CQRS in the hot
path. Owner: #119 with #78/#60 for retained renderer resources.

## 2. Batch projection across the Rust/WASM boundary

**Observed:** `projectCoordinates` in `src/canvas-map-renderer.ts` calls the
projection callback once per coordinate. The controller in
`src/canvas-flat-runtime.tsx` forwards each call to `runtime.project`; the wrapper
in `src/flat-runtime-wasm.ts` forwards it to WASM and returns a coordinate pair.
`src/wgpu-application-frame.ts` then walks the screen frame to build per-kind
transport arrays and resolve colors/interaction stroke widths.

**Change direction:** a Maps-owned batch projection API, using packed coordinate
buffers and a single authoritative camera snapshot, is a better next boundary
than adding more per-coordinate wrappers. Return projected positions plus an
explicit validity representation. Preserve whole-primitive invalid-projection
rejection, wrapping, bearing/pitch and geographic precision. Do not duplicate
Mercator or camera math in JavaScript or shaders to avoid a bridge call.

Measure projection computation separately from crossings, transport and uploads.
Longer-term retained Rust geometry can remove more round trips, but typed arrays
alone do not prove zero-copy transport or an improvement. Integrate this under
#60/#78 rather than inventing a generic rendering framework.

## 3. Boolean picking should not compute a full minimum

**Corrected in this change; issue #140.** The previous picker evaluated every
segment of a candidate line before testing its minimum distance against the
pointer tolerance. A hit on the first segment still traversed the whole line.
Nondegenerate segment checks also explicitly constructed closest-point objects.

The picker now stops at the first segment within tolerance and uses scalar
closest-point distance arithmetic. Reverse primitive order, identity, circle hit
radius, line tolerance, zero-length segments, polygon closure, even-odd holes and
hole-stroke picking remain covered. No cache over mutable geometry was introduced.
The existing picker is also used while wgpu produces the application pixels.

Deterministic red/green fixtures measure projected-point array accesses:

| First-segment hit | Before | After |
| --- | ---: | ---: |
| 1,000 segments | 2,000 | 2 |
| 10,000 segments | 20,000 | 2 |
| 100,000 segments | 200,000 | 2 |

These counts demonstrate removed work, not an FPS claim. Complete misses remain
linear; polygon fill testing still traverses rings. If misses dominate real
pointer traces, the next step is an explicitly prepared screen-frame broad phase
with correct bounds/tolerance invalidation, not an implicit cache keyed only by a
mutable object's identity. Reuse an existing generic spatial foundation if a
full index is justified; do not create an unrelated spatial engine.

## 4. Keep and finish the existing retained-tile work

PR #133 addresses normalization/allocation churn. PR #134 builds Rust-decoded,
tile-local wgpu geometry instead of routing the basemap through geographic
JavaScript objects and back into Rust. That is the right resource-lifetime
direction: retain tile geometry, update placements/camera, and release resources
on eviction or renderer loss.

Both PRs were open at review time. Their existence is not integration or runtime
performance proof. Review them against current main's newer polygon-fill and tile
lifecycle changes; preserve the explicit Canvas fallback and use representative
tile-churn, overzoom, world-copy, memory and upload evidence before integration.
Do not fork another basemap cache implementation in a new PR.

## 5. Whole-frame fallback limits mixed-workload GPU coverage

**Observed:** `createMapsWgpuApplicationFrame` returns `null` for a polygon, and
`MapsOverlayLayers` disables the application wgpu path when a raster render step
is present. A mixed application frame therefore falls back as a unit, even if
many of its primitives are otherwise GPU-supported. This does not necessarily
turn off the independent GPU basemap.

This is a deliberate correctness boundary, not permission to silently drop holes,
reorder layers, or force GPU rendering. The durable improvement is hole-correct
polygon support on the existing backend (#60/#78). Any intermediate mixed-backend
plan must preserve exact interleaved draw order and interaction identity; simply
putting every supported primitive on one canvas and every unsupported primitive
on another is not generally equivalent. Measure mixed workloads before changing
renderer selection.

## 6. Converge runtime ownership rather than creating another engine

#104 already owns retirement of the legacy Three/WebGL flat runtime after Maps
runtime parity. The dependency surface still includes Three and MapLibre. Keep
MapLibre at explicit reference/fallback edges; remove the duplicate first-party
flat authority when its migration evidence is complete. Bundle/startup gains
need entrypoint-specific measurements, not inference from package dependencies.

Retain Rust authority for map semantics, geographic precision, camera, projection
and tiles; React for composition/lifecycle; backends for pixels/picking. Do not
add a production dependency on 2d-lab, generic scene authority, or speculative
worker architecture. A worker is worth evaluating only after measured bridge and
main-thread work identify a coherent ownership boundary.

## Validation and next order

The nine new picking tests ran locally against the real production module using
Node's TypeScript stripping. For that standalone run, only the test-runner import
was changed from Vitest to `node:test`, and the runtime import gained `.ts`.
The three scaling tests failed against the exact original source blob and passed
after the change; all nine passed, including 5,000 seeded oracle queries and
late-hit, complete-miss, geometry/style/camera/eligibility invalidation cases.
This is not a claim that Vitest, browser smoke or `verify:agent` ran locally:
Bun, repository dependencies and Rust were unavailable, and GitHub DNS failed.

Recommended order: integrate the picking correction after required checks;
reconcile #133/#134 with current main; implement #119 with retained-geometry
invalidation; then add batched projection and supported mixed-frame GPU coverage
under #60/#78. Use the canonical runtime-profiler/Moonlight path for timings,
bridge/upload bytes, memory and representative user journeys; do not introduce
wall-clock assertions into correctness CI.
