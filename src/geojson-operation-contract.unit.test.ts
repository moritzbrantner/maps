import { expect, test } from "vitest";
import {
  unionGeoJsonFeatures,
  differenceGeoJsonFeatures,
  intersectGeoJsonFeatures,
  clipGeoJsonToPolygon,
  getGeoJsonPolygonMeasurements,
  getGeoJsonIntersections,
  findContainingGeoJsonFeatures,
  findOverlappingGeoJsonFeatures,
  resolveGeoJsonPolygonOverlaps,
  simplifyGeoJsonPolygons,
  createGeoJsonPolygonOutlines,
} from "./entries/core";
import type { GeoJsonPosition, TemporalGeoJsonGeometryFeature } from "./temporal-geojson-types";
const polygon = (ring: GeoJsonPosition[]): TemporalGeoJsonGeometryFeature => ({
  type: "Feature",
  id: "region",
  geometry: { type: "Polygon", coordinates: [ring] },
});
const valid = polygon([
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 2],
  [0, 0],
]);
const crossing = polygon([
  [179, 0],
  [-179, 0],
  [-179, 1],
  [179, 1],
  [179, 0],
]);
const source = (features: TemporalGeoJsonGeometryFeature[]) => ({
  type: "FeatureCollection" as const,
  features,
});

test("static operations fail closed on unsupported antimeridian inputs without mutating either operand", () => {
  const before = structuredClone([valid, crossing]);
  const input = source([valid, crossing]);
  const results = [
    unionGeoJsonFeatures(input),
    differenceGeoJsonFeatures(valid, crossing),
    intersectGeoJsonFeatures(valid, crossing),
    clipGeoJsonToPolygon(valid, crossing),
    resolveGeoJsonPolygonOverlaps(input),
    simplifyGeoJsonPolygons(input, { tolerance: 0.01 }),
    createGeoJsonPolygonOutlines(input),
  ];
  for (const result of results) {
    expect(result.collection.features).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "unsupported-antimeridian", featureId: "region" }),
    ]);
  }
  expect([valid, crossing]).toEqual(before);
});

test("bare relationship and measurement APIs throw typed unsupported diagnostics", () => {
  const input = source([crossing]);
  for (const operation of [
    () => getGeoJsonPolygonMeasurements(input),
    () => getGeoJsonIntersections(source([valid]), input),
    () => findOverlappingGeoJsonFeatures(input),
    () =>
      findContainingGeoJsonFeatures(
        source([{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } }]),
        input,
      ),
  ]) {
    expect(operation).toThrowError(expect.objectContaining({ code: "unsupported-antimeridian" }));
  }
});

test("invalid geometry cannot silently become an empty difference mask or partial union", () => {
  const invalid = polygon([
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  for (const result of [
    differenceGeoJsonFeatures(valid, invalid),
    unionGeoJsonFeatures(source([valid, invalid])),
  ]) {
    expect(result.collection.features).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid-geometry" })]);
  }
});

test("touching boundaries have zero overlap and containment includes boundary only when requested", () => {
  const adjacent = polygon([
    [2, 0],
    [3, 0],
    [3, 2],
    [2, 2],
    [2, 0],
  ]);
  expect(getGeoJsonIntersections(source([valid]), source([adjacent]))).toEqual([]);
  expect(unionGeoJsonFeatures([valid, adjacent]).collection.features[0]?.properties?.area).toBe(6);
  const points = source([{ type: "Feature", geometry: { type: "Point", coordinates: [2, 1] } }]);
  expect(findContainingGeoJsonFeatures(points, source([valid]))).toHaveLength(1);
  expect(
    findContainingGeoJsonFeatures(points, source([valid]), { includeBoundary: false }),
  ).toEqual([]);
});

test("public static example subtracts a hole then applies the shared regional transform", async () => {
  const { rotateGeoJsonFeature } = await import("./entries/core");
  const region = polygon([
    [10, 50],
    [10.2, 50],
    [10.2, 50.2],
    [10, 50.2],
    [10, 50],
  ]);
  const mask = polygon([
    [10.05, 50.05],
    [10.1, 50.05],
    [10.1, 50.1],
    [10.05, 50.1],
    [10.05, 50.05],
  ]);
  const difference = differenceGeoJsonFeatures(region, mask);
  expect(difference.issues).toEqual([]);
  const transformed = difference.collection.features.map((feature) =>
    rotateGeoJsonFeature(feature, { degrees: 30, pivot: [10.1, 50.1] }),
  );
  expect(transformed).toHaveLength(1);
  expect(transformed[0]?.geometry).toMatchObject({
    type: "Polygon",
    coordinates: [expect.any(Array), expect.any(Array)],
  });
  expect(transformed[0]?.id).toBe(difference.collection.features[0]?.id);
});

test("a degenerate ring or multipart member cannot hide inside otherwise valid polygon area", () => {
  const line: GeoJsonPosition[] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [0, 0],
  ];
  const shell: GeoJsonPosition[] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ];
  for (const geometry of [
    { type: "MultiPolygon" as const, coordinates: [[shell], [line]] },
    { type: "Polygon" as const, coordinates: [shell, line] },
  ]) {
    const feature = { type: "Feature" as const, geometry };
    const before = structuredClone(feature);
    const result = differenceGeoJsonFeatures(valid, feature);
    expect(result.collection.features).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid-geometry" })]);
    expect(feature).toEqual(before);
  }
});
