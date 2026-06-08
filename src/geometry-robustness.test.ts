import { describe, expect, test } from "vitest";

import {
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
  getBeeLineDistanceMeters,
  validateGeoJsonMapSource,
  type TemporalGeoJsonGeometryFeatureCollection,
} from ".";

describe("@moritzbrantner/maps geometry robustness", () => {
  test("caps validation issues while still reporting nested malformed coordinates", () => {
    const result = validateGeoJsonMapSource(
      {
        features: [
          {
            geometry: {
              coordinates: [
                [
                  [
                    [0, 0],
                    [1, 0],
                    ["bad", 1],
                    [0, 0],
                  ],
                ],
              ],
              type: "MultiPolygon",
            },
            type: "Feature",
          },
          {
            geometry: {
              coordinates: [],
              type: "Polygon",
            },
            type: "Feature",
          },
          {
            geometry: {
              coordinates: [Number.NaN, 92],
              type: "Point",
            },
            type: "Feature",
          },
        ],
        type: "FeatureCollection",
      },
      { maxIssues: 2 },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.geometryPath)).toEqual([
      "geometry.coordinates[0][0][2]",
      "geometry.coordinates",
    ]);
  });

  test("keeps reordered multipart temporal playback deterministic", () => {
    const collection: TemporalGeoJsonGeometryFeatureCollection = {
      features: [
        multiPolygonFrame("region", 0, [
          squareRing(0, 0, 2, 2),
          squareRing(10, 0, 12, 2),
        ]),
        multiPolygonFrame("region", 10, [
          squareRing(10, 0, 12, 2),
          squareRing(0, 0, 2, 2),
        ]),
      ],
      type: "FeatureCollection",
    };
    const tracks = createTemporalGeoJsonTracksFromGeoJson(collection);
    const options = { partMatchingStrategy: "auto" as const };
    const raw = createTemporalGeoJsonPlaybackIndex(tracks, options).getFeatureCollectionAtTime(5);
    const repeated = createTemporalGeoJsonPlaybackIndex(tracks, options).getFeatureCollectionAtTime(5);

    expect(repeated).toEqual(raw);
    expect(raw.features[0]?.geometry.type).toBe("MultiPolygon");
    expect(flattenNumbers(raw.features[0]?.geometry.coordinates).every(Number.isFinite)).toBe(true);
  });

  test("returns null for invalid measurement input instead of throwing", () => {
    expect(getBeeLineDistanceMeters([13.405], [11.582, 48.1351])).toBeNull();
    expect(getBeeLineDistanceMeters([13.405, Number.NaN], [11.582, 48.1351])).toBeNull();
    expect(getBeeLineDistanceMeters([13.405, 52.52], [11.582, 91])).toBeNull();
  });
});

function multiPolygonFrame(id: string, time: number, rings: number[][][]) {
  return {
    geometry: {
      coordinates: rings.map((ring) => [ring]),
      type: "MultiPolygon" as const,
    },
    properties: {
      time,
      trackId: id,
    },
    type: "Feature" as const,
  };
}

function squareRing(minX: number, minY: number, maxX: number, maxY: number) {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
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
