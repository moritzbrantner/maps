import { describe, expect, expectTypeOf, test } from "vitest";

import {
  createMapFlowsFromGeoJson,
  createMapPointsFromGeoJson,
  validateGeoJsonMapSource,
  type GeoJsonMapSource,
  type MapFlow,
  type MapPoint,
} from ".";

type StoreProperties = {
  demand: number;
  label: string;
  region: "north" | "south";
};

describe("validateGeoJsonMapSource", () => {
  test("accepts valid point and line sources", () => {
    const result = validateGeoJsonMapSource({
      features: [
        {
          geometry: { coordinates: [13.405, 52.52], type: "Point" },
          id: "berlin",
          properties: { demand: 42 },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [13.405, 52.52],
              [2.3522, 48.8566],
            ],
            type: "LineString",
          },
          id: "berlin-paris",
          properties: { metrics: { trips: 100 } },
          type: "Feature",
        },
      ],
      type: "FeatureCollection",
    });

    expect(result).toEqual({
      errorCount: 0,
      issues: [],
      valid: true,
      warningCount: 0,
    });
  });

  test("reports invalid coordinate ranges", () => {
    const result = validateGeoJsonMapSource({
      features: [
        {
          geometry: { coordinates: [220, 95], type: "Point" },
          type: "Feature",
        },
      ],
      type: "FeatureCollection",
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "invalid-coordinate",
        featureIndex: 0,
        geometryPath: "geometry.coordinates",
        severity: "error",
      }),
    ]);
  });

  test("reports unsupported geometry types", () => {
    const result = validateGeoJsonMapSource({
      features: [
        {
          geometry: { coordinates: [13.405, 52.52], type: "Circle" },
          type: "Feature",
        },
      ],
      type: "FeatureCollection",
    });

    expect(result.valid).toBe(false);
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        code: "invalid-geometry",
        featureIndex: 0,
        severity: "error",
      }),
    );
  });

  test("warns about missing feature IDs and nonnumeric metrics", () => {
    const result = validateGeoJsonMapSource(
      {
        features: [
          {
            geometry: { coordinates: [13.405, 52.52], type: "Point" },
            properties: {
              demand: "high",
              metrics: { load: Number.NaN },
            },
            type: "Feature",
          },
        ],
        type: "FeatureCollection",
      },
      { metricKeys: ["demand"], requireFeatureIds: true },
    );

    expect(result.valid).toBe(true);
    expect(result.warningCount).toBe(3);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "missing-feature-id",
      "nonnumeric-metric",
      "nonnumeric-metric",
    ]);
  });

  test("can restrict supported geometry types for a specific map", () => {
    const result = validateGeoJsonMapSource(
      {
        features: [
          {
            geometry: { coordinates: [[13.405, 52.52]], type: "LineString" },
            id: "route",
            type: "Feature",
          },
        ],
        type: "FeatureCollection",
      },
      { supportedGeometryTypes: ["Point", "MultiPoint"] },
    );

    expect(result.valid).toBe(false);
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        code: "invalid-geometry",
        message: expect.stringContaining("disabled"),
      }),
    );
  });
});

test("generic GeoJSON property types flow into point and flow helpers", () => {
  const source: GeoJsonMapSource<StoreProperties> = {
    features: [
      {
        geometry: { coordinates: [13.405, 52.52], type: "Point" },
        id: "store",
        properties: { demand: 42, label: "Berlin", region: "north" },
        type: "Feature",
      },
    ],
    type: "FeatureCollection",
  };

  expectTypeOf(createMapPointsFromGeoJson(source)).toEqualTypeOf<Array<MapPoint<StoreProperties>>>();
  expectTypeOf(createMapFlowsFromGeoJson(source)).toEqualTypeOf<Array<MapFlow<StoreProperties>>>();
});
