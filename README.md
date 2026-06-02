# @moritzbrantner/maps

React map components, density aggregation helpers, GeoJSON editing, and temporal
geo utilities for interactive spatial views.

## Install

```sh
bun add @moritzbrantner/maps @moritzbrantner/ui react react-dom
```

```sh
npm install @moritzbrantner/maps @moritzbrantner/ui react react-dom
```

Import the stylesheet once in your app shell:

```ts
import "@moritzbrantner/maps/styles.css";
```

Live demo: <https://moritzbrantner.github.io/maps/>

## Which Map Should I Use?

| Need | Use |
| --- | --- |
| Plain point markers | `PointMap` |
| Proportional point markers | `BubbleMap` |
| Dense point aggregation and clusters | `ClusteredMap` |
| Point density or scalar field surfaces | `HeatMap` / `HeatFieldMap` |
| Origin-destination connections | `FlowMap` |
| Mixed GeoJSON display | `GeoJsonMap` |
| Moving point tracks | `TemporalClusteredMap` / `TemporalHeatMap` |
| Multiple coordinated layers | `MapView` with `MapLayers` |
| Create, reshape, group, or delete GeoJSON | `EditableGeoJsonMap` |

## Minimal Example

```tsx
import "@moritzbrantner/maps/styles.css";
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

const points: MapPoint[] = [
  { id: "berlin", latitude: 52.52, longitude: 13.405, metrics: { demand: 42 } },
];

export function FleetMap() {
  return (
    <ClusteredMap
      defaultViewState={{ center: [13.405, 52.52], zoom: 8 }}
      points={points}
      style={{ height: 420 }}
    />
  );
}
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Entrypoints](docs/entrypoints.md)
- [GeoJSON](docs/geojson.md)
- [GeoJSON Editor](docs/editor.md)
- [Timeline And Temporal Maps](docs/timeline.md)
- [Performance](docs/performance.md)
- [SSR And Next.js](docs/ssr-next.md)
- [GeoJSON Transition Future Goals](docs/geojson-transition-future-goals.md)

## Runtime Notes

- React, React DOM, and `@moritzbrantner/ui` are peer dependencies.
- `@moritzbrantner/timeline-editor` is an optional peer used by timeline editor components.
- Tailwind CSS remains a runtime dependency because the shipped stylesheet imports it.
- Rendering map components requires browser DOM APIs and WebGL/canvas support.
- React map entrypoints are client components and start with `"use client"`.
- `@moritzbrantner/maps/styles.css` imports Tailwind CSS and MapLibre GL CSS.
- Data-only helpers from `@moritzbrantner/maps/core` can be used outside React.

## Verification

The release contract is:

```sh
bun run verify:fast
bun run test:browser
bun run verify:benchmarks
```
