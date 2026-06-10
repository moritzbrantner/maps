import { describe, expect, test } from "vitest";

import {
  clipGeoJsonToPolygon,
  differenceGeoJsonFeatures,
  findContainingGeoJsonFeatures,
  findOverlappingGeoJsonFeatures,
  getGeoJsonIntersections,
  intersectGeoJsonFeatures,
  unionGeoJsonFeatures,
  type GeoJsonMapSource,
  type GeoJsonPosition,
  type TemporalGeoJsonGeometryFeature,
} from ".";

describe("@moritzbrantner/maps GeoJSON operations", () => {
  test("intersects overlapping squares and reports area", () => {
    const result = intersectGeoJsonFeatures(
      polygonFeature("left", squareRing(0, 0, 2, 2)),
      polygonFeature("right", squareRing(1, 1, 3, 3)),
    );

    expect(result.issues).toEqual([]);
    expect(result.collection.features).toHaveLength(1);
    expect(result.collection.features[0]?.geometry).toEqual({
      coordinates: [
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
          [1, 1],
        ],
      ],
      type: "Polygon",
    });
    expect(result.collection.features[0]?.properties?.area).toBe(1);
  });

  test("returns an empty collection for disjoint polygon intersections", () => {
    const result = intersectGeoJsonFeatures(
      polygonFeature("left", squareRing(0, 0, 1, 1)),
      polygonFeature("right", squareRing(2, 2, 3, 3)),
    );

    expect(result.collection.features).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  test("unions adjacent polygons into one result feature", () => {
    const result = unionGeoJsonFeatures([
      polygonFeature("left", squareRing(0, 0, 1, 1)),
      polygonFeature("right", squareRing(1, 0, 2, 1)),
    ]);

    expect(result.issues).toEqual([]);
    expect(result.collection.features).toHaveLength(1);
    expect(result.collection.features[0]?.properties?.area).toBe(2);
  });

  test("subtracts a mask from a subject polygon", () => {
    const result = differenceGeoJsonFeatures(
      polygonFeature("subject", squareRing(0, 0, 4, 4)),
      polygonFeature("mask", squareRing(1, 1, 3, 3)),
    );

    expect(result.issues).toEqual([]);
    expect(result.collection.features).toHaveLength(1);
    expect(result.collection.features[0]?.properties?.area).toBe(12);
  });

  test("clips one output feature per source polygon", () => {
    const result = clipGeoJsonToPolygon(
      collection([
        polygonFeature("a", squareRing(0, 0, 3, 3)),
        polygonFeature("b", squareRing(2, 0, 5, 3)),
      ]),
      polygonFeature("mask", squareRing(1, 1, 4, 2)),
    );

    expect(result.issues).toEqual([]);
    expect(result.collection.features).toHaveLength(2);
    expect(result.collection.features.map((feature) => feature.properties?.area)).toEqual([2, 2]);
  });

  test("skips non-polygon inputs with warning issues", () => {
    const result = unionGeoJsonFeatures([
      polygonFeature("poly", squareRing(0, 0, 1, 1)),
      {
        geometry: { coordinates: [0, 0], type: "Point" },
        id: "point",
        properties: {},
        type: "Feature",
      },
    ]);

    expect(result.collection.features).toHaveLength(1);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "skipped-non-polygon",
        featureId: "point",
      }),
    ]);
  });

  test("uses polygon children from GeometryCollection inputs", () => {
    const result = unionGeoJsonFeatures([
      {
        geometry: {
          geometries: [
            { coordinates: [10, 10], type: "Point" },
            { coordinates: [squareRing(0, 0, 1, 1)], type: "Polygon" },
          ],
          type: "GeometryCollection",
        },
        id: "collection",
        properties: {},
        type: "Feature",
      },
    ]);

    expect(result.collection.features).toHaveLength(1);
    expect(result.collection.features[0]?.properties?.area).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toEqual(["skipped-non-polygon"]);
  });

  test("invalid polygon inputs return an issue and empty result", () => {
    const result = unionGeoJsonFeatures([
      {
        geometry: { coordinates: [], type: "Polygon" },
        id: "invalid",
        properties: {},
        type: "Feature",
      },
    ]);

    expect(result.collection.features).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "invalid-geometry",
        featureId: "invalid",
      }),
    ]);
  });

  test("supports MultiPolygon inputs", () => {
    const result = unionGeoJsonFeatures([
      {
        geometry: {
          coordinates: [[squareRing(0, 0, 1, 1)], [squareRing(2, 0, 3, 1)]],
          type: "MultiPolygon",
        },
        id: "multi",
        properties: {},
        type: "Feature",
      },
    ]);

    expect(result.issues).toEqual([]);
    expect(result.collection.features[0]?.geometry?.type).toBe("MultiPolygon");
    expect(result.collection.features[0]?.properties?.area).toBe(2);
  });
});

describe("@moritzbrantner/maps GeoJSON relationship helpers", () => {
  test("finds point containment inside polygons", () => {
    const records = findContainingGeoJsonFeatures(
      collection([pointFeature("point", [1, 1])]),
      collection([polygonFeature("polygon", squareRing(0, 0, 2, 2))]),
    );

    expect(records).toEqual([
      expect.objectContaining({
        pointFeatureId: "point",
        polygonFeatureId: "polygon",
      }),
    ]);
  });

  test("excludes points inside polygon holes", () => {
    const records = findContainingGeoJsonFeatures(
      collection([pointFeature("point", [2, 2])]),
      collection([
        polygonFeature("polygon", squareRing(0, 0, 4, 4), [squareRing(1, 1, 3, 3)]),
      ]),
    );

    expect(records).toEqual([]);
  });

  test("counts shell boundary points by default and excludes them when requested", () => {
    const points = collection([pointFeature("point", [0, 1])]);
    const polygons = collection([polygonFeature("polygon", squareRing(0, 0, 2, 2))]);

    expect(findContainingGeoJsonFeatures(points, polygons)).toHaveLength(1);
    expect(findContainingGeoJsonFeatures(points, polygons, { includeBoundary: false })).toEqual([]);
  });

  test("returns one containment record per contained MultiPoint coordinate", () => {
    const records = findContainingGeoJsonFeatures(
      collection([
        {
          geometry: {
            coordinates: [
              [1, 1],
              [3, 3],
              [0.5, 0.5],
            ],
            type: "MultiPoint",
          },
          id: "points",
          properties: {},
          type: "Feature",
        },
      ]),
      collection([polygonFeature("polygon", squareRing(0, 0, 2, 2))]),
    );

    expect(records.map((record) => record.pointIndex)).toEqual([0, 2]);
  });

  test("reports polygon intersections with ratios", () => {
    const records = getGeoJsonIntersections(
      collection([polygonFeature("left", squareRing(0, 0, 2, 2))]),
      collection([polygonFeature("right", squareRing(1, 1, 3, 3))]),
    );

    expect(records).toEqual([
      expect.objectContaining({
        area: 1,
        leftId: "left",
        ratioOfLeft: 0.25,
        ratioOfRight: 0.25,
        rightId: "right",
      }),
    ]);
  });

  test("overlap detection ignores duplicate reverse pairs", () => {
    const records = findOverlappingGeoJsonFeatures(
      collection([
        polygonFeature("a", squareRing(0, 0, 2, 2)),
        polygonFeature("b", squareRing(1, 1, 3, 3)),
      ]),
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({ leftId: "a", rightId: "b" }));
  });

  test("boundary-touching polygons are not overlap records", () => {
    const records = findOverlappingGeoJsonFeatures(
      collection([
        polygonFeature("a", squareRing(0, 0, 1, 1)),
        polygonFeature("b", squareRing(1, 0, 2, 1)),
      ]),
    );

    expect(records).toEqual([]);
  });
});

function collection(
  features: Array<TemporalGeoJsonGeometryFeature<Record<string, unknown>>>,
): GeoJsonMapSource {
  return { features, type: "FeatureCollection" };
}

function pointFeature(id: string, coordinates: GeoJsonPosition): TemporalGeoJsonGeometryFeature {
  return {
    geometry: { coordinates, type: "Point" },
    id,
    properties: {},
    type: "Feature",
  };
}

function polygonFeature(
  id: string,
  shell: GeoJsonPosition[],
  holes: GeoJsonPosition[][] = [],
): TemporalGeoJsonGeometryFeature {
  return {
    geometry: {
      coordinates: [shell, ...holes],
      type: "Polygon",
    },
    id,
    properties: {},
    type: "Feature",
  };
}

function squareRing(minX: number, minY: number, maxX: number, maxY: number): GeoJsonPosition[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}
