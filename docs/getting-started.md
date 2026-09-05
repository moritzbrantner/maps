# Getting Started

## Install

For full React map usage:

```sh
bun add @moritzbrantner/maps react react-dom
```

```sh
npm install @moritzbrantner/maps react react-dom
```

For timeline editor components:

```sh
bun add @moritzbrantner/timeline-editor
```

For core-only server or data usage:

```sh
bun add @moritzbrantner/maps
```

Import the maps stylesheet once in the app shell:

```ts
import "@moritzbrantner/maps/styles.css";
```

The package stylesheet is compiled CSS and includes MapLibre GL CSS. Consumers do
not need to run Tailwind over `@moritzbrantner/maps/styles.css`. The default
stylesheet does not include Tailwind preflight/global reset.

If an app relied on the legacy reset from earlier package styles, import the
compatibility stylesheet instead:

```ts
import "@moritzbrantner/maps/styles.full.css";
```

React and React DOM are required peers for rendered map components. The optional `@moritzbrantner/timeline-editor` peer is only required
when using timeline editor components.

## Basic Clustered Map

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

Set `mapDisplay="globe"` to render the same data with MapLibre GL JS native
globe projection:

```tsx
<ClusteredMap mapDisplay="globe" points={points} style={{ height: 420 }} />
```

## Controlled Viewport

Every map accepts `viewState`, `defaultViewState`, and `onViewStateChange`.
Passing `viewState` makes the viewport controlled. Use `defaultViewState` for
an uncontrolled initial viewport.

```tsx
import { useState } from "react";
import { ClusteredMap, type MapViewState } from "@moritzbrantner/maps";

export function ControlledMap() {
  const [viewState, setViewState] = useState<MapViewState>({
    center: [13.405, 52.52],
    zoom: 8,
  });

  return (
    <ClusteredMap
      points={points}
      viewState={viewState}
      onViewStateChange={setViewState}
      style={{ height: 420 }}
    />
  );
}
```

`initialViewState` remains available as a legacy alias, but new code should use
`defaultViewState`.

`onMapControllerReady` exposes imperative helpers for user-driven camera
changes:

```tsx
import { useRef } from "react";
import { ClusteredMap, type MapSurfaceController } from "@moritzbrantner/maps";

export function FleetMap() {
  const controllerRef = useRef<MapSurfaceController | null>(null);

  return (
    <>
      <button type="button" onClick={() => controllerRef.current?.fitPoints(points)}>
        Fit
      </button>
      <ClusteredMap
        onMapControllerReady={(controller) => {
          controllerRef.current = controller;
        }}
        points={points}
      />
    </>
  );
}
```

Use `fitBounds(...)`, `fitPoints(...)`, `fitGeoJson(...)`, or `flyTo(...)` for
programmatic viewport changes.

## Controlled Feature State

Feature hover and selection can be controlled with IDs. Existing callbacks such
as `onFeatureSelect` and `onFeatureHover` still receive the full feature.

```tsx
const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
const [hoveredFeatureId, setHoveredFeatureId] = useState<string | null>(null);

<ClusteredMap
  hoveredFeatureId={hoveredFeatureId}
  onHoveredFeatureIdChange={setHoveredFeatureId}
  onSelectedFeatureIdChange={setSelectedFeatureId}
  points={points}
  selectedFeatureId={selectedFeatureId}
/>;
```

## Legends

Legend components compose with the existing map overlay slots:

```tsx
import { HeatMap, MapColorRampLegend } from "@moritzbrantner/maps";

<HeatMap points={stations} valueMetric="temperature">
  <MapColorRampLegend
    stops={[[0, "#67e8f9"], [1, "#dc2626"]]}
    title="Temperature"
  />
</HeatMap>;
```

## Typed Properties

Use generics to preserve domain-specific properties through tooltips, popups,
and helper outputs.

```tsx
type StoreProperties = {
  demand: number;
  region: "north" | "south";
};

const stores: Array<MapPoint<StoreProperties>> = [
  {
    id: "store-a",
    latitude: 52.52,
    longitude: 13.405,
    properties: { demand: 42, region: "north" },
  },
];

<ClusteredMap<StoreProperties>
  points={stores}
  renderFeatureTooltip={(feature) => feature.point.properties.region}
/>;
```
