# Recipes

## Controlled Map With External Selection

```tsx
import { useMemo, useState } from "react";
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

export function FleetMap({ points }: { points: MapPoint[] }) {
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const selectedPoint = useMemo(
    () => points.find((point) => point.id === selectedFeatureId),
    [points, selectedFeatureId],
  );

  return (
    <>
      <ClusteredMap
        onSelectedFeatureIdChange={setSelectedFeatureId}
        points={points}
        selectedFeatureId={selectedFeatureId}
        style={{ height: 420 }}
      />
      <aside>{selectedPoint?.id ?? "No point selected"}</aside>
    </>
  );
}
```

## GeoJSON Editor With Save, Cancel, And Undo

```tsx
import { useState } from "react";
import {
  EditableGeoJsonMap,
  createGeoJsonEditHistoryState,
  pushGeoJsonEditHistory,
  undoGeoJsonEditHistory,
  type GeoJsonEditMode,
} from "@moritzbrantner/maps/editor";
import type { TemporalGeoJsonGeometryFeatureCollection } from "@moritzbrantner/maps/temporal";

export function ZoneEditor({
  initialGeoJson,
  onSave,
}: {
  initialGeoJson: TemporalGeoJsonGeometryFeatureCollection;
  onSave: (next: TemporalGeoJsonGeometryFeatureCollection) => void;
}) {
  const [history, setHistory] = useState(() => createGeoJsonEditHistoryState(initialGeoJson));
  const [mode, setMode] = useState<GeoJsonEditMode>("select");

  return (
    <>
      <button disabled={!history.canUndo} onClick={() => setHistory(undoGeoJsonEditHistory)}>
        Undo
      </button>
      <button onClick={() => setHistory(createGeoJsonEditHistoryState(initialGeoJson))}>
        Cancel
      </button>
      <button onClick={() => onSave(history.present)}>Save</button>
      <EditableGeoJsonMap
        editMode={mode}
        geoJson={history.present}
        onEditModeChange={setMode}
        onFeatureCollectionChange={(next, operation) =>
          setHistory((current) => pushGeoJsonEditHistory(current, next, operation))
        }
        style={{ height: 420 }}
      />
    </>
  );
}
```

## Server-Side Aggregation

```ts
import {
  createPointAggregationIndex,
  type MapBounds,
  type MapPoint,
} from "@moritzbrantner/maps/core";

export function summarizeViewport(points: MapPoint[], bounds: MapBounds, zoom: number) {
  const index = createPointAggregationIndex(points);

  return index.getAggregation({ bounds, zoom });
}
```

## Large Dataset Setup

```tsx
import {
  ClusteredMap,
  createPointAggregationIndex,
  type MapPoint,
} from "@moritzbrantner/maps";

export function LargeFleetMap({ points }: { points: MapPoint[] }) {
  const summary = createPointAggregationIndex(points).getAggregation({
    bounds: [5, 45, 16, 56],
    zoom: 6,
  });

  return (
    <>
      <ClusteredMap fitToData={false} points={points} style={{ height: 520 }} />
      <p>{summary.features.length.toLocaleString("en")} visible marks in the current query.</p>
    </>
  );
}
```

## Next.js Client Wrapper

```tsx
// app/components/client-map.tsx
"use client";

import "@moritzbrantner/maps/styles.css";
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

export function ClientMap({ points }: { points: MapPoint[] }) {
  return <ClusteredMap points={points} style={{ height: 420 }} />;
}
```

```ts
// app/lib/map-summary.ts
import { createPointAggregationIndex, type MapPoint } from "@moritzbrantner/maps/core";

export function summarizePoints(points: MapPoint[]) {
  return createPointAggregationIndex(points).getAggregation({
    bounds: [-180, -90, 180, 90],
    zoom: 2,
  });
}
```
