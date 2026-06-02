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
