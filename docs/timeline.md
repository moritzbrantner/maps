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

## Temporal edge policy

Sampling is a pure function of the source and the time: a direct seek, forward playback, a
backward seek and resumed playback give the same Map Features at the same time. Point tracks
and temporal GeoJSON tracks follow one policy, checked against an independent reference
sampler (`src/temporal-edge-sequences.test.ts`):

- **Endpoints.** A track is absent before its first keyframe and holds its last keyframe
  afterwards. Exactly on a keyframe, the keyframe is returned as declared.
- **Admission, removal and gaps.** A keyframe with `visible: false` removes the feature from
  that time until its next keyframe; it reappears on that keyframe without moving in. A final
  invisible keyframe removes it for good.
- **Order and duplicate times.** Keyframes are sampled in time order however they are
  declared. Keyframes that share a time are an instantaneous jump: the feature moves toward
  the one declared first and continues from the one declared last.
- **Invalid input.** Keyframes with a non-finite time or coordinate (or an unsupported
  geometry) are dropped and do not extend the time range; a track left without keyframes never
  appears. A non-finite sample time yields no features, and `clock.seek()` ignores a
  non-finite time.
- **Empty and single-keyframe sources.** Without any valid keyframe there is no time range and
  nothing to play. A single keyframe gives a range of one instant: the feature appears from
  that time on and the clock has no playable range.
- **World wrapping.** Longitudes interpolate as supplied; nothing picks a shorter way around.
  To cross the antimeridian, supply unwrapped longitudes (`174` → `186`, not `174` → `-174`,
  which travels west through 0°). Point aggregation indexes an unwrapped longitude at its
  wrapped location and reports it as supplied, so the Maps runtime draws and picks such a
  feature continuously across 180°.
- **Geometry transitions.** With the default `compatible` strategy, geometries of the same
  type and vertex layout move vertex by vertex; any other transition holds the earlier
  geometry until the next keyframe (or hides it with `fallback: "hide"`).
- **Source changes.** Replacing a map's tracks keeps the map-scoped time, the playback state
  and the application's selection; the new source is sampled at that time. The clock keeps the
  last requested time and the time range only clamps what is sampled, so a time outside the
  new range is sampled at the nearest bound and returns if the range covers it again before
  the next seek or playback frame.
- **Stale work.** The clock has one live frame request. A frame requested before a pause,
  `dispose()` or a scheduler change never advances the time or starts a second loop. With
  application-controlled time the latest time supplied by the application always wins; seeks
  and frames are only requests.

## Temporal computation authority

The #75 authority audit of temporal computation (#172 phase C) assigns each concern one owner.
Rust/Maps owns geographic results; TypeScript keeps controls, lifecycle and application data.

| Concern | Owner | Why |
| --- | --- | --- |
| Map-scoped time, playback, snapping, ranges (`createMapScopedTimelineClock`) | TypeScript, framework-free | Lifecycle and controls, not a geographic result. One frame loop per clock. |
| Moving point tracks: keyframe selection, admission/removal and sampled positions | **Rust** (`maps-core` `TemporalPointTrackIndex`) | The position of a Map Feature at a time is a geographic result, sampled every frame and fed to the Rust aggregation index. |
| Track identity, labels, properties and metric values of a sample | TypeScript | Application data; joined to the keyframes Rust reports. Metric values blend with Rust's progress. |
| Parsing temporal GeoJSON points into tracks (`createTemporalMapTracksFromGeoJson`) | TypeScript | Source preparation; the tracks are then sampled as above. |
| Temporal GeoJSON geometry sampling and transitions | TypeScript, unchanged | Geometry transition authority belongs to #173 (and #175 for geography-preserving transitions); migrating it here would duplicate that work. |
| Temporal heat | Same point sampler, then `HeatLayer` | Heat/scalar authority belongs to #171. |

`createTemporalMapPlaybackIndex` and `getTemporalMapPointsAtTime` sample through the Rust index
once the Maps WASM runtime is loaded: temporal Convenience Maps start loading it on mount, and
`initializeMapsTemporalWasm()` / `ensureMapsTemporalWasm()` load it directly. Keyframes cross
the boundary once, packed; each sample returns one `Float64Array`. Before the runtime is ready,
during SSR and when it fails to load (`getMapsTemporalRuntimeStatus()` is `unavailable`), the
TypeScript implementation remains the reference and explicit fallback. It computes the same
positions with the same floating-point operations, so a Map View that switches to Rust while
playing shows no change. Once Rust is selected, an error building its index is thrown rather
than hidden by the fallback.

Evidence: `crates/maps-core/tests/temporal_points.rs`, and the browser test in
`e2e/maps-temporal-runtime.spec.ts`, which compares the real Rust/WASM sampler with the
independent reference sampler over the shared edge sequence and picks Rust-sampled positions on
`flatRuntime="maps"`.

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
