import type { TemporalGeoJsonGeometryFeatureCollection } from "@moritzbrantner/maps";

import type { DemoGeoJsonProperties } from "../types";

export const demoGeoJsonCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> =
  {
    features: [
      geoJsonFeature("geojson-point", "Point", "Paris checkpoint", {
        coordinates: [2.3522, 48.8566],
        type: "Point",
      }),
      geoJsonFeature("geojson-line", "LineString", "Rhine freight corridor", {
        coordinates: [
          [7.5886, 47.5596],
          [7.4653, 50.0014],
          [6.9603, 50.9375],
          [6.7735, 51.2277],
        ],
        type: "LineString",
      }),
      geoJsonFeature("geojson-multiline", "MultiLineString", "Nordic connectors", {
        coordinates: [
          [
            [10.7522, 59.9139],
            [12.5683, 55.6761],
          ],
          [
            [18.0686, 59.3293],
            [24.9384, 60.1699],
          ],
        ],
        type: "MultiLineString",
      }),
      geoJsonFeature("geojson-polygon", "Polygon", "Alpine service zone", {
        coordinates: [
          [
            [6.4, 45.6],
            [12.2, 45.6],
            [12.2, 48.6],
            [6.4, 48.6],
            [6.4, 45.6],
          ],
        ],
        type: "Polygon",
      }),
      geoJsonFeature("geojson-multipolygon", "MultiPolygon", "Iberian operating areas", {
        coordinates: [
          [
            [
              [-4.4, 39.5],
              [-2.8, 39.5],
              [-2.8, 41.1],
              [-4.4, 41.1],
              [-4.4, 39.5],
            ],
          ],
          [
            [
              [1.5, 40.8],
              [2.9, 40.8],
              [2.9, 42.0],
              [1.5, 42.0],
              [1.5, 40.8],
            ],
          ],
        ],
        type: "MultiPolygon",
      }),
    ],
    type: "FeatureCollection",
  };

function geoJsonFeature(
  trackId: string,
  kind: DemoGeoJsonProperties["kind"],
  label: string,
  geometry: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>["features"][number]["geometry"],
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>["features"][number] {
  return {
    geometry,
    properties: {
      kind,
      label,
      time: 0,
      trackId,
    },
    type: "Feature",
  };
}
