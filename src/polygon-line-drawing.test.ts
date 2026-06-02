import { describe, expect, test } from "vitest";

import { drawLineOnPolygonGeometry, type GeoJsonMultiPolygonGeometry, type GeoJsonPolygonGeometry } from ".";

const square: GeoJsonPolygonGeometry = {
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
  type: "Polygon",
};

describe("@moritzbrantner/maps polygon line drawing", () => {
  test("creates a hole from a closed line drawn inside a polygon", () => {
    const result = drawLineOnPolygonGeometry(square, [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
      [2, 2],
    ]);

    expect(result).toEqual({
      geometry: {
        coordinates: [
          square.coordinates[0],
          [
            [2, 2],
            [8, 2],
            [8, 8],
            [2, 8],
            [2, 2],
          ],
        ],
        type: "Polygon",
      },
      operation: "hole",
      polygonIndex: 0,
    });
  });

  test("can force an open drawn line to close into a hole", () => {
    const result = drawLineOnPolygonGeometry(
      square,
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
      ],
      { mode: "hole" },
    );

    expect(result.operation).toBe("hole");
    expect(result.geometry).toEqual({
      coordinates: [
        square.coordinates[0],
        [
          [2, 2],
          [8, 2],
          [8, 8],
          [2, 8],
          [2, 2],
        ],
      ],
      type: "Polygon",
    });
  });

  test("splits a polygon with an open line crossing the shell twice", () => {
    const result = drawLineOnPolygonGeometry(square, [
      [5, -1],
      [5, 11],
    ]);

    expect(result).toEqual({
      geometry: {
        coordinates: [
          [
            [
              [5, 0],
              [10, 0],
              [10, 10],
              [5, 10],
              [5, 0],
            ],
          ],
          [
            [
              [5, 10],
              [0, 10],
              [0, 0],
              [5, 0],
              [5, 10],
            ],
          ],
        ],
        type: "MultiPolygon",
      },
      operation: "split",
      polygonIndex: 0,
    });
  });

  test("splits only the affected polygon in a multipolygon", () => {
    const geometry: GeoJsonMultiPolygonGeometry = {
      coordinates: [
        square.coordinates,
        [
          [
            [20, 0],
            [30, 0],
            [30, 10],
            [20, 10],
            [20, 0],
          ],
        ],
      ],
      type: "MultiPolygon",
    };

    const result = drawLineOnPolygonGeometry(geometry, [
      [25, -1],
      [25, 11],
    ]);

    expect(result.operation).toBe("split");
    expect(result.polygonIndex).toBe(1);
    expect(result.geometry).toEqual({
      coordinates: [
        square.coordinates,
        [
          [
            [25, 0],
            [30, 0],
            [30, 10],
            [25, 10],
            [25, 0],
          ],
        ],
        [
          [
            [25, 10],
            [20, 10],
            [20, 0],
            [25, 0],
            [25, 10],
          ],
        ],
      ],
      type: "MultiPolygon",
    });
  });

  test("keeps existing holes with the split piece that contains them", () => {
    const result = drawLineOnPolygonGeometry(
      {
        coordinates: [
          square.coordinates[0],
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 2],
            [1, 1],
          ],
        ],
        type: "Polygon",
      },
      [
        [5, -1],
        [5, 11],
      ],
    );

    expect(result.geometry.type).toBe("MultiPolygon");
    expect(result.geometry.coordinates[1]).toEqual([
      [
        [5, 10],
        [0, 10],
        [0, 0],
        [5, 0],
        [5, 10],
      ],
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 2],
        [1, 1],
      ],
    ]);
  });

  test("returns a cloned no-op result when the drawn line cannot cut the polygon", () => {
    const result = drawLineOnPolygonGeometry(square, [
      [12, 12],
      [14, 14],
    ]);

    expect(result).toEqual({
      geometry: square,
      operation: "none",
    });
    expect(result.geometry).not.toBe(square);
  });

  test("treats degenerate repeated-point lines as deterministic no-ops", () => {
    const result = drawLineOnPolygonGeometry(square, [
      [5, 5],
      [5, 5],
      [5, 5],
    ]);

    expect(result).toEqual({
      geometry: square,
      operation: "none",
    });
    expect(result.geometry).not.toBe(square);
  });

  test("splits polygons with antimeridian-like longitudes using planar coordinates", () => {
    const result = drawLineOnPolygonGeometry(
      {
        coordinates: [
          [
            [178, -10],
            [182, -10],
            [182, 10],
            [178, 10],
            [178, -10],
          ],
        ],
        type: "Polygon",
      },
      [
        [180, -12],
        [180, 12],
      ],
    );

    expect(result.operation).toBe("split");
    expect(result.geometry.type).toBe("MultiPolygon");
    expect(flattenNumbers(result.geometry.coordinates).every(Number.isFinite)).toBe(true);
  });
});

function flattenNumbers(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(flattenNumbers);
}
