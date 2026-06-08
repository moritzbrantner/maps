# Entrypoints

Use narrower entrypoints when an app only needs data helpers, flat wrappers,
composed layers, editor tools, heat maps, GeoJSON display, measurement, or
temporal helpers.

| Entry point | Use when |
| --- | --- |
| `@moritzbrantner/maps` | You want the full public API from one import path. |
| `@moritzbrantner/maps/core` | You only need transforms, aggregation, measurement, heat-field, or temporal helpers. |
| `@moritzbrantner/maps/layers` | You compose layers inside `MapView`. |
| `@moritzbrantner/maps/flat` | You only render flat MapLibre-backed wrappers. |
| `@moritzbrantner/maps/editor` | You need GeoJSON editing components and edit-operation helpers. |
| `@moritzbrantner/maps/timeline` | You need GeoJSON timeline transforms and transition helpers. |
| `@moritzbrantner/maps/geojson` | You need GeoJSON display, source conversion, bounds, or validation helpers. |
| `@moritzbrantner/maps/heat` | You need heat maps, scalar fields, or heat-field rendering helpers. |
| `@moritzbrantner/maps/measurement` | You need bee-line measurement helpers or layers. |
| `@moritzbrantner/maps/temporal` | You need temporal point or temporal GeoJSON playback helpers and maps. |
| `@moritzbrantner/maps/styles.css` | You need the package stylesheet. Import once in the app shell. |

## Root

```tsx
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

const points: MapPoint[] = [{ id: "berlin", latitude: 52.52, longitude: 13.405 }];

<ClusteredMap points={points} style={{ height: 360 }} />;
```

## Core

```ts
import {
  createPointAggregationIndex,
  getMapBoundsCenter,
  validateGeoJsonMapSource,
} from "@moritzbrantner/maps/core";

const validation = validateGeoJsonMapSource(collection, {
  metricKeys: ["demand"],
  requireFeatureIds: true,
});

if (validation.valid) {
  const index = createPointAggregationIndex(points);
  index.getAggregation({ bounds: [5, 45, 16, 56], zoom: 6 });
}

getMapBoundsCenter([5, 45, 16, 56]);
```

## Layers

```tsx
import { MapColorRampLegend, MapLayers, MapView, PointLayer } from "@moritzbrantner/maps/layers";

<MapView defaultViewState={{ center: [13.405, 52.52], zoom: 8 }} style={{ height: 360 }}>
  <MapLayers>
    <PointLayer points={points} />
  </MapLayers>
  <MapColorRampLegend stops={[[0, "#67e8f9"], [1, "#dc2626"]]} title="Demand" />
</MapView>;
```

## Flat

```tsx
import { FlatPointMap } from "@moritzbrantner/maps/flat";

<FlatPointMap points={points} style={{ height: 360 }} />;
```

## Editor

```tsx
import {
  EditableGeoJsonMap,
  createGeoJsonEditHistoryState,
} from "@moritzbrantner/maps/editor";

const history = createGeoJsonEditHistoryState(collection);

<EditableGeoJsonMap
  geoJson={history.present}
  onFeatureCollectionChange={setCollection}
  snapOptions={{ enabled: true }}
/>;
```

## Timeline

```ts
import { createGeoJsonTimelineDocument } from "@moritzbrantner/maps/timeline";

const document = createGeoJsonTimelineDocument(collection, { durationMs: 4_000 });
```

## GeoJSON

```tsx
import { GeoJsonMap, validateGeoJsonMapSource } from "@moritzbrantner/maps/geojson";

const validation = validateGeoJsonMapSource(collection);

if (validation.valid) {
  <GeoJsonMap geoJson={collection} style={{ height: 360 }} />;
}
```

## Heat

```tsx
import { HeatMap, createHeatMapDensityIndex } from "@moritzbrantner/maps/heat";

const index = createHeatMapDensityIndex(points, { weightMetric: "demand" });

<HeatMap points={points} weightMetric="demand" style={{ height: 360 }} />;
```

## Measurement

```ts
import { formatMapDistance, getBeeLineDistanceMeters } from "@moritzbrantner/maps/measurement";

const distance = getBeeLineDistanceMeters([13.405, 52.52], [2.3522, 48.8566]);
const label = distance === null ? null : formatMapDistance(distance);
```

## Temporal

```ts
import {
  createTemporalMapPlaybackIndex,
  getTemporalMapPointsAtTime,
} from "@moritzbrantner/maps/temporal";

const index = createTemporalMapPlaybackIndex(tracks);
const frame = getTemporalMapPointsAtTime(tracks, 1_000);
```
