# Entrypoints

Use narrower entrypoints when an app only needs data helpers, flat maps, globe
maps, editor tools, or timeline helpers.

| Entry point | Use when |
| --- | --- |
| `@moritzbrantner/maps` | You want the full public API from one import path. |
| `@moritzbrantner/maps/core` | You only need transforms, aggregation, measurement, heat-field, or temporal helpers. |
| `@moritzbrantner/maps/layers` | You compose layers inside `MapView`. |
| `@moritzbrantner/maps/flat` | You only render flat MapLibre-backed wrappers. |
| `@moritzbrantner/maps/globe` | You only render globe wrappers or globe basemap helpers. |
| `@moritzbrantner/maps/editor` | You need GeoJSON editing components and edit-operation helpers. |
| `@moritzbrantner/maps/timeline` | You need GeoJSON timeline transforms and transition helpers. |
| `@moritzbrantner/maps/styles.css` | You need the package stylesheet. Import once in the app shell. |

## Root

```tsx
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

const points: MapPoint[] = [{ id: "berlin", latitude: 52.52, longitude: 13.405 }];

<ClusteredMap points={points} style={{ height: 360 }} />;
```

## Core

```ts
import { createPointAggregationIndex, validateGeoJsonMapSource } from "@moritzbrantner/maps/core";

const validation = validateGeoJsonMapSource(collection, {
  metricKeys: ["demand"],
  requireFeatureIds: true,
});

if (validation.valid) {
  const index = createPointAggregationIndex(points);
  index.getAggregation({ bounds: [5, 45, 16, 56], zoom: 6 });
}
```

## Layers

```tsx
import { MapLayers, MapView, PointLayer } from "@moritzbrantner/maps/layers";

<MapView defaultViewState={{ center: [13.405, 52.52], zoom: 8 }} style={{ height: 360 }}>
  <MapLayers>
    <PointLayer points={points} />
  </MapLayers>
</MapView>;
```

## Flat

```tsx
import { FlatPointMap } from "@moritzbrantner/maps/flat";

<FlatPointMap points={points} style={{ height: 360 }} />;
```

## Globe

```tsx
import { GlobePointMap } from "@moritzbrantner/maps/globe";

<GlobePointMap points={points} style={{ height: 360 }} />;
```

## Editor

```tsx
import { EditableGeoJsonMap } from "@moritzbrantner/maps/editor";

<EditableGeoJsonMap geoJson={collection} onFeatureCollectionChange={setCollection} />;
```

## Timeline

```ts
import { createGeoJsonTimelineDocument } from "@moritzbrantner/maps/timeline";

const document = createGeoJsonTimelineDocument(collection, { durationMs: 4_000 });
```
