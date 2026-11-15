import type { MapBounds, MapPoint } from "../../src";

import type { DemoPointProperties } from "../types";

/** Synthetic stations inside the content-pinned Liechtenstein Atlas (#270).
 * These are not historical weather observations; the geometry is real, values illustrative.
 */
export const demoAtlasTemperatureBounds: MapBounds = [9.47, 47.04, 9.64, 47.28];

const stations = [
  ["Balzers", 47.067, 9.503, 24],
  ["Triesen", 47.108, 9.532, 22],
  ["Vaduz", 47.141, 9.522, 20],
  ["Schaan", 47.165, 9.508, 19],
  ["Eschen", 47.21, 9.526, 18],
  ["Mauren", 47.217, 9.543, 17],
  ["Ruggell", 47.246, 9.544, 16],
  ["Malbun", 47.103, 9.61, 14],
] as const;

export const demoAtlasTemperaturePoints: Array<MapPoint<DemoPointProperties>> = stations.map(
  ([city, latitude, longitude, temperature]) => ({
    id: `atlas-temperature-${city.toLowerCase()}`,
    label: city,
    latitude,
    longitude,
    metrics: { temperature },
    properties: { city, region: "Liechtenstein" },
  }),
);
