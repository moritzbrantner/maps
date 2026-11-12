# GeoJSON

`PointMap`, `BubbleMap`, `ClusteredMap`, and `HeatMap` derive native marks from
`Point` and `MultiPoint` features. `FlowMap` derives flows from `LineString` and
`MultiLineString` features, using the first and last coordinate as endpoints.
Other compatible geometries can remain visible through `GeoJsonLayer` overlays.

## Validate Sources

Use `validateGeoJsonMapSource(...)` before passing user-provided GeoJSON into
map helpers.

```ts
import { validateGeoJsonMapSource } from "@moritzbrantner/maps/core";

const result = validateGeoJsonMapSource(collection, {
  metricKeys: ["demand"],
  requireFeatureIds: true,
});

if (!result.valid) {
  console.error(result.issues);
}
```

Validation reports invalid coordinates, unsupported geometries, missing feature
IDs, and nonnumeric metrics. Missing IDs and nonnumeric metrics are warnings;
invalid collections, geometries, and coordinates are errors.

## Complex Geometries

GeoJSON helpers accept `GeometryCollection` input by flattening supported child
geometries. `normalizeGeometryParts(...)` exposes the same flattening with
stable `partPath` values, and can decompose `MultiPoint`, `MultiLineString`, and
`MultiPolygon` into individual parts when `decomposeMultiGeometries` is true.

Transition helpers can opt into richer complex handling:

```ts
createGeoJsonTransitionPlan(previous, next, {
  algorithm: "topology-plan",
  partMatchingStrategy: "auto",
});
```

`complexGeometryBehavior: "preserve"` keeps existing whole-feature behavior.
`"flatten"` flattens `GeometryCollection` children. `"decompose"` also splits
multi-geometries into individual transition parts. `partMatchingStrategy:
"auto"` matches polygon parts by overlap and line/point parts by nearest
centroid, which improves reordered multipart animations.

Transition output remains a `FeatureCollection` of supported geometries; it does
not reconstruct `GeometryCollection` output. Polygon topology planning is
polygon-focused, and invalid polygon repair is limited to the existing
boolean-operation fallbacks.

## Polygon Operations

Use the GeoJSON operations helpers for planar polygon overlays and relationship
queries. Overlay operations only use `Polygon` and `MultiPolygon` geometries;
other geometries are skipped and reported through `issues`.

```ts
import {
  clipGeoJsonToPolygon,
  differenceGeoJsonFeatures,
  intersectGeoJsonFeatures,
  unionGeoJsonFeatures,
} from "@moritzbrantner/maps/geojson";

const intersection = intersectGeoJsonFeatures(parcelA, parcelB);
const merged = unionGeoJsonFeatures(selectedParcels);
const buildable = differenceGeoJsonFeatures(parcel, restrictedZones);
const clipped = clipGeoJsonToPolygon(districts, cityBoundary);

if (merged.issues.length > 0) {
  console.warn(merged.issues);
}
```

Default result properties include the operation name, source and target IDs,
source and target indexes, planar area, and source/target area ratios. Pass
`getProperties` to replace those properties. Areas are calculated in the input
longitude/latitude coordinate plane; they are not geodesic square meters.

## Polygon Measurements And Cleanup

Use the polygon helper actions when applications need derived polygon data
without adding Map UI controls.

```ts
import {
  createGeoJsonPolygonOutlines,
  getGeoJsonPolygonMeasurements,
  resolveGeoJsonPolygonOverlaps,
  simplifyGeoJsonPolygons,
} from "@moritzbrantner/maps/geojson";

const measurements = getGeoJsonPolygonMeasurements(parcels);
const outlines = createGeoJsonPolygonOutlines(parcels);
const nonOverlapping = resolveGeoJsonPolygonOverlaps(parcels);
const simplified = simplifyGeoJsonPolygons(parcels, { tolerance: 0.0005 });
```

`getGeoJsonPolygonMeasurements(...)` returns one record for each `Polygon` or
`MultiPolygon` part with planar coordinate area, approximate spherical
`areaSquareMeters`, and approximate spherical perimeter meters. Holes subtract
from area and add to perimeter. The geodesic values assume longitude/latitude
coordinates on a spherical Earth and are not ellipsoidal survey measurements.

`createGeoJsonPolygonOutlines(...)` converts polygon shells and holes into
`LineString` GeoJSON Features. Each outline includes `role: "shell" | "hole"`,
ring indexes, planar length in input coordinate units, and approximate
geodesic length in meters.

`resolveGeoJsonPolygonOverlaps(...)` reports the original overlaps and returns a
derived `FeatureCollection` with overlaps removed. The default strategy is
`"later-wins"`, so earlier polygons are trimmed by later polygons in source
order. Use `{ strategy: "earlier-wins" }` when earlier source order should take
priority.

`simplifyGeoJsonPolygons(...)` applies tolerance-based ring simplification. The
tolerance uses input coordinate units, so longitude/latitude GeoJSON uses
degrees. Rings remain closed, degenerate shells are removed, and degenerate
holes are dropped. Simplification is per feature and does not preserve shared
topology between adjacent polygons, so it can introduce small gaps or overlaps
between neighboring shapes.

## Spatial Relationships

```ts
import {
  findContainingGeoJsonFeatures,
  findOverlappingGeoJsonFeatures,
  getGeoJsonIntersections,
} from "@moritzbrantner/maps/geojson";

const intersections = getGeoJsonIntersections(existingZones, proposedZones);
const containedStores = findContainingGeoJsonFeatures(stores, serviceAreas);
const overlappingParcels = findOverlappingGeoJsonFeatures(parcels);
```

Point containment supports `Point` and `MultiPoint` inputs. Polygon
relationships support `Polygon`, `MultiPolygon`, and polygon children of
`GeometryCollection`. Boundary points count as contained by default; set
`includeBoundary: false` to exclude them. Polygon holes exclude contained points.

## GeoJSON-First Maps

```tsx
import { FlowMap, GeoJsonMap, HeatMap, PointMap } from "@moritzbrantner/maps";

<PointMap geoJson={storesAndZones} style={{ height: 360 }} />;

<HeatMap
  geoJson={demandCollection}
  geoJsonOptions={{ metricKeys: ["demand"] }}
  weightMetric="demand"
  style={{ height: 360 }}
/>;

<FlowMap
  geoJson={routeCollection}
  geoJsonOptions={{ metricKeys: ["trips"] }}
  weightMetric="trips"
  style={{ height: 360 }}
/>;

<GeoJsonMap geoJson={mixedCollection} style={{ height: 360 }} />;
```

Use `geoJsonOverlay="none"` to disable contextual overlays, or
`geoJsonOverlay="all"` to draw the full GeoJSON source below the native layer.

## Controlled Interaction

`GeoJsonLayer` and the convenience maps accept controlled hover and selection
IDs. The ID comes from `getFeatureId` when provided, otherwise the layer falls
back to feature, point, flow, or cluster IDs.

```tsx
const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
const [hoveredFeatureId, setHoveredFeatureId] = useState<string | null>(null);

<GeoJsonMap
  geoJson={mixedCollection}
  getFeatureId={(feature) => feature.id}
  hoveredFeatureId={hoveredFeatureId}
  onHoveredFeatureIdChange={setHoveredFeatureId}
  onSelectedFeatureIdChange={setSelectedFeatureId}
  selectedFeatureId={selectedFeatureId}
/>;
```

## Typed Properties

```ts
import { createMapPointsFromGeoJson, type GeoJsonMapSource } from "@moritzbrantner/maps/core";

type StoreProperties = {
  demand: number;
  label: string;
};

const source: GeoJsonMapSource<StoreProperties> = {
  type: "FeatureCollection",
  features: [],
};

const points = createMapPointsFromGeoJson(source);
```

## Regional transforms and static operations

The data-only `@moritzbrantner/maps/core` entry exports
`translateGeoJsonFeature`, `rotateGeoJsonFeature`, `scaleGeoJsonFeature` and
`transformGeoJsonGeometry`. They work without React, a Map View or WASM.
The Map-Scoped Timeline's `applyGeoJsonTimelineTransform` uses this same
implementation, as does the GeoJSON Editor’s `moveGeoJsonGeometry` degree
translation helper.

- Translation takes explicit `longitudeDegrees` and `latitudeDegrees`.
  Timeline `longitudeOffset` and `latitudeOffset` also remain **degrees**.
- Rotation takes `degrees` (positive counterclockwise) and an optional
  longitude/latitude `pivot`. Scaling takes a positive `factor`, optional
  positive `factorX`/`factorY`, and the same optional pivot.
- The default pivot is the **longitude/latitude bounding-box centre**, not a
  centroid. An explicit geometry-transform origin requires both
  `originLongitude` and `originLatitude`.
- Combined transforms apply scale (axis overrides replace uniform scale), then
  rotation, then degree translation. Rotation/scaling use a spherical
  azimuthal-equidistant local metric frame at the geographic pivot, with Earth
  radius 6,371,008.8 metres. Both input and metric output must lie within
  **1,000 km** of that pivot. This preserves radial distances about the pivot;
  it does not promise globally distortion-free shapes or ellipsoidal accuracy.
  Degree translation alone has no local-radius restriction.
- Identity and translation avoid projection round trips. IDs, properties,
  multipart/ring ordering and exact ring closure are preserved. Inputs are
  never modified. Finite coordinates, valid longitude/latitude ranges,
  nonempty geometries and closed polygon rings with at least three distinct
  vertices and nonzero area are required. Every multipart polygon is checked;
  the combined hole area must be smaller than its shell area. Zero/negative scale, incomplete pivots and nonfinite
  transform arguments fail explicitly.

Rotation/scaling replace the previous timeline raw-degree computation in place;
existing transformations can consequently produce different geography.

Unsupported input or output across longitude ±180° fails closed. No silent
wrapping is performed. Coordinate-sequence jumps exceeding 180° are rejected;
separate noncrossing MultiPolygon parts on opposite sides remain usable.
Standalone transforms and relationship/measurement APIs throw
`GeoJsonGeographicOperationError` with a typed `code` (`invalid-geometry`,
`invalid-transform`, `unsupported-antimeridian`, `unsupported-extent`, or
`operation-failed`). Boolean, clipping, simplification, outline and overlap
resolution APIs return an empty collection plus `issues` on invalid/unsupported
input or failed computation; they never publish a partially computed result.
Nonpolygon entries retain their documented `skipped-non-polygon` warning.
Full antimeridian-aware operations remain deferred under #173.

This static example subtracts an inner region, preserving a hole, then rotates
that result using the public data-only APIs:

```ts
import {
  differenceGeoJsonFeatures,
  rotateGeoJsonFeature,
  type TemporalGeoJsonGeometryFeature,
} from "@moritzbrantner/maps/core";

const region: TemporalGeoJsonGeometryFeature = {
  type: "Feature",
  id: "region",
  geometry: {
    type: "Polygon",
    coordinates: [[[10, 50], [10.2, 50], [10.2, 50.2], [10, 50.2], [10, 50]]],
  },
};
const mask: TemporalGeoJsonGeometryFeature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [[[10.05, 50.05], [10.1, 50.05], [10.1, 50.1], [10.05, 50.1], [10.05, 50.05]]],
  },
};
const difference = differenceGeoJsonFeatures(region, mask);
if (difference.issues.length) throw new Error(difference.issues[0]?.message);
const rotated = difference.collection.features.map(feature =>
  rotateGeoJsonFeature(feature, { degrees: 30, pivot: [10.1, 50.1] }),
);
```

The regional reference fixtures compare metric scaling with an independent
haversine oracle (micrometre-level numerical agreement on the spherical model),
rotation against explicit regional coordinates (1e-5 degrees), and inverse
scaling (1e-10 degrees). These are numerical regression tolerances, not source
accuracy guarantees. First-party Map View, retained transition and authoritative
Rust/WASM completion remain subsequent #173 phases.
