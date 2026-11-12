import { describe, expect, test } from "vitest";
import {
  rotateGeoJsonFeature,
  scaleGeoJsonFeature,
  translateGeoJsonFeature,
  transformGeoJsonGeometry,
  GeoJsonGeographicOperationError,
} from "./entries/core";
import { applyGeoJsonTimelineTransform } from "./entries/timeline";
import type { GeoJsonPosition, TemporalGeoJsonGeometryFeature } from "./temporal-geojson-types";

const point = (coordinates: GeoJsonPosition): TemporalGeoJsonGeometryFeature => ({
  type: "Feature",
  id: "regional",
  properties: { label: "Region" },
  geometry: { type: "Point", coordinates },
});

describe("public regional geographic transforms", () => {
  test("rotates in local metres at latitude 60 and agrees with timeline", () => {
    const feature = point([0.01, 60]);
    const result = rotateGeoJsonFeature(feature, { degrees: 90, pivot: [0, 60] });
    expect(result.geometry).toMatchObject({ type: "Point" });
    if (result.geometry?.type !== "Point" || !("coordinates" in result.geometry)) {
      throw new Error("Expected point");
    }
    const coordinates = result.geometry.coordinates as GeoJsonPosition;
    expect(coordinates[0]).toBeCloseTo(0, 5);
    expect(coordinates[1]).toBeCloseTo(60.005, 5);
    expect(result.id).toBe(feature.id);
    expect(result.properties).toEqual(feature.properties);
    expect(result.geometry).toEqual(
      applyGeoJsonTimelineTransform(
        { type: "Point", coordinates: [0.01, 60] },
        {
          originLongitude: 0,
          originLatitude: 60,
          rotateDegrees: 90,
        },
      ),
    );
    expect(feature).toEqual(point([0.01, 60]));
  });

  test("preserves exact identity coordinates and degree translation", () => {
    expect(
      translateGeoJsonFeature(point([10, 50]), { longitudeDegrees: 2, latitudeDegrees: -1 })
        .geometry,
    ).toEqual({ type: "Point", coordinates: [12, 49] });
    expect(scaleGeoJsonFeature(point([10, 50]), { factor: 1 }).geometry).toEqual(
      point([10, 50]).geometry,
    );
  });

  test("uses bounding-box pivot and scale then rotation then degree translation", () => {
    const geometry = {
      type: "LineString",
      coordinates: [
        [0, 60],
        [0.02, 60],
      ],
    } as const;
    const mutable = {
      type: geometry.type,
      coordinates: geometry.coordinates.map(([x, y]): GeoJsonPosition => [x, y]),
    };
    const result = transformGeoJsonGeometry(mutable, {
      scale: 2,
      rotateDegrees: 90,
      longitudeOffset: 1,
    });
    expect(result.type).toBe("LineString");
    if (result.type !== "LineString") {
      throw new Error("Expected line");
    }
    expect(result.coordinates[0]?.[0]).toBeCloseTo(1.01, 5);
    expect(result.coordinates[1]?.[0]).toBeCloseTo(1.01, 5);
    expect(result.coordinates[0]?.[1]).toBeCloseTo(59.99, 5);
    expect(result.coordinates[1]?.[1]).toBeCloseTo(60.01, 5);
  });

  test("retains multipart ordering, closed rings and holes without mutation", () => {
    const ring: GeoJsonPosition[] = [
      [10, 50],
      [10.02, 50],
      [10.02, 50.02],
      [10, 50],
    ];
    const hole: GeoJsonPosition[] = [
      [10.005, 50.005],
      [10.01, 50.005],
      [10.01, 50.01],
      [10.005, 50.005],
    ];
    const geometry = { type: "MultiPolygon", coordinates: [[ring, hole], [ring]] } as const;
    const input = { type: geometry.type, coordinates: structuredClone([[ring, hole], [ring]]) };
    const before = structuredClone(input);
    const result = transformGeoJsonGeometry(input, { rotateDegrees: 30, scale: 0.5 });
    expect(input).toEqual(before);
    if (result.type !== "MultiPolygon") {
      throw new Error("Expected polygons");
    }
    expect(result.coordinates.map((p) => p.length)).toEqual([2, 1]);
    for (const polygon of result.coordinates) {
      for (const r of polygon) {
        expect(r[0]).toEqual(r.at(-1));
      }
    }
  });

  test("fails atomically with typed diagnostics for crossing input/output and unsupported extent", () => {
    const crossing = {
      type: "LineString",
      coordinates: [
        [179, 0],
        [-179, 0],
      ],
    } as const;
    const input = {
      type: crossing.type,
      coordinates: crossing.coordinates.map(([x, y]): GeoJsonPosition => [x, y]),
    };
    expect(() => transformGeoJsonGeometry(input, {})).toThrow(GeoJsonGeographicOperationError);
    expect(() =>
      translateGeoJsonFeature(point([179.9, 0]), { longitudeDegrees: 1, latitudeDegrees: 0 }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-antimeridian" }));
    expect(() => rotateGeoJsonFeature(point([20, 0]), { degrees: 1, pivot: [0, 0] })).toThrowError(
      expect.objectContaining({ code: "unsupported-extent" }),
    );
    expect(input.coordinates).toEqual([
      [179, 0],
      [-179, 0],
    ]);
    expect(
      translateGeoJsonFeature(point([179.9, 0]), { longitudeDegrees: -0.1, latitudeDegrees: 0 })
        .geometry,
    ).toEqual({ type: "Point", coordinates: [179.8, 0] });
  });

  test("rejects invalid numbers, incomplete pivots, collapsed and invalid geometry", () => {
    expect(() => transformGeoJsonGeometry({ type: "Point", coordinates: [0, 91] }, {})).toThrow();
    expect(() => transformGeoJsonGeometry({ type: "LineString", coordinates: [] }, {})).toThrow();
    expect(() =>
      transformGeoJsonGeometry({ type: "Point", coordinates: [0, 0] }, { scale: 0 }),
    ).toThrow();
    expect(() => rotateGeoJsonFeature(point([0, 0]), { degrees: Number.NaN })).toThrow();
    expect(() =>
      transformGeoJsonGeometry({ type: "Point", coordinates: [0, 0] }, { originLongitude: 0 }),
    ).toThrow();
  });
});

test("metric scaling agrees with an independent great-circle distance oracle", () => {
  const pivot: GeoJsonPosition = [12, 65];
  const original: GeoJsonPosition = [12.3, 65.2];
  const transformed = transformGeoJsonGeometry(
    { type: "Point", coordinates: original },
    {
      originLongitude: pivot[0],
      originLatitude: pivot[1],
      scale: 3,
    },
  );
  if (transformed.type !== "Point") {
    throw new Error("Expected point");
  }
  const distance = (p: GeoJsonPosition) => {
    const radians = Math.PI / 180;
    const dlat = (p[1] - pivot[1]) * radians;
    const dlon = (p[0] - pivot[0]) * radians;
    const a =
      Math.sin(dlat / 2) ** 2 +
      Math.cos(pivot[1] * radians) * Math.cos(p[1] * radians) * Math.sin(dlon / 2) ** 2;
    return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
  };
  expect(distance(transformed.coordinates)).toBeCloseTo(distance(original) * 3, 6);
  const restored = transformGeoJsonGeometry(transformed, {
    originLongitude: pivot[0],
    originLatitude: pivot[1],
    scale: 1 / 3,
  });
  if (restored.type !== "Point") {
    throw new Error("Expected point");
  }
  expect(restored.coordinates[0]).toBeCloseTo(original[0], 10);
  expect(restored.coordinates[1]).toBeCloseTo(original[1], 10);
});

test("rejects output beyond supported local radius and invalid latitude atomically", () => {
  const feature = point([0.1, 0]);
  expect(() => scaleGeoJsonFeature(feature, { factor: 1000, pivot: [0, 0] })).toThrowError(
    expect.objectContaining({ code: "unsupported-extent" }),
  );
  expect(() =>
    translateGeoJsonFeature(point([0, 89]), { longitudeDegrees: 0, latitudeDegrees: 2 }),
  ).toThrowError(expect.objectContaining({ code: "invalid-geometry" }));
  expect(feature).toEqual(point([0.1, 0]));
});

test("axis overrides apply before rotation and preserve identity ring order through standalone helpers", () => {
  expect(
    transformGeoJsonGeometry(
      { type: "Point", coordinates: [0.01, 0] },
      {
        scale: 3,
        scaleX: 2,
        scaleY: 4,
        originLongitude: 0,
        originLatitude: 0,
        rotateDegrees: 90,
        longitudeOffset: 1,
      },
    ),
  ).toMatchObject({ type: "Point", coordinates: [1, expect.closeTo(0.02, 10)] });
  const geometry = {
    type: "Polygon" as const,
    coordinates: [
      [
        [10, 50],
        [10, 50.02],
        [10.02, 50.02],
        [10, 50],
      ] as GeoJsonPosition[],
    ],
  };
  const feature = { type: "Feature" as const, geometry };
  expect(scaleGeoJsonFeature(feature, { factor: 1 }).geometry).toEqual(geometry);
  const invalid = {
    type: "Feature" as const,
    geometry: {
      type: "MultiPolygon" as const,
      coordinates: [
        geometry.coordinates,
        [
          [
            [0, 0],
            [1, 1],
            [2, 2],
            [0, 0],
          ] as GeoJsonPosition[],
        ],
      ],
    },
  };
  expect(() => scaleGeoJsonFeature(invalid, { factor: 1 })).toThrowError(
    expect.objectContaining({ code: "invalid-geometry" }),
  );
});

test("Editor degree translation uses the same geographic contract and fails closed", async () => {
  const { moveGeoJsonGeometry } = await import("./entries/editor");
  const geometry = { type: "Point" as const, coordinates: [10, 50] as GeoJsonPosition };
  expect(moveGeoJsonGeometry(geometry, 2, -1)).toEqual(
    transformGeoJsonGeometry(geometry, { longitudeOffset: 2, latitudeOffset: -1 }),
  );
  expect(() => moveGeoJsonGeometry({ type: "Point", coordinates: [179.9, 0] }, 1, 0)).toThrowError(
    expect.objectContaining({ code: "unsupported-antimeridian" }),
  );
  expect(geometry.coordinates).toEqual([10, 50]);
});
