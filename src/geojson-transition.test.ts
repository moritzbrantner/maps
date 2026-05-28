import { describe, expect, test } from "vitest";

import {
  createGeoJsonTransitionPlan,
  interpolateGeoJsonTransitionPlan,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonGeometryFeatureCollection,
} from ".";

describe("@moritzbrantner/maps GeoJSON transitions", () => {
  test("interpolates compatible point geometry", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("point", { coordinates: [0, 0], type: "Point" })]),
        collection([feature("point", { coordinates: [10, 6], type: "Point" })]),
        { algorithm: "compatible" },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual({
      coordinates: [5, 3],
      type: "Point",
    });
  });

  test("resamples LineStrings with different vertex counts", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("route", {
            coordinates: [
              [0, 0],
              [10, 0],
            ],
            type: "LineString",
          }),
        ]),
        collection([
          feature("route", {
            coordinates: [
              [0, 10],
              [5, 15],
              [10, 10],
            ],
            type: "LineString",
          }),
        ]),
        { algorithm: "resample", minCoordinatesPerLine: 3 },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual({
      coordinates: [
        [0, 5],
        [5, 7.5],
        [10, 5],
      ],
      type: "LineString",
    });
  });

  test("interpolates compatible polygons", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("zone", square(0, 0, 4, 4))]),
        collection([feature("zone", square(2, 2, 6, 6))]),
        { algorithm: "compatible" },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual(square(1, 1, 5, 5));
  });

  test("vertex-union preserves source and target vertices on stable polygons", () => {
    const polygon = {
      coordinates: [
        [
          [1, 1],
          [7, 0],
          [9, 5],
          [5, 9],
          [0, 6],
          [1, 1],
        ],
      ],
      type: "Polygon" as const,
    };
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(collection([feature("stable", polygon)]), collection([feature("stable", polygon)]), {
        algorithm: "vertex-union",
        minCoordinatesPerRing: 4,
      }),
      0.5,
    );
    const ring = getPolygonRing(frame.features[0], 0);

    for (const point of polygon.coordinates[0].slice(0, -1)) {
      expect(ring).toContainEqual(point);
    }
  });

  test("vertex-union collapses disappearing holes to their centroid", () => {
    const from = {
      coordinates: [
        squareRing(0, 0, 10, 10),
        squareRing(3, 3, 7, 7),
      ],
      type: "Polygon" as const,
    };
    const to = {
      coordinates: [squareRing(0, 0, 10, 10)],
      type: "Polygon" as const,
    };
    const end = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(collection([feature("hole", from)]), collection([feature("hole", to)]), {
        algorithm: "vertex-union",
      }),
      1,
    );
    const hole = getPolygonRing(end.features[0], 1);

    expect(hole.every((position) => positionsEqual(position, [5, 5]))).toBe(true);
  });

  test("vertex-union grows appearing holes from their centroid", () => {
    const from = {
      coordinates: [squareRing(0, 0, 10, 10)],
      type: "Polygon" as const,
    };
    const to = {
      coordinates: [
        squareRing(0, 0, 10, 10),
        squareRing(3, 3, 7, 7),
      ],
      type: "Polygon" as const,
    };
    const start = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(collection([feature("hole", from)]), collection([feature("hole", to)]), {
        algorithm: "vertex-union",
      }),
      0,
    );
    const hole = getPolygonRing(start.features[0], 1);

    expect(hole.every((position) => positionsEqual(position, [5, 5]))).toBe(true);
  });

  test("interpolates MultiPolygon parts deterministically", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("multi", {
            coordinates: [[squareRing(0, 0, 4, 4)], [squareRing(10, 0, 14, 4)]],
            type: "MultiPolygon",
          }),
        ]),
        collection([
          feature("multi", {
            coordinates: [[squareRing(2, 2, 6, 6)], [squareRing(12, 2, 16, 6)]],
            type: "MultiPolygon",
          }),
        ]),
        { algorithm: "compatible" },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual({
      coordinates: [[squareRing(1, 1, 5, 5)], [squareRing(11, 1, 15, 5)]],
      type: "MultiPolygon",
    });
  });

  test("uses hold and hide fallback for incompatible geometry types", () => {
    const from = collection([feature("shape", { coordinates: [0, 0], type: "Point" })]);
    const to = collection([feature("shape", square(0, 0, 4, 4))]);

    expect(
      interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(from, to, { algorithm: "compatible", fallback: "hold" }),
        0.5,
      ).features[0]?.geometry,
    ).toEqual({ coordinates: [0, 0], type: "Point" });
    expect(
      interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(from, to, { algorithm: "compatible", fallback: "hide" }),
        0.5,
      ).features,
    ).toEqual([]);
  });

  test("topology-plan emits preserve, disappear, and appear fragments for overlapping rectangles", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("from", square(0, 0, 6, 4))]),
        collection([feature("to", square(4, 2, 10, 6))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );
    const kinds = frame.features.map((item) => item.properties?.transitionKind).sort();

    expect(kinds).toEqual(["appear", "disappear", "preserve"]);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan emits split and merge fragments", () => {
    const split = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 8, 4))]),
        collection([feature("left", square(0, 0, 4, 4)), feature("right", square(4, 0, 8, 4))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );
    const merge = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("left", square(0, 0, 4, 4)), feature("right", square(4, 0, 8, 4))]),
        collection([feature("target", square(0, 0, 8, 4))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );

    expect(split.features.every((item) => item.properties?.transitionKind === "split")).toBe(true);
    expect(merge.features.every((item) => item.properties?.transitionKind === "merge")).toBe(true);
    expectGeometriesAreFiniteAndClosed(split);
    expectGeometriesAreFiniteAndClosed(merge);
  });
});

function collection(
  features: TemporalGeoJsonGeometryFeature[],
): TemporalGeoJsonGeometryFeatureCollection {
  return {
    features,
    type: "FeatureCollection",
  };
}

function feature(
  id: string,
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): TemporalGeoJsonGeometryFeature {
  return {
    geometry,
    id,
    properties: null,
    type: "Feature",
  };
}

function square(west: number, south: number, east: number, north: number) {
  return {
    coordinates: [squareRing(west, south, east, north)],
    type: "Polygon" as const,
  };
}

function squareRing(west: number, south: number, east: number, north: number) {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ] satisfies Array<[number, number]>;
}

function positionsEqual(left: readonly number[], right: readonly number[]) {
  return Math.abs(left[0]! - right[0]!) < 1e-9 && Math.abs(left[1]! - right[1]!) < 1e-9;
}

function getPolygonRing(
  feature: TemporalGeoJsonGeometryFeature | undefined,
  index: number,
): Array<[number, number]> {
  expect(feature?.geometry?.type).toBe("Polygon");

  return (
    feature!.geometry as {
      coordinates: Array<Array<[number, number]>>;
      type: "Polygon";
    }
  ).coordinates[index] ?? [];
}

function expectGeometriesAreFiniteAndClosed(collection: TemporalGeoJsonGeometryFeatureCollection) {
  for (const item of collection.features) {
    const geometry = item.geometry as
      | {
          coordinates?: unknown;
          type: string;
        }
      | null;
    const coordinates = geometry?.coordinates;

    expect(flattenNumbers(coordinates).every(Number.isFinite)).toBe(true);

    if (geometry?.type === "Polygon") {
      for (const ring of coordinates as Array<Array<[number, number]>>) {
        expect(ring.at(0)).toEqual(ring.at(-1));
      }
    }

    if (geometry?.type === "MultiPolygon") {
      for (const polygon of coordinates as Array<Array<Array<[number, number]>>>) {
        for (const ring of polygon) {
          expect(ring.at(0)).toEqual(ring.at(-1));
        }
      }
    }
  }
}

function flattenNumbers(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(flattenNumbers);
}
