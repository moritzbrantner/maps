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
next. `topology-plan` supports one-to-many splits and many-to-one merges.

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
    topologyStrategy: "voronoi-partition",
  },
});
```

For repeated dense temporal GeoJSON playback, prefer
`createTemporalGeoJsonPlaybackIndex(...)` so line and ring preparation can be
reused across animation frames.
