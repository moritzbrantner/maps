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

## Common Controls

Compose overlays with the built-in legend components and keep feature state
controlled when the surrounding app owns side panels, tables, or detail views.

```tsx
import {
  ClusteredMap,
  MapColorRampLegend,
  type MapSurfaceController,
} from "@moritzbrantner/maps";

let controller: MapSurfaceController | null = null;

<ClusteredMap
  onMapControllerReady={(next) => {
    controller = next;
  }}
  onSelectedFeatureIdChange={(featureId) => setSelectedId(featureId)}
  points={points}
  selectedFeatureId={selectedId}
>
  <MapColorRampLegend
    stops={[[0, "#67e8f9"], [1, "#dc2626"]]}
    title="Demand"
  />
</ClusteredMap>;

controller?.fitPoints(points, { padding: 72 });
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Entrypoints](docs/entrypoints.md)
- [API Stability](docs/api-stability.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Recipes](docs/recipes.md)
- [GeoJSON](docs/geojson.md)
- [GeoJSON Editor](docs/editor.md)
- [Timeline And Temporal Maps](docs/timeline.md)
- [Performance](docs/performance.md)
- [SSR And Next.js](docs/ssr-next.md)
- [GeoJSON Transition Future Goals](docs/geojson-transition-future-goals.md)

## Runtime Notes

- Rendered React maps require the `react`, `react-dom`, and
  `@moritzbrantner/ui` peer dependencies.
- `@moritzbrantner/timeline-editor` is an optional peer required only for
  timeline editor components.
- MapLibre, Three, Turf helpers, supercluster, d3-delaunay, polygon-clipping,
  and related map/runtime packages are included as package dependencies.
- Rendering map components requires browser DOM APIs and WebGL/canvas support.
- React map entrypoints are client components and start with `"use client"`.
- `@moritzbrantner/maps/styles.css` is compiled CSS that includes package styles
  and MapLibre GL CSS.
- `@moritzbrantner/maps/core` is intended for data-only usage and must remain
  free of React, DOM, MapLibre, Three, `@moritzbrantner/ui`, and timeline editor
  runtime imports.

## Verification

The release contract is:

```sh
bun run verify:fast
bun run test:browser
bun run verify:benchmarks
```
