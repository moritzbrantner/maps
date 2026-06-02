# GeoJSON Editor

Use `EditableGeoJsonMap` when users need to create, move, reshape, group, or
delete GeoJSON elements. The editor is controlled: the map emits the next
feature collection and an operation descriptor while the consuming app owns
toolbar UI, persistence, undo, save, and cancel flows.

```tsx
import { useState } from "react";
import {
  EditableGeoJsonMap,
  type GeoJsonEditMode,
  type TemporalGeoJsonGeometryFeatureCollection,
} from "@moritzbrantner/maps";

export function GeoJsonEditor({
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
      <EditableGeoJsonMap
        editMode={mode}
        geoJson={geoJson}
        selectedFeatureId={selectedFeatureId}
        onFeatureCollectionChange={setGeoJson}
        onSelectionChange={setSelectedFeatureId}
        style={{ height: 420 }}
      />
    </>
  );
}
```

Keyboard shortcuts are enabled by default. `V`, `P`, `L`, `G`, `M`, and `R`
switch select, point, line, polygon, move, and reshape modes when
`onEditModeChange` is provided. `Delete` removes the selected node in reshape
mode or selected elements otherwise. `Ctrl/Cmd+A`, `Ctrl/Cmd+D`,
`Ctrl/Cmd+G`, and `Ctrl/Cmd+Shift+G` select all, duplicate, group, and ungroup.
Shortcuts are ignored while typing in inputs.

Use `GeoJsonEditorLayer` inside `MapView` for composed maps. Editing currently
targets flat maps; globe maps are display and inspection surfaces.
