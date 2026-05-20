# @moritzbrantner/maps

React map components, density aggregation helpers, and temporal geo features for interactive spatial views.

## Main APIs

- `PointMap`, `BubbleMap`, `FlowMap`, `ClusteredMap`, `HeatMap`, `TemporalClusteredMap`, and `TemporalHeatMap`
- `createPointAggregationIndex(...)`, `createHeatMapDensityIndex(...)`, and `createTemporalMapTracksFromGeoJson(...)`
- `createTemporalGeoJsonTracksFromGeoJson(...)`, `getTemporalGeoJsonFeatureCollectionAtTime(...)`, and `createTemporalGeoJsonPlaybackIndex(...)`

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

## Heat maps

Use `HeatMap` when users need density instead of discrete marker interaction.

```tsx
import { HeatMap } from "@moritzbrantner/maps";

export function DemandHeatMap() {
  return (
    <HeatMap
      mapDisplay="globe"
      points={points}
      getWeight={(point) => point.metrics?.demand ?? 1}
      style={{ height: 420 }}
      initialViewState={{ center: [52.52, 13.405], zoom: 9 }}
    />
  );
}
```

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
      <PointMap points={points} style={{ height: 360 }} />
      <BubbleMap points={points} weightMetric="demand" style={{ height: 360 }} />
      <FlowMap flows={flows} weightMetric="trips" style={{ height: 360 }} />
    </>
  );
}
```

## Bee-line measurements

Flat maps support controlled bee-line measurement. Consumers own the toolbar,
IDs, persistence, and clearing; maps only collect the two clicks and render the
controlled `measurements` prop. Globe maps accept the same props for API
consistency, but measurement rendering is flat maps only in the first version.

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

## Notes

- Import `@moritzbrantner/maps/styles.css` once in the consuming app to load the package styles.
- Keep `@moritzbrantner/data-density` and `@moritzbrantner/ui` as published external dependencies.
- Run `bun run verify:release` before publishing a release.
