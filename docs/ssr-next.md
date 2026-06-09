# SSR And Next.js

React map entrypoints are client components and start with `"use client"`.
Render map components from client components only. Data-only helpers from
`@moritzbrantner/maps/core` can be used in server code.

## Server Component

```tsx
import { createPointAggregationIndex, type MapPoint } from "@moritzbrantner/maps/core";
import { ClientMap } from "./client-map";

export default async function Page() {
  const points: MapPoint[] = await loadPoints();
  const index = createPointAggregationIndex(points);
  const summary = index.getViewportAggregation({
    bounds: [-180, -90, 180, 90],
    zoom: 2,
  });

  return <ClientMap points={points} total={summary.totalCount} />;
}
```

## Client Component

```tsx
"use client";

import { ClusteredMap, type MapPoint } from "@moritzbrantner/maps";

export function ClientMap({
  points,
  total,
}: {
  points: MapPoint[];
  total: number;
}) {
  return <ClusteredMap points={points} style={{ height: 420 }} />;
}
```

## App Shell Styles

Import the package stylesheet once from the app shell, such as
`app/layout.tsx`:

```tsx
import "@moritzbrantner/maps/styles.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Do not import `@moritzbrantner/maps/styles.css` from package-internal modules or
deep paths. Use the public stylesheet export once at the app boundary.

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
- Import `@moritzbrantner/maps/styles.css` once from the app shell.
- The package stylesheet is compiled; server-safe `core` imports do not require CSS or Tailwind processing.
