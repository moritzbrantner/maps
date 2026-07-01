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
