# SSR And Next.js

React map entrypoints are client components and start with `"use client"`.
Render map components from client components only. Data-only helpers from
`@moritzbrantner/maps/core` can be used in server code.

## Client Component

```tsx
"use client";

import "@moritzbrantner/maps/styles.css";
import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

const points: MapPoint[] = [{ id: "berlin", latitude: 52.52, longitude: 13.405 }];

export function ClientMap() {
  return <ClusteredMap points={points} style={{ height: 420 }} />;
}
```

## Server-Safe Helpers

```ts
import { createPointAggregationIndex } from "@moritzbrantner/maps/core";

export function summarizePoints(points) {
  return createPointAggregationIndex(points).getAggregation({
    bounds: [-180, -90, 180, 90],
    zoom: 2,
  });
}
```

## Runtime Requirements

- Browser DOM APIs are required for rendered maps.
- WebGL/canvas support is required for MapLibre and globe surfaces.
- Import `@moritzbrantner/maps/styles.css` once in a client app shell.
- The package stylesheet is compiled; server-safe `core` imports do not require CSS or Tailwind processing.
