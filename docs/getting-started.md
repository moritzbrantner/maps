# Getting Started

## Install

```sh
bun add @moritzbrantner/maps @moritzbrantner/ui react react-dom
```

```sh
npm install @moritzbrantner/maps @moritzbrantner/ui react react-dom
```

Import the maps stylesheet once in the app shell:

```ts
import "@moritzbrantner/maps/styles.css";
```

The package stylesheet imports Tailwind CSS and MapLibre GL CSS. Vite consumers
should include the Tailwind Vite plugin, or otherwise run Tailwind over app CSS,
so `@import "tailwindcss";` and package `@source` declarations are processed.

React, React DOM, and `@moritzbrantner/ui` are peer dependencies. The optional
`@moritzbrantner/timeline-editor` peer is only required when using timeline
editor components. Tailwind CSS stays in runtime dependencies because the
published stylesheet must resolve `@import "tailwindcss";`.

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

Set `mapDisplay="globe"` to render the same data on an orthographic globe:

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
