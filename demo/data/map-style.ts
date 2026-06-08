import type { RasterMapStyle } from "@moritzbrantner/maps";

const e2eMapStyle = {
  layers: [
    {
      id: "demo-ocean",
      paint: {
        "background-color": "#082f49",
      },
      type: "background",
    },
    {
      id: "demo-land-fill",
      paint: {
        "fill-color": "#4ade80",
        "fill-opacity": 0.72,
      },
      source: "demo-land",
      type: "fill",
    },
    {
      id: "demo-land-line",
      paint: {
        "line-color": "#ecfeff",
        "line-opacity": 0.7,
        "line-width": 1.2,
      },
      source: "demo-land",
      type: "line",
    },
    {
      id: "demo-graticule",
      paint: {
        "line-color": "#bae6fd",
        "line-opacity": 0.32,
        "line-width": 0.8,
      },
      source: "demo-graticule",
      type: "line",
    },
  ],
  sources: {
    "demo-graticule": {
      data: {
        features: [
          ...[-120, -60, 0, 60, 120].map((longitude) => ({
            geometry: {
              coordinates: [
                [longitude, -70],
                [longitude, 70],
              ],
              type: "LineString",
            },
            properties: {},
            type: "Feature",
          })),
          ...[-45, 0, 45].map((latitude) => ({
            geometry: {
              coordinates: [
                [-180, latitude],
                [180, latitude],
              ],
              type: "LineString",
            },
            properties: {},
            type: "Feature",
          })),
        ],
        type: "FeatureCollection",
      },
      type: "geojson",
    },
    "demo-land": {
      data: {
        features: [
          {
            geometry: {
              coordinates: [[[-18, 34], [42, 34], [42, 72], [-18, 72], [-18, 34]]],
              type: "Polygon",
            },
            properties: { name: "Europe" },
            type: "Feature",
          },
          {
            geometry: {
              coordinates: [[[-130, 24], [-62, 24], [-62, 55], [-130, 55], [-130, 24]]],
              type: "Polygon",
            },
            properties: { name: "North America" },
            type: "Feature",
          },
          {
            geometry: {
              coordinates: [[[68, 6], [150, 6], [150, 58], [68, 58], [68, 6]]],
              type: "Polygon",
            },
            properties: { name: "Asia" },
            type: "Feature",
          },
          {
            geometry: {
              coordinates: [[[-82, -55], [-34, -55], [-34, 12], [-82, 12], [-82, -55]]],
              type: "Polygon",
            },
            properties: { name: "South America" },
            type: "Feature",
          },
          {
            geometry: {
              coordinates: [[[-18, -35], [52, -35], [52, 34], [-18, 34], [-18, -35]]],
              type: "Polygon",
            },
            properties: { name: "Africa" },
            type: "Feature",
          },
        ],
        type: "FeatureCollection",
      },
      type: "geojson",
    },
  },
  version: 8,
} satisfies RasterMapStyle;

export const demoMapStyle: RasterMapStyle | undefined =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("e2e")
    ? e2eMapStyle
    : undefined;
