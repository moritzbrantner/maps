# Timeline And Temporal Maps

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

<TemporalClusteredMap tracks={tracks} style={{ height: 420 }} />;
```

## One Map-Scoped Timeline clock

A Map-Scoped Timeline has one authoritative time. `createMapScopedTimelineClock()` holds it,
together with play/pause, seeking, `timeStep` snapping, looping and the one frame loop that
advances it while playing. Temporal Convenience Maps take the clock as `timeline`, register
their data's time range with it (the clock merges every registered range unless it has an
explicit `timeRange`) and only sample its snapped `activeTime`:

```tsx
import {
  createMapScopedTimelineClock,
  MapScopedTimelineControls,
  TemporalClusteredMap,
  TemporalHeatMap,
} from "@moritzbrantner/maps/temporal";

const clock = createMapScopedTimelineClock({ playbackRate: 60_000 });

<>
  <TemporalClusteredMap showPlaybackControls={false} timeline={clock} tracks={vehicles} />
  <TemporalHeatMap showPlaybackControls={false} timeline={clock} tracks={incidents} />
  <MapScopedTimelineControls timeline={clock} />
</>;
```

Create the clock once per timeline (for example in `useState(() => ...)`) and call
`clock.dispose()` when the application is done with it; disposing stops the frame loop and
pauses without losing the time. `useMapScopedTimelineSnapshot(clock)` subscribes any other
component to the same time.

For application-controlled time, call `clock.setControlledTime(time)`: the snapshot then
reports that time, and seeks or playback frames become requests delivered to `onTimeChange`
until the application supplies the next time. `setControlledTime(undefined)` returns
ownership to the clock.

Without `timeline`, `TemporalClusteredMap` and `TemporalHeatMap` keep their compatibility
props (`autoPlay`, `currentTime`, `defaultTime`, `loopPlayback`, `onTimeChange`,
`playbackRate`, `timeStep`), which configure a clock owned by the component. Those props are
ignored when a `timeline` is supplied.

`TemporalClusteredMap` also accepts `flatRuntime="maps"` with an explicit raster `mapStyle`;
static Map Layers such as `GeoJsonLayer` go in as children and stay retained while only the
time changes.

## GeoJSON Timeline Transitions

`getGeoJsonTimelineFeatureCollectionAtTime(...)` applies timeline keyframes to
each feature without interpreting adjacent items as scene states.

```ts
import {
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineFeatureCollectionAtTime,
} from "@moritzbrantner/maps/timeline";

const document = createGeoJsonTimelineDocument(collection, { durationMs: 4_000 });
const transformed = getGeoJsonTimelineFeatureCollectionAtTime(collection, document, 2_000);
```

Use `getGeoJsonTimelineSceneAtTime(...)` when items on one timeline track are
successive GeoJSON states and the end of one item should transition into the
next. `topology-plan` supports one-to-many splits and many-to-one merges. For
reordered multipart or `GeometryCollection` scene states, use
`partMatchingStrategy: "auto"` so polygon parts match by overlap and point/line
parts match by nearest centroid.

```ts
import {
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineSceneAtTime,
} from "@moritzbrantner/maps/timeline";

const document = createGeoJsonTimelineDocument(collection, {
  getItemStartMs: (feature) => Number(feature.properties?.startMs),
  getTimelineTrackId: () => "district-scene",
  itemDurationMs: 1_000,
});

const frame = getGeoJsonTimelineSceneAtTime(collection, document, 750, {
  defaultTransition: {
    algorithm: "topology-plan",
    durationMs: 500,
    partMatchingStrategy: "auto",
    topologyStrategy: "voronoi-partition",
  },
});
```

For repeated dense temporal GeoJSON playback, prefer
`createTemporalGeoJsonPlaybackIndex(...)` so line and ring preparation can be
reused across animation frames. Temporal geometry interpolation also accepts
`partMatchingStrategy: "auto"` for reordered `MultiPoint`, `MultiLineString`,
and `MultiPolygon` frames; topology-plan remains a scene-transition feature.
