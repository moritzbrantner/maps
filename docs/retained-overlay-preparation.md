# Retained GeoJSON overlay preparation

GeoJSON normalization, semantic-frame preparation, screen projection, and interaction updates now have separate invalidation boundaries inside the existing Maps overlay owner. This extends the normalization cache from PR #133; it does not introduce another scene authority or move projection mathematics out of Rust.

| Update                                           | Normalization and anchors | Semantic frame | Projection                          |
| ------------------------------------------------ | ------------------------- | -------------- | ----------------------------------- |
| Hover, selection, tooltip, event handler         | Retained                  | Retained       | Retained                            |
| Camera callback or viewport dimensions           | Retained                  | Retained       | Recomputed                          |
| Geometry style, identity or eligibility callback | Retained                  | Recomputed     | Recomputed                          |
| Feature collection replacement                   | Recomputed                | Recomputed     | Recomputed                          |
| Layer removal                                    | Released                  | Released       | Weakly held keys become collectable |

The cache is private to the overlay implementation. Feature collections and geometry are immutable inputs, consistent with the existing React layer contract. Replace the collection when data changes. Replace callbacks when their captured style, ID or eligibility policy changes; stable callbacks permit reuse. A camera-dependent style must receive a changed callback when its camera dependency changes. Projection callbacks are versioned by camera state in MapsMapView; viewport resize also invalidates projected coordinates.

Fresh interaction closures always capture the latest surface and handler props. Reordering layers preserves painter order and reverse-order picking. Invalid projection still rejects the entire primitive, including polygons with holes. Cached invalid results are retried after camera/size invalidation. Removing all overlays prunes the cache even though no canvas remains to draw.

## Evidence

Component tests use 1,000- and 10,000-coordinate lines and count projection, style and anchor calls. Pointer-only updates must add zero calls; camera and data changes must invalidate the appropriate stage. Projector tests compare retained scenes with the existing uncached projector and cover painter order, holes, changed primitives, resize and invalid-projection recovery. The browser fixture in e2e/fixtures/overlay-retention.html exercises real Canvas pointer hover, selection, camera invalidation and removal/restoration and captures a screenshot.

These are deterministic work-count contracts, not FPS claims. The slice retains GeoJSON preparation and projection; it does not remove all interaction-map iteration, Canvas redraws, GPU frame packing, or work in Point/Flow/Cluster layers. Broader context splitting remains tracked in #119.
