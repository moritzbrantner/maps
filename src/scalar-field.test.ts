import { afterEach, describe, expect, test } from "vitest";

import {
  createIdwInterpolator,
  createScalarFieldGrid,
  getMapsScalarFieldWasmLoadError,
  getScalarFieldValueAtCoordinate,
  initializeMapsScalarFieldWasm,
  normalizeScalarFieldValue,
  resetMapsScalarFieldWasmRuntimeForTests,
  setMapsScalarFieldWasmRuntimeForTests,
  type ScalarFieldGrid,
} from "./scalar-field";
import type { MapPoint } from "./aggregation";

describe("scalar-field IDW interpolation", () => {
  afterEach(() => {
    resetMapsScalarFieldWasmRuntimeForTests();
  });

  test("returns the source value for an exact source-point match", () => {
    const interpolator = createIdwInterpolator([point("a", 13, 52, 21.5)], {
      domainBounds: [12, 51, 14, 53],
      valueMetric: "temperature",
    });

    expect(interpolator.getValueAtCoordinate([13, 52])).toBe(21.5);
  });

  test("averages two equal-distance points", () => {
    const interpolator = createIdwInterpolator(
      [point("west", 0, 0, 10), point("east", 2, 0, 20)],
      {
        domainBounds: [0, -1, 2, 1],
        interpolationK: 2,
        valueMetric: "temperature",
      },
    );

    expect(interpolator.getValueAtCoordinate([1, 0])).toBeCloseTo(15, 8);
  });

  test("weights a closer point more strongly than a farther point", () => {
    const interpolator = createIdwInterpolator(
      [point("near", 0, 0, 0), point("far", 2, 0, 100)],
      {
        domainBounds: [0, -1, 2, 1],
        interpolationK: 2,
        interpolationPower: 2,
        valueMetric: "temperature",
      },
    );

    expect(interpolator.getValueAtCoordinate([0.5, 0])).toBeLessThan(20);
  });

  test("keeps values independent of render size and viewport-like options", () => {
    const points = [point("cold", 0, 0, 0), point("warm", 4, 0, 40)];
    const first = createIdwInterpolator(points, {
      domainBounds: [0, -1, 4, 1],
      fieldColumns: 32,
      fieldRows: 12,
      valueMetric: "temperature",
    });
    const second = createIdwInterpolator(points, {
      domainBounds: [0, -1, 4, 1],
      fieldColumns: 384,
      fieldRows: 160,
      valueMetric: "temperature",
    });

    expect(first.getValueAtCoordinate([1.5, 0])).toBeCloseTo(
      second.getValueAtCoordinate([1.5, 0]) ?? Number.NaN,
      10,
    );
  });

  test("infers a stable value domain for normalization", () => {
    const grid = createScalarFieldGrid([point("cold", 0, 0, -5), point("warm", 2, 0, 25)], {
      domainBounds: [0, -1, 2, 1],
      fieldColumns: 8,
      fieldRows: 4,
      valueMetric: "temperature",
    });

    expect(grid.valueDomain).not.toBeNull();
    expect(normalizeScalarFieldValue(grid.valueDomain![0], grid.valueDomain)).toBe(0);
    expect(normalizeScalarFieldValue(grid.valueDomain![1], grid.valueDomain)).toBe(1);
  });

  test("returns a null field gracefully for empty points", () => {
    const grid = createScalarFieldGrid([], {
      domainBounds: [0, 0, 1, 1],
      fieldColumns: 2,
      fieldRows: 2,
      valueMetric: "temperature",
    });

    expect(grid).toMatchObject<Partial<ScalarFieldGrid>>({
      bounds: [0, 0, 1, 1],
      columns: 2,
      rows: 2,
      valueDomain: null,
      values: [null, null, null, null],
    });

    expect(createScalarFieldGrid([], { valueMetric: "temperature" })).toMatchObject({
      columns: 0,
      rows: 0,
      values: [],
    });
  });

  test("ignores invalid coordinates and NaN values", () => {
    const grid = createScalarFieldGrid(
      [
        point("valid", 0, 0, 8),
        point("bad-latitude", 1, Number.NaN, 99),
        point("bad-value", 2, 0, Number.NaN),
      ],
      {
        domainBounds: [-1, -1, 1, 1],
        fieldColumns: 2,
        fieldRows: 2,
        valueMetric: "temperature",
      },
    );

    expect(grid.values).toEqual([8, 8, 8, 8]);
    expect(grid.valueDomain).toEqual([8, 8]);
  });

  test("is deterministic across repeated grid creation", () => {
    const points = [
      point("a", 0, 0, 0),
      point("b", 2, 0, 20),
      point("c", 1, 2, 10),
    ];
    const options = {
      domainBounds: [-1, -1, 3, 3] as [number, number, number, number],
      fieldColumns: 12,
      fieldRows: 12,
      valueMetric: "temperature",
    };

    expect(createScalarFieldGrid(points, options).values).toEqual(
      createScalarFieldGrid(points, options).values,
    );
  });

  test("matches the public IDW interpolator at regular grid sample centers", () => {
    const points = [
      point("a", 0, 0, 0),
      point("b", 3, 0, 30),
      point("c", 1, 2, 12),
      point("d", 2, 3, 24),
    ];
    const options = {
      domainBounds: [-1, -1, 4, 4] as [number, number, number, number],
      fieldColumns: 5,
      fieldRows: 4,
      interpolationK: 3,
      interpolationPower: 1.7,
      valueMetric: "temperature",
    };
    const grid = createScalarFieldGrid(points, options);
    const interpolator = createIdwInterpolator(points, options);
    const [west, south, east, north] = grid.bounds;
    const longitudeStep = (east - west) / grid.columns;
    const latitudeStep = (north - south) / grid.rows;

    for (let row = 0; row < grid.rows; row += 1) {
      for (let column = 0; column < grid.columns; column += 1) {
        const longitude = west + longitudeStep * (column + 0.5);
        const latitude = north - latitudeStep * (row + 0.5);
        const expected = interpolator.getValueAtCoordinate([longitude, latitude]);

        expect(grid.values[row * grid.columns + column]).toBeCloseTo(expected ?? Number.NaN, 10);
      }
    }
  });

  test("applies grid interpolation options on the fast path", () => {
    const grid = createScalarFieldGrid(
      [point("near", 0, 0, 0), point("far", 2, 0, 100), point("farther", 4, 0, 100)],
      {
        domainBounds: [0, -1, 2, 1],
        fieldColumns: 1,
        fieldRows: 1,
        interpolationK: 1,
        interpolationPower: 3,
        valueMetric: "temperature",
      },
    );

    expect(grid.values[0]).toBe(0);
  });

  test("returns null outside max distance when extrapolation is disabled", () => {
    const interpolator = createIdwInterpolator([point("a", 0, 0, 12)], {
      domainBounds: [-10, -10, 10, 10],
      interpolationExtrapolate: false,
      interpolationMaxDistanceMeters: 1_000,
      valueMetric: "temperature",
    });

    expect(getScalarFieldValueAtCoordinate(interpolator, [5, 5])).toBeNull();
  });

  test("returns null grid cells outside max distance when extrapolation is disabled", () => {
    const grid = createScalarFieldGrid([point("a", 0, 0, 12)], {
      domainBounds: [4, 4, 6, 6],
      fieldColumns: 1,
      fieldRows: 1,
      interpolationExtrapolate: false,
      interpolationMaxDistanceMeters: 1_000,
      valueMetric: "temperature",
    });

    expect(grid.values).toEqual([null]);
  });

  test("delegates compatible grids to an initialized WASM scalar field runtime", () => {
    try {
      setMapsScalarFieldWasmRuntimeForTests({
        createScalarFieldGrid(points, options) {
          expect(points).toHaveLength(1);
          expect(options.valueMetric).toBe("temperature");

          return {
            bounds: [0, 0, 1, 1],
            columns: 1,
            rows: 1,
            valueDomain: [42, 42],
            values: [42],
          };
        },
      });

      expect(
        createScalarFieldGrid([point("a", 0, 0, 42)], {
          domainBounds: [0, 0, 1, 1],
          fieldColumns: 1,
          fieldRows: 1,
          valueMetric: "temperature",
        }),
      ).toMatchObject({
        valueDomain: [42, 42],
        values: [42],
      });
    } finally {
      resetMapsScalarFieldWasmRuntimeForTests();
    }
  });

  test("keeps custom value callbacks on the TypeScript scalar field path", () => {
    try {
      setMapsScalarFieldWasmRuntimeForTests({
        createScalarFieldGrid() {
          throw new Error("WASM runtime should not handle custom getValue options");
        },
      });

      expect(
        createScalarFieldGrid([point("a", 0, 0, 1)], {
          domainBounds: [0, 0, 1, 1],
          fieldColumns: 1,
          fieldRows: 1,
          getValue: () => 7,
        }).values,
      ).toEqual([7]);
    } finally {
      resetMapsScalarFieldWasmRuntimeForTests();
    }
  });

  test("reports failed optional WASM initialization and keeps the TypeScript scalar field path", async () => {
    expect(await initializeMapsScalarFieldWasm("missing-package")).toBe(false);
    expect(getMapsScalarFieldWasmLoadError()).toBeTruthy();

    const grid = createScalarFieldGrid([point("a", 0, 0, 12)], {
      domainBounds: [0, 0, 1, 1],
      fieldColumns: 1,
      fieldRows: 1,
      valueMetric: "temperature",
    });

    expect(grid.bounds).toEqual([0, 0, 1, 1]);
    expect(grid.columns).toBe(1);
    expect(grid.rows).toBe(1);
    expect(grid.valueDomain?.[0]).toBeCloseTo(12, 10);
    expect(grid.valueDomain?.[1]).toBeCloseTo(12, 10);
    expect(grid.values[0]).toBeCloseTo(12, 10);
  });

  test("repeated failed WASM initialization does not poison scalar field creation", async () => {
    expect(await initializeMapsScalarFieldWasm("missing-package")).toBe(false);
    expect(await initializeMapsScalarFieldWasm("missing-package")).toBe(false);

    expect(
      createScalarFieldGrid([point("a", 0, 0, 4)], {
        domainBounds: [0, 0, 1, 1],
        fieldColumns: 2,
        fieldRows: 1,
        valueMetric: "temperature",
      }).values,
    ).toEqual([4, 4]);
  });
});

function point(id: string, longitude: number, latitude: number, temperature: number): MapPoint {
  return {
    id,
    latitude,
    longitude,
    metrics: {
      temperature,
    },
  };
}
