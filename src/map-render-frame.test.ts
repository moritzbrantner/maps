import { describe, expect, it } from "vitest";

import type { GeoJsonLayerFeature } from "./geojson-layer";
import {
  createGeoJsonVectorRenderFrame,
  createPointClusterVectorRenderFrame,
} from "./map-render-frame";
import type { MapPointClusterRenderFrame } from "./point-cluster-render-frame";

describe("MapVectorRenderFrame", () => {
  it("adapts point and cluster semantics without changing feature identity", () => {
    const pointFeature = { kind: "point", point: { id: "p-1" } };
    const clusterFeature = { clusterId: 7, kind: "cluster", pointCount: 12 };
    const frame = {
      features: [
        {
          coordinates: [10, 20],
          feature: pointFeature,
          fillColor: "#111111",
          id: "point:p-1",
          kind: "point",
          label: null,
          radius: 6,
        },
        {
          coordinates: [30, 40],
          expansionZoom: 9,
          feature: clusterFeature,
          fillColor: "#222222",
          id: "cluster:7",
          kind: "cluster",
          label: "12",
          radius: 18,
        },
      ],
      kind: "point-cluster",
      summary: {},
    } as unknown as MapPointClusterRenderFrame<Record<string, unknown>>;

    const result = createPointClusterVectorRenderFrame(frame, { primitivePrefix: "layer-a" });

    expect(result.kind).toBe("vector");
    expect(result.primitives).toHaveLength(2);
    expect(result.primitives[0]).toMatchObject({
      center: [10, 20],
      feature: pointFeature,
      featureId: "point:p-1",
      kind: "circle",
      label: null,
      primitiveId: "layer-a:point:p-1",
    });
    expect(result.primitives[1]).toMatchObject({
      center: [30, 40],
      feature: clusterFeature,
      featureId: "cluster:7",
      kind: "circle",
      label: "12",
      primitiveId: "layer-a:cluster:7",
    });
  });

  it("expands multi-part GeoJSON while preserving one semantic feature identity", () => {
    const feature = geoJsonFeature("roads", {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    });

    const result = createGeoJsonVectorRenderFrame([feature], {
      getFeatureId: () => "semantic-road",
      primitivePrefix: "roads-layer",
    });

    expect(result.primitives.map((primitive) => primitive.featureId)).toEqual([
      "semantic-road",
      "semantic-road",
    ]);
    expect(result.primitives.map((primitive) => primitive.primitiveId)).toEqual([
      "roads-layer:semantic-road:line:0",
      "roads-layer:semantic-road:line:1",
    ]);
    expect(result.primitives.every((primitive) => primitive.feature === feature)).toBe(true);
  });

  it("normalizes point, line and polygon geometry into typed base visual policy", () => {
    const features = [
      geoJsonFeature("point", { type: "Point", coordinates: [1, 2] }),
      geoJsonFeature("line", {
        type: "LineString",
        coordinates: [
          [0, 0],
          [2, 2],
        ],
      }),
      geoJsonFeature("polygon", {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 0],
          ],
        ],
      }),
    ];

    const result = createGeoJsonVectorRenderFrame(features, {
      style: {
        lineColor: "line",
        lineOpacity: 0.5,
        lineWidth: 3,
        pointColor: "point",
        pointRadius: 5,
        polygonFillColor: "fill",
        polygonFillOpacity: 0.25,
        polygonStrokeColor: "stroke",
        polygonStrokeWidth: 2,
      },
    });

    expect(result.primitives[0]).toMatchObject({
      fillColor: "point",
      kind: "circle",
      radius: 5,
    });
    expect(result.primitives[1]).toMatchObject({
      kind: "line",
      strokeColor: "line",
      strokeOpacity: 0.5,
      strokeWidth: 3,
    });
    expect(result.primitives[2]).toMatchObject({
      fillColor: "fill",
      fillOpacity: 0.25,
      kind: "polygon",
      strokeColor: "stroke",
      strokeWidth: 2,
    });
  });

  it("propagates feature interaction eligibility without changing geometry", () => {
    const interactive = geoJsonFeature("interactive", { type: "Point", coordinates: [1, 1] });
    const passive = geoJsonFeature("passive", { type: "Point", coordinates: [2, 2] });

    const result = createGeoJsonVectorRenderFrame([interactive, passive], {
      isFeatureInteractive: (feature) => feature.id !== "passive",
    });

    expect(result.primitives.map((primitive) => [primitive.featureId, primitive.interactive])).toEqual([
      ["interactive", true],
      ["passive", false],
    ]);
  });

  it("gives every MultiPoint and MultiPolygon part a unique primitive id", () => {
    const multiPoint = geoJsonFeature("points", {
      type: "MultiPoint",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    const multiPolygon = geoJsonFeature("areas", {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        [
          [
            [2, 2],
            [3, 2],
            [3, 3],
            [2, 2],
          ],
        ],
      ],
    });

    const result = createGeoJsonVectorRenderFrame([multiPoint, multiPolygon]);
    const ids = result.primitives.map((primitive) => primitive.primitiveId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(result.primitives.map((primitive) => primitive.featureId)).toEqual([
      "points",
      "points",
      "areas",
      "areas",
    ]);
  });
});

function geoJsonFeature(
  id: string,
  geometry: GeoJsonLayerFeature<Record<string, unknown>>["geometry"],
): GeoJsonLayerFeature<Record<string, unknown>> {
  return { geometry, id, properties: {}, sourceIndex: 0 };
}
