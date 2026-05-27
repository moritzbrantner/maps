# @moritzbrantner/maps

React map components, density aggregation helpers, and temporal geo features for interactive spatial views.

## Main APIs

- `PointMap`, `BubbleMap`, `FlowMap`, `ClusteredMap`, `HeatMap`, `TemporalClusteredMap`, and `TemporalHeatMap`
- `MapView` plus `PointLayer`, `BubbleLayer`, `ClusterLayer`, `HeatLayer`, `FlowLayer`, `GeoJsonLayer`, and `BeeLineMeasurementLayer`
- `createPointAggregationIndex(...)`, `createHeatMapDensityIndex(...)`, and `createTemporalMapTracksFromGeoJson(...)`
- `createTemporalGeoJsonTracksFromGeoJson(...)`, `getTemporalGeoJsonFeatureCollectionAtTime(...)`, and `createTemporalGeoJsonPlaybackIndex(...)`
- `drawLineOnPolygonGeometry(...)` for turning drawn lines into polygon holes or splits

## Styles

Import the package stylesheet once in the app shell:

```ts
import "@moritzbrantner/maps/styles.css";
```

The package also expects the consuming app to import one `@moritzbrantner/ui`
stylesheet, because map controls use shared UI primitives.

## Clustered maps

Use `ClusteredMap` for interactive point maps backed by the shared
`@moritzbrantner/data-density` geo aggregation layer.

```tsx
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

const points: MapPoint[] = [
  {
    id: "warehouse-a",
    latitude: 52.52,
    longitude: 13.405,
    metrics: { demand: 42 },
  },
];

export function FleetMap() {
  return <ClusteredMap points={points} style={{ height: 420 }} />;
}
```

Set `mapDisplay="globe"` to render the same point aggregation on an
interactive orthographic globe:

```tsx
<ClusteredMap mapDisplay="globe" points={points} style={{ height: 420 }} />
```

Globe maps use a lightweight vector basemap by default. Use
`globeBasemapMode="tiles"` to opt into a tile-backed globe that reuses
`mapStyle.tiles` for additional detail at closer zooms:

```tsx
<ClusteredMap
  globeBasemapMode="tiles"
  mapDisplay="globe"
  mapStyle={{ tiles: "https://tiles.example.com/{z}/{x}/{y}.png", maxZoom: 12 }}
  points={points}
  style={{ height: 420 }}
/>
```

## Heat maps

Use `HeatMap` when users need a colored surface instead of discrete marker
interaction. The legacy `heatmapSurfaceMode="data"` and
`heatmapSurfaceMode="interpolated"` modes are point-density style renderers:
they draw influence around points and are useful for demand, activity, or
hotspot maps.

Use `heatmapSurfaceMode="field"` for a continuous scalar interpolation surface,
such as temperature across Europe. Field mode uses inverse distance weighting
(IDW) over a fixed geographic domain and renders a georeferenced image overlay,
so panning and zooming do not change the computed value at a longitude/latitude.
Set `fieldRenderMode="contours"` to draw vector level lines instead of a color
raster, and `showDataPoints` to show the original measurement points above the
surface. Contour lines and data points expose their values in hover tooltips.
Use `createHeatFieldContourFeatureCollection(...)` when you need the contour
lines as GeoJSON `MultiLineString` features for custom rendering.
IDW is not kriging or weather model output; for production weather maps, prefer
already-gridded model data when available. This implementation is intended for
interpolating scattered measurements.

By default, the heat radius is a fixed data-space radius in meters, so zooming
changes only how that same geographic footprint projects onto the screen.
Interpolated heat is sampled across the full viewport, uses an absolute
data-density scale, and keeps empty cells at the lowest visible color so the
field covers the whole visible map.

```tsx
import { HeatMap } from "@moritzbrantner/maps";

export function DemandHeatMap() {
  return (
    <HeatMap
      mapDisplay="globe"
      points={points}
      getWeight={(point) => point.metrics?.demand ?? 1}
      style={{ height: 420 }}
      defaultViewState={{ center: [13.405, 52.52], zoom: 9 }}
    />
  );
}
```

```tsx
import { HeatFieldMap, type MapPoint } from "@moritzbrantner/maps";

const stations: MapPoint[] = [
  { id: "berlin", latitude: 52.52, longitude: 13.405, metrics: { temperature: 21.5 } },
  { id: "paris", latitude: 48.8566, longitude: 2.3522, metrics: { temperature: 24.1 } },
];

export function TemperatureField() {
  return (
    <HeatFieldMap
      domainBounds={[-11, 35, 31, 62]}
      fieldColumns={320}
      fieldRows={220}
      fieldRenderMode="contours"
      fieldValueDomain={[-10, 35]}
      points={stations}
      showDataPoints
      valueMetric="temperature"
      style={{ height: 420 }}
    />
  );
}
```

Higher `fieldColumns`/`fieldRows` or smaller `fieldCellSizeMeters` values make
the field smoother, but increase CPU and memory cost. The default grid is capped
to a moderate size for interactive use.

## GeoJSON-first maps

Specialized maps can use GeoJSON as their primary source. Compatible geometries
feed the native renderer, while incompatible geometries stay visible as
contextual `GeoJsonLayer` overlays.

```tsx
import { FlowMap, GeoJsonMap, HeatMap, PointMap, TemporalClusteredMap } from "@moritzbrantner/maps";

<PointMap geoJson={storesAndZones} style={{ height: 360 }} />

<HeatMap
  geoJson={demandCollection}
  geoJsonOptions={{ metricKeys: ["demand"] }}
  weightMetric="demand"
  style={{ height: 360 }}
/>

<FlowMap
  geoJson={routeCollection}
  geoJsonOptions={{ metricKeys: ["trips"] }}
  weightMetric="trips"
  style={{ height: 360 }}
/>

<GeoJsonMap geoJson={mixedCollection} style={{ height: 360 }} />

<TemporalClusteredMap
  geoJson={temporalCollection}
  geoJsonTrackOptions={{ metricKeys: ["load"] }}
  style={{ height: 420 }}
/>
```

`PointMap`, `BubbleMap`, `ClusteredMap`, and `HeatMap` derive native marks from
`Point` and `MultiPoint` features. `FlowMap` derives native flows from
`LineString` and `MultiLineString` features, using the first and last coordinate
as endpoints and preserving multi-vertex route shapes as overlays. Use
`geoJsonOverlay="none"` to disable contextual overlays, or `geoJsonOverlay="all"`
to draw the full GeoJSON source below the native layer.

## GeoJSON editing

Use `EditableGeoJsonMap` when users need to create, move, reshape, or delete
GeoJSON objects. Editing is controlled: the map emits the next feature
collection and an operation descriptor, while the consuming app owns toolbar UI,
persistence, undo, save, and cancel flows.

```tsx
import { useState } from "react";
import {
  EditableGeoJsonMap,
  type GeoJsonEditMode,
  type TemporalGeoJsonGeometryFeatureCollection,
} from "@moritzbrantner/maps";

function GeoJsonEditor({
  initialGeoJson,
}: {
  initialGeoJson: TemporalGeoJsonGeometryFeatureCollection;
}) {
  const [geoJson, setGeoJson] = useState(initialGeoJson);
  const [mode, setMode] = useState<GeoJsonEditMode>("select");
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);

  return (
    <>
      <button type="button" onClick={() => setMode("draw-polygon")}>
        Draw polygon
      </button>
      <button type="button" onClick={() => setMode("reshape")}>
        Reshape
      </button>
      <EditableGeoJsonMap
        editMode={mode}
        geoJson={geoJson}
        selectedFeatureId={selectedFeatureId}
        onFeatureCollectionChange={(next) => setGeoJson(next)}
        onSelectionChange={setSelectedFeatureId}
        style={{ height: 420 }}
      />
    </>
  );
}
```

For composed maps, use `GeoJsonEditorLayer` inside `MapView`. The first editor
version supports flat maps; globe maps remain display/inspection surfaces.

## Controlled viewport

Every map accepts `viewState`, `defaultViewState`, and
`onViewStateChange`. Passing `viewState` makes the viewport controlled; user
pan, zoom, and cluster expansion call `onViewStateChange` without committing an
internal viewport.

```tsx
import { useState } from "react";
import { ClusteredMap, type MapViewState } from "@moritzbrantner/maps";

function ControlledMap() {
  const [viewState, setViewState] = useState<MapViewState>({
    center: [13.405, 52.52],
    zoom: 8,
  });

  return (
    <ClusteredMap
      points={points}
      viewState={viewState}
      onViewStateChange={(next) => setViewState(next)}
      style={{ height: 420 }}
    />
  );
}
```

`initialViewState` remains supported as a legacy alias for the uncontrolled
initial viewport. New code should prefer `defaultViewState`.

## Additional map types

Use `PointMap` for raw point markers, `BubbleMap` for proportional symbols, and
`FlowMap` for origin-to-destination connections.

```tsx
import { BubbleMap, FlowMap, PointMap, type MapFlow } from "@moritzbrantner/maps";

const flows: MapFlow[] = [
  {
    id: "berlin-paris",
    from: [13.405, 52.52],
    to: [2.3522, 48.8566],
    metrics: { trips: 180 },
  },
];

export function NetworkMaps() {
  return (
    <>
      <PointMap
        points={points}
        renderFeatureTooltip={(feature) => feature.point.label}
        renderFeaturePopup={(feature) => <strong>{feature.point.label}</strong>}
        style={{ height: 360 }}
      />
      <BubbleMap points={points} weightMetric="demand" style={{ height: 360 }} />
      <FlowMap flows={flows} weightMetric="trips" style={{ height: 360 }} />
    </>
  );
}
```

Use `onFeatureHover`, `onFeatureContextMenu`, `renderFeatureContextMenu`,
`renderFeatureTooltip`, `renderFeaturePopup`, and `selectedFeatureId` on point,
bubble, clustered, GeoJSON, and flow layers or convenience maps. Existing
`onFeatureSelect` remains the click selection callback; right-clicking a feature
calls `onFeatureContextMenu` and can render a feature-specific menu. `MapView`,
`PointMap`, and `BubbleMap` also accept `renderMapContextMenu` for background
right-click menus. Point and bubble layers can be made draggable with
`draggable`, `onFeatureDrag`, and `onFeatureDragEnd`.

## Composable layers

Use `MapView` when multiple visual layers should share one viewport and
interaction surface.

```tsx
import {
  BeeLineMeasurementLayer,
  FlowLayer,
  GeoJsonLayer,
  HeatLayer,
  MapView,
  PointLayer,
} from "@moritzbrantner/maps";

function OperationsMap() {
  return (
    <MapView
      mapDisplay="flat"
      defaultViewState={{ center: [13.405, 52.52], zoom: 8 }}
      style={{ height: 420 }}
    >
      <HeatLayer points={points} weightMetric="demand" />
      <FlowLayer flows={flows} weightMetric="trips" />
      <GeoJsonLayer featureCollection={geoJsonFeatureCollection} />
      <PointLayer points={points} renderFeatureTooltip={(feature) => feature.point.label} />
      <BeeLineMeasurementLayer
        measurementMode={isMeasuring ? "bee-line" : "none"}
        measurements={measurements}
        onMeasurementCreate={handleMeasurementCreate}
      />
    </MapView>
  );
}
```

## Bee-line measurements

Flat and globe maps support controlled bee-line measurement. Consumers own the
toolbar, IDs, persistence, and clearing; maps collect the two clicks and render
the controlled `measurements` prop.

```tsx
import { useState } from "react";
import { PointMap, type MapBeeLineMeasurement } from "@moritzbrantner/maps";

function MeasuringMap() {
  const [measurements, setMeasurements] = useState<MapBeeLineMeasurement[]>([]);
  const [isMeasuring, setIsMeasuring] = useState(false);

  return (
    <>
      <button onClick={() => setIsMeasuring((value) => !value)}>
        {isMeasuring ? "Stop measuring" : "Measure"}
      </button>
      <PointMap
        points={points}
        measurementMode={isMeasuring ? "bee-line" : "none"}
        measurements={measurements}
        onMeasurementCreate={(measurement) => {
          setMeasurements((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              from: measurement.from,
              to: measurement.to,
            },
          ]);
        }}
        style={{ height: 420 }}
      />
    </>
  );
}
```

The first click starts a draft line, pointer movement previews the distance, and
the second click completes the measurement. Press `Escape` to cancel a draft.
Metric auto-formatting is the default: distances below `1000m` render as meters
and longer distances render as kilometers.

## Polygon line drawing

Use `drawLineOnPolygonGeometry(...)` after collecting a drawn `LineString`.
Closed lines inside a polygon become holes. Open lines that cross a polygon
shell twice split the affected polygon and return a `MultiPolygon`.

```ts
import { drawLineOnPolygonGeometry } from "@moritzbrantner/maps";

const result = drawLineOnPolygonGeometry(polygonOrMultiPolygon, {
  coordinates: [
    [13.3, 52.4],
    [13.5, 52.6],
  ],
  type: "LineString",
});

if (result.operation !== "none") {
  saveGeometry(result.geometry);
}
```

## Temporal playback

Use `TemporalClusteredMap` or `TemporalHeatMap` for moving point tracks. The
component samples tracks at the current playback time and reuses the same
aggregation contracts as static maps.

```tsx
import { TemporalClusteredMap, type TemporalMapTrack } from "@moritzbrantner/maps";

const tracks: TemporalMapTrack[] = [
  {
    id: "driver-1",
    frames: [
      { time: 0, latitude: 52.5, longitude: 13.3 },
      { time: 60_000, latitude: 52.55, longitude: 13.45 },
    ],
  },
];

export function PlaybackMap() {
  return <TemporalClusteredMap tracks={tracks} style={{ height: 420 }} />;
}
```

## Dense Temporal GeoJSON

Use `createTemporalGeoJsonPlaybackIndex(...)` when the same temporal GeoJSON tracks are queried many times during playback. The index precomputes sampling and ring preparation so dense polygons and multipolygons do not pay that setup cost on every frame.

```ts
import {
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
} from "@moritzbrantner/maps";

const tracks = createTemporalGeoJsonTracksFromGeoJson(collection);

const playbackIndex = createTemporalGeoJsonPlaybackIndex(tracks, {
  strategy: "compatible",
  maxCoordinatesPerRing: 96,
});

const frameData = playbackIndex.getFeatureCollectionAtTime(currentTime);
```

By default, dense compatible lines and rings are resampled to the configured playback budget when they exceed `maxCoordinatesPerLine` or `maxCoordinatesPerRing`. Use `denseGeometryBehavior: "preserve"` if you want the prepared index to keep the exact `compatible` interpolation semantics instead of switching dense shapes to bounded playback geometry.

The temporal GeoJSON helpers accept every supported geometry type, not just
points. `GeoJsonLayer` renders the resulting `FeatureCollection`; point and
line features can also be transformed into the existing point, heat, and flow
maps when those specialized views are a better fit.

```ts
import {
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
  type TemporalGeoJsonGeometryFeatureCollection,
} from "@moritzbrantner/maps";

const collection: TemporalGeoJsonGeometryFeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { label: "Depot", time: 0, trackId: "depot" },
      geometry: { type: "Point", coordinates: [13.405, 52.52] },
    },
    {
      type: "Feature",
      properties: { label: "Route", time: 0, trackId: "route" },
      geometry: {
        type: "LineString",
        coordinates: [
          [13.405, 52.52],
          [9.9937, 53.551],
        ],
      },
    },
    {
      type: "Feature",
      properties: { label: "Split route", time: 0, trackId: "split-route" },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [10.7522, 59.9139],
            [12.5683, 55.6761],
          ],
          [
            [18.0686, 59.3293],
            [24.9384, 60.1699],
          ],
        ],
      },
    },
    {
      type: "Feature",
      properties: { label: "Service zone", time: 0, trackId: "zone" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [6.4, 45.6],
            [12.2, 45.6],
            [12.2, 48.6],
            [6.4, 48.6],
            [6.4, 45.6],
          ],
        ],
      },
    },
    {
      type: "Feature",
      properties: { label: "Operating areas", time: 0, trackId: "areas" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-4.4, 39.5],
              [-2.8, 39.5],
              [-2.8, 41.1],
              [-4.4, 41.1],
              [-4.4, 39.5],
            ],
          ],
          [
            [
              [1.5, 40.8],
              [2.9, 40.8],
              [2.9, 42.0],
              [1.5, 42.0],
              [1.5, 40.8],
            ],
          ],
        ],
      },
    },
  ],
};

const tracks = createTemporalGeoJsonTracksFromGeoJson(collection);
const frame = createTemporalGeoJsonPlaybackIndex(tracks).getFeatureCollectionAtTime(0);
```

```tsx
import { GeoJsonLayer, HeatLayer, FlowLayer, MapView } from "@moritzbrantner/maps";

export function GeoJsonOperationsMap() {
  return (
    <MapView defaultViewState={{ center: [8.4, 50.4], zoom: 4.4 }}>
      <HeatLayer points={pointsFromGeoJsonPointFeatures} weightMetric="demand" />
      <FlowLayer flows={flowsFromGeoJsonLineStrings} weightMetric="trips" />
      <GeoJsonLayer
        featureCollection={frame}
        renderFeatureTooltip={(feature) => feature.geometry.type}
      />
    </MapView>
  );
}
```

## Notes

- Import `@moritzbrantner/maps/styles.css` once in the consuming app to load the package styles.
- Keep `@moritzbrantner/data-density` and `@moritzbrantner/ui` as published external dependencies.
- Run `bun run verify:release` before publishing a release.
