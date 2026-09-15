import { describe, expect, it } from "vitest";

import { createCanvasMapScene as createMapScreenRenderFrame } from "./canvas-map-renderer";
import type { GeoJsonLayerFeature } from "./geojson-layer";
import { createGeoJsonVectorRenderFrame } from "./map-render-frame";

describe("MapScreenRenderFrame", () => {
  it("projects renderer-neutral primitives once while preserving semantic identity", () => {
    const features: GeoJsonLayerFeature<Record<string, unknown>>[] = [
      feature("point", { coordinates: [2, 3], type: "Point" }),
      feature("line", {
        coordinates: [
          [0, 1],
          [2, 4],
        ],
        type: "LineString",
      }),
      feature("polygon", {
        coordinates: [
          [
            [0, 0],
            [3, 0],
            [3, 2],
            [0, 0],
          ],
        ],
        type: "Polygon",
      }),
    ];
    const vectorFrame = createGeoJsonVectorRenderFrame(features, {
      primitivePrefix: "screen-frame",
    });

    const screenFrame = createMapScreenRenderFrame(
      vectorFrame,
      ([longitude, latitude]) => ({ x: longitude * 10 + 1, y: latitude * -5 + 2 }),
      { height: 480, width: 640 },
    );

    expect(screenFrame).toMatchObject({ height: 480, width: 640 });
    expect(screenFrame.primitives.map((primitive) => primitive.renderPrimitive.primitiveId)).toEqual(
      vectorFrame.primitives.map((primitive) => primitive.primitiveId),
    );
    expect(screenFrame.primitives[0]).toMatchObject({ kind: "circle", x: 21, y: -13 });
    expect(screenFrame.primitives[1]).toMatchObject({
      kind: "line",
      points: [
        { x: 1, y: -3 },
        { x: 21, y: -18 },
      ],
    });
    expect(screenFrame.primitives[2]).toMatchObject({
      kind: "polygon",
      rings: [
        [
          { x: 1, y: 2 },
          { x: 31, y: 2 },
          { x: 31, y: -8 },
          { x: 1, y: 2 },
        ],
      ],
    });
  });

  it("fails closed per primitive when authoritative projection cannot produce finite points", () => {
    const vectorFrame = createGeoJsonVectorRenderFrame([
      feature("valid", { coordinates: [1, 2], type: "Point" }),
      feature("invalid", {
        coordinates: [
          [3, 4],
          [5, 6],
        ],
        type: "LineString",
      }),
    ]);

    const screenFrame = createMapScreenRenderFrame(
      vectorFrame,
      ([longitude, latitude]) =>
        longitude === 5 ? null : { x: longitude, y: Number.isFinite(latitude) ? latitude : Number.NaN },
      { height: -1, width: -1 },
    );

    expect(screenFrame.width).toBe(0);
    expect(screenFrame.height).toBe(0);
    expect(screenFrame.primitives).toHaveLength(1);
    expect(screenFrame.primitives[0]?.renderPrimitive.featureId).toBe("valid");
  });
});

function feature(
  id: string,
  geometry: GeoJsonLayerFeature<Record<string, unknown>>["geometry"],
): GeoJsonLayerFeature<Record<string, unknown>> {
  return { geometry, id, properties: {}, sourceIndex: 0 };
}
