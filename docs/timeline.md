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

## Historical Map Feature selection

`useHistoricalMapFeatureSelection({ features, locale, timeline })` validates Map Feature
selection against the same Map-Scoped Timeline clock the Map Layers sample (Maps Decision
Atlas 1.14, 1.16, 1.18 and 1.20). The application supplies one
`HistoricalMapFeatureRecord` per historical Map Feature: its applicable `periods`
(start-inclusive, end-exclusive), date-specific `names` with the attested `original` form and
established `localized` forms, a `modernName`, `attribution` and the `supportedDates` a viewer
may return to. Maps never infers periods, names, translations or successors.

```tsx
const selection = useHistoricalMapFeatureSelection({ features: records, locale, timeline: clock });

<MapView flatRuntime="maps" mapStyle={style}>
  <GeoJsonLayer
    featureCollection={placesValidAt(selection.activeTime)}
    hoveredFeatureId={selection.hoveredFeatureId}
    isFeatureInteractive={(feature) => selection.isFeatureApplicable(feature.id)}
    onHoveredFeatureIdChange={selection.onHoveredFeatureIdChange}
    onSelectedFeatureIdChange={selection.onSelectedFeatureIdChange}
    renderFeaturePopup={(feature) => selection.getFeatureName(feature.id)?.text}
    selectedFeatureId={selection.selectedFeatureId}
  />
</MapView>
<HistoricalMapFeatureContextPanel selection={selection} />
```

- In the render in which the sampled `activeTime` leaves a selected feature's period, the
  selection, hover and anchored popup clear, and its details are retained as
  `selection.retainedContext`. `HistoricalMapFeatureContextPanel` shows them detached from the
  map, labelled **Out of period**, with the date and period they refer to and the current map
  date. Picks of out-of-period features are ignored.
- Nothing reselects the feature automatically: not a successor, and not the timeline moving
  back into its period (the panel then says it applies at the map date but is not selected).
  A new applicable selection replaces the context; **Dismiss** closes it.
- The panel's mini-timeline lists the feature's supported dates. Dates the map's timeline
  cannot reach, or that its `timeStep` would snap out of the feature's period, are disabled
  with the reason. Activating a date pauses and seeks the one clock and reselects the feature
  once the map samples that date; with application-controlled time it waits for that time, and
  a different time arriving first cancels the reselection.
- `resolveHistoricalMapFeatureName(record, time, locale)` gives the date-appropriate name in
  the viewer's language, or the attested original form flagged `sourceFormFallback`. Changing
  `locale` relabels without changing the date or the selection. The pure helpers are also
  exported from `@moritzbrantner/maps/core`.
- Derive the layer's geometry from the same `activeTime`, so the out-of-period geometry and its
  popup leave the map together. A retained popup re-renders with the layer's latest
  `renderFeaturePopup` and feature, so a supported rename updates an open popup.

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
