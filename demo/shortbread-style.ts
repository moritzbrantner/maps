import type { GeoJsonLayerStyle } from "../src/geojson-layer";
import type {
  ShortbreadBasemapLineKind,
  ShortbreadBasemapPolygonKind,
} from "../src/vector-tile-wasm";

export type ShortbreadFeatureProperties = {
  kind: ShortbreadBasemapLineKind | ShortbreadBasemapPolygonKind;
  sourceKind: string | null;
};

// Style order spans all visible tiles, independent of protobuf layer order.
export const POLYGON_PAINT_ORDER: readonly ShortbreadBasemapPolygonKind[] = [
  "ocean",
  "land",
  "site",
  "water",
  "building",
];

export function getShortbreadBasemapStyle(
  kind: ShortbreadFeatureProperties["kind"],
  sourceKind: string | null = null,
): GeoJsonLayerStyle {
  switch (kind) {
    case "ocean":
      return polygonStyle("#a8cce0");
    case "land":
      return polygonStyle(sourceKind === "forest" ? "#c4d8b4" : "#dce4cc");
    case "site":
      return polygonStyle("#e4dccf");
    case "building":
      return { ...polygonStyle("#d8c8b8"), polygonStrokeColor: "#b9a895", polygonStrokeWidth: 0.6 };
    case "coast":
      return { lineColor: "#4f93b8", lineOpacity: 0.95, lineWidth: 1.5 };
    case "water":
      return {
        ...polygonStyle(sourceKind === "glacier" ? "#e5f0f5" : "#a8cce0"),
        lineColor: "#6ba9c9",
        lineOpacity: 0.9,
        lineWidth: 1.2,
      };
    case "boundary":
      return { lineColor: "#b27188", lineOpacity: 0.75, lineWidth: 1 };
    case "street":
      return { lineColor: "#9a8c7d", lineOpacity: 0.72, lineWidth: 0.9 };
  }
}

function polygonStyle(polygonFillColor: string): GeoJsonLayerStyle {
  return { polygonFillColor, polygonFillOpacity: 1, polygonStrokeWidth: 0 };
}
