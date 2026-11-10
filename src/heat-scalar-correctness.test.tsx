import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ViewportAggregationQuery } from "./aggregation";
import { HeatLayer } from "./heat-layer";
import { createHeatLayerSourceIndex } from "./heat-layer-data";
import {
  getHeatLayerMetricCellDensityBruteForce,
  prepareHeatLayerColorRamp,
  type MetricHeatLayerSurfaceSource,
} from "./heat-surface";
import { createHeatSurfaceRenderPlan } from "./heat-surface-render-plan";
import { createMapsHeatSurfaceViewport } from "./maps-heat-layer-bounds";
import { MapsOverlayLayers } from "./maps-overlay-layers";
import { PointLayer } from "./point-layer";
import {
  createIdwInterpolator,
  createScalarFieldGrid,
  normalizeScalarFieldValue,
  type ScalarFieldGrid,
} from "./scalar-field";
import {
  createHeatFieldContourFeatureCollection,
  createHeatFieldImage,
} from "./scalar-field-render";

/*
 * Deterministic heat/scalar correctness fixtures (#171 phase 1). They pin the
 * documented TypeScript semantics that the retained-path oracle and any later
 * optimization must preserve.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("heat density source index", () => {
  test("empty input yields an empty index", () => {
    const index = createHeatLayerSourceIndex([]);

    expect(index.pointCount).toBe(0);
    expect(index.maxWeight).toBe(1);
    expect(index.getFeatureCollection([-180, -90, 180, 90]).features).toEqual([]);
  });

  test("drops invalid coordinates and non-positive or non-finite weights", () => {
    const index = createHeatLayerSourceIndex([
      { id: "ok", latitude: 1, longitude: 1, metrics: { weight: 2 } },
      { id: "nan-lat", latitude: Number.NaN, longitude: 1 },
      { id: "inf-lon", latitude: 1, longitude: Number.POSITIVE_INFINITY },
      { id: "zero", latitude: 1, longitude: 1, metrics: { weight: 0 } },
      { id: "negative", latitude: 1, longitude: 1, metrics: { weight: -4 } },
      { id: "nan-weight", latitude: 1, longitude: 1, metrics: { weight: Number.NaN } },
      { id: "inf-weight", latitude: 1, longitude: 1, metrics: { weight: Number.POSITIVE_INFINITY } },
      { id: "default", latitude: 2, longitude: 2 },
    ]);
    const features = index.getFeatureCollection([-180, -90, 180, 90]).features;

    expect(features.map((feature) => feature.properties.pointId)).toEqual(["ok", "default"]);
    expect(features.map((feature) => feature.properties.rawWeight)).toEqual([2, 1]);
  });

  test("normalizes by the largest weight but never scales weights below one upward", () => {
    const heavy = createHeatLayerSourceIndex([
      { id: "a", latitude: 0, longitude: 0, metrics: { weight: 1e12 } },
      { id: "b", latitude: 0, longitude: 0, metrics: { weight: 1 } },
    ]);
    const light = createHeatLayerSourceIndex([
      { id: "a", latitude: 0, longitude: 0, metrics: { weight: 0.2 } },
      { id: "b", latitude: 0, longitude: 0, metrics: { weight: 0.5 } },
    ]);

    expect(weightsOf(heavy)).toEqual([1, 1e-12]);
    expect(light.maxWeight).toBe(1);
    expect(weightsOf(light)).toEqual([0.2, 0.5]);
  });

  test("an explicit maxWeight sets the normalization domain, including values above it", () => {
    const index = createHeatLayerSourceIndex(
      [
        { id: "a", latitude: 0, longitude: 0, metrics: { weight: 5 } },
        { id: "b", latitude: 0, longitude: 0, metrics: { weight: 20 } },
      ],
      { maxWeight: 10 },
    );
    const ignored = createHeatLayerSourceIndex(
      [{ id: "a", latitude: 0, longitude: 0, metrics: { weight: 5 } }],
      { maxWeight: 0 },
    );

    expect(weightsOf(index)).toEqual([0.5, 2]);
    expect(ignored.maxWeight).toBe(5);
  });

  test("applies filterPoint and getWeight before normalization", () => {
    const index = createHeatLayerSourceIndex(
      [
        { id: "a", latitude: 0, longitude: 0, metrics: { count: 3 } },
        { id: "b", latitude: 0, longitude: 0, metrics: { count: 9 } },
        { id: "c", latitude: 0, longitude: 0, metrics: { count: 6 } },
      ],
      {
        filterPoint: (point) => point.id !== "b",
        getWeight: (point) => point.metrics.count ?? 0,
      },
    );

    expect(index.maxWeight).toBe(6);
    expect(weightsOf(index)).toEqual([0.5, 1]);
  });

  test("bounds queries include points on the boundary", () => {
    const index = createHeatLayerSourceIndex([
      { id: "edge", latitude: 10, longitude: 20 },
      { id: "outside", latitude: 10.0001, longitude: 20 },
    ]);

    expect(
      index.getFeatureCollection([0, 0, 20, 10]).features.map((feature) => feature.properties.pointId),
    ).toEqual(["edge"]);
  });
});

describe("heat density kernel and planning", () => {
  test("uses a truncated Gaussian kernel with weight at the center and weight·e⁻³ at the radius", () => {
    const source: MetricHeatLayerSurfaceSource = {
      coordinate: [0, 0],
      dataInfluenceRadius: 1_000,
      influenceRadius: 10,
      metricPoint: { x: 0, y: 0 },
      point: { x: 0, y: 0 },
      weight: 0.5,
    };

    expect(getHeatLayerMetricCellDensityBruteForce([source], 0, 0)).toBe(0.5);
    expect(getHeatLayerMetricCellDensityBruteForce([source], 1_000, 0)).toBeCloseTo(
      0.5 * Math.exp(-3),
      14,
    );
    expect(getHeatLayerMetricCellDensityBruteForce([source], 500, 0)).toBeCloseTo(
      0.5 * Math.exp(-0.75),
      14,
    );
    expect(getHeatLayerMetricCellDensityBruteForce([source], 1_000.001, 0)).toBe(0);
    expect(
      getHeatLayerMetricCellDensityBruteForce([source, { ...source, weight: 0.25 }], 0, 0),
    ).toBe(0.75);
  });

  test("plans no surface for zero-weight-only data or a zero radius", () => {
    const zeroWeight = {
      features: [
        {
          geometry: { coordinates: [0, 0] as [number, number], type: "Point" as const },
          properties: {
            kind: "heat-point" as const,
            label: "",
            pointCount: 1,
            pointId: "a",
            rawWeight: 0,
            weight: 0,
          },
          type: "Feature" as const,
        },
      ],
      type: "FeatureCollection" as const,
    };

    expect(createDensityPlan({ data: zeroWeight })).toBeNull();
    expect(createDensityPlan({ radius: { meters: 0 } })).toBeNull();
    expect(createDensityPlan({ radius: 0, strategy: "viewport-raster" })).toBeNull();
  });

  test("rebuilds against the cached raster geometry when inputs change while coverage is reusable", () => {
    const first = createDensityPlan({});
    const restyled = createDensityPlan({
      colorRamp: [
        [0, "#000000"],
        [1, "#ffffff"],
      ],
      surfaceCache: first?.cacheMetadata ?? null,
    });
    const unchanged = createDensityPlan({ surfaceCache: first?.cacheMetadata ?? null });

    expect(unchanged?.cacheKey).toBe(first?.cacheKey);
    expect(restyled?.cacheKey).not.toBe(first?.cacheKey);
    expect(restyled?.coverageBounds).toEqual(first?.coverageBounds);
    expect([restyled?.width, restyled?.height]).toEqual([first?.width, first?.height]);
    expect(restyled?.sources).toHaveLength(1);
  });
});

describe("scalar field normalization, image and contours", () => {
  test("normalizes into [0, 1], clamps outside the domain and centers a degenerate domain", () => {
    expect(normalizeScalarFieldValue(5, [0, 10])).toBe(0.5);
    expect(normalizeScalarFieldValue(-3, [0, 10])).toBe(0);
    expect(normalizeScalarFieldValue(42, [0, 10])).toBe(1);
    expect(normalizeScalarFieldValue(7, [7, 7])).toBe(0.5);
    expect(normalizeScalarFieldValue(Number.NaN, [0, 10])).toBeNull();
    expect(normalizeScalarFieldValue(1, null)).toBeNull();
  });

  test("returns an empty grid and no image or contours for empty input", () => {
    const grid = createScalarFieldGrid([], { fieldColumns: 4, fieldRows: 4 });

    expect(grid).toMatchObject({ columns: 0, rows: 0, valueDomain: null, values: [] });
    expect(createHeatFieldImage(grid)).toBeNull();
    expect(createHeatFieldContourFeatureCollection(grid).features).toEqual([]);
  });

  test("interpolates known IDW samples exactly at sources and symmetrically between them", () => {
    const grid = createScalarFieldGrid(
      [
        { id: "west", latitude: 0, longitude: 0.5, metrics: { value: 0 } },
        { id: "east", latitude: 0, longitude: 2.5, metrics: { value: 30 } },
      ],
      { domainBounds: [0, -0.5, 3, 0.5], fieldColumns: 3, fieldRows: 1, valueMetric: "value" },
    );

    expect(grid.columns).toBe(3);
    expect(grid.values[0]).toBeCloseTo(0, 10);
    expect(grid.values[1]).toBeCloseTo(15, 10);
    expect(grid.values[2]).toBeCloseTo(30, 10);
    expect(grid.valueDomain).toEqual([0, 30]);
  });

  test("colors pixels from the normalized value domain and leaves holes transparent", () => {
    const pixels = captureFieldImagePixels();
    const grid: ScalarFieldGrid = {
      bounds: [0, 0, 5, 1],
      columns: 5,
      rows: 1,
      valueDomain: [0, 10],
      values: [0, 5, 10, null, 42],
    };

    const image = createHeatFieldImage(grid, {
      colorRamp: [
        [0, "#000000"],
        [1, "#ffffff"],
      ],
      opacity: 0.5,
    });

    expect(image).toMatchObject({ bounds: [0, 0, 5, 1], height: 1, width: 5 });
    expect(Array.from(pixels())).toEqual([
      0, 0, 0, 128,
      128, 128, 128, 128,
      255, 255, 255, 128,
      0, 0, 0, 0,
      255, 255, 255, 128,
    ]);
  });

  test("an explicit value domain overrides the inferred one", () => {
    const pixels = captureFieldImagePixels();
    const grid: ScalarFieldGrid = {
      bounds: [0, 0, 2, 1],
      columns: 2,
      rows: 1,
      valueDomain: [0, 10],
      values: [0, 10],
    };

    createHeatFieldImage(grid, {
      colorRamp: [
        [0, "#000000"],
        [1, "#ffffff"],
      ],
      valueDomain: [0, 20],
    });

    expect(Array.from(pixels())).toEqual([0, 0, 0, 255, 128, 128, 128, 255]);
  });

  test("places a contour where the field crosses its level", () => {
    const grid = createLinearGrid([0, 10, 20]);
    const contours = createHeatFieldContourFeatureCollection(grid, { levels: [5, 15, 99] });

    expect(contours.features.map((feature) => feature.properties?.value)).toEqual([5, 15]);
    expect(contourLongitudes(contours.features[0]!)).toEqual([1]);
    expect(contourLongitudes(contours.features[1]!)).toEqual([2]);
    for (const feature of contours.features) {
      for (const [, latitude] of contourCoordinates(feature)) {
        expect(latitude).toBeGreaterThanOrEqual(grid.bounds[1]);
        expect(latitude).toBeLessThanOrEqual(grid.bounds[3]);
      }
    }
  });

  test("does not draw contours through missing (null) cells", () => {
    const complete = createLinearGrid([0, 10, 20]);
    const holed: ScalarFieldGrid = {
      ...complete,
      values: complete.values.map((value, index) => (index % 3 === 0 ? null : value)),
    };

    expect(createHeatFieldContourFeatureCollection(holed, { levels: [5] }).features).toEqual([]);
    expect(
      contourLongitudes(createHeatFieldContourFeatureCollection(holed, { levels: [15] }).features[0]!),
    ).toEqual([2]);
  });

  test("spaces automatic contour levels evenly inside the value domain", () => {
    const contours = createHeatFieldContourFeatureCollection(createLinearGrid([0, 10, 20]), {
      levels: 3,
    });

    expect(contours.features.map((feature) => feature.properties?.value)).toEqual([5, 10, 15]);
    expect(contours.features.map((feature) => feature.properties?.levelCount)).toEqual([3, 3, 3]);
  });
});

describe("scalar field masks", () => {
  const ring = (west: number, south: number, east: number, north: number) => [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  const constantField = (maskGeoJson: unknown, size = 8) =>
    createScalarFieldGrid([{ id: "only", latitude: 4, longitude: 4, metrics: { value: 10 } }], {
      domainBounds: [0, 0, size, size],
      fieldColumns: size,
      fieldRows: size,
      maskGeoJson: maskGeoJson as never,
      valueMetric: "value",
    });

  test("keeps cells inside the exterior ring and excludes cells inside a hole", () => {
    const grid = constantField({
      coordinates: [ring(1, 1, 7, 7), ring(3, 3, 5, 5)],
      type: "Polygon",
    });

    expect(maskPattern(grid)).toEqual([
      "........",
      ".######.",
      ".######.",
      ".##..##.",
      ".##..##.",
      ".######.",
      ".######.",
      "........",
    ]);
    expect(grid.bounds).toEqual([0, 0, 8, 8]);
  });

  test("a cell center on the exterior boundary is inside and on a hole boundary is outside", () => {
    const field = (maskGeoJson: unknown) =>
      createScalarFieldGrid([{ id: "only", latitude: 0.5, longitude: 2, metrics: { value: 10 } }], {
        domainBounds: [0, 0, 4, 1],
        fieldColumns: 4,
        fieldRows: 1,
        maskGeoJson: maskGeoJson as never,
        valueMetric: "value",
      }).values;

    // Cell centers are at longitudes 0.5, 1.5, 2.5 and 3.5 on latitude 0.5.
    expect(field({ coordinates: [ring(0.5, 0, 2.5, 1)], type: "Polygon" })).toEqual([10, 10, 10, null]);
    expect(
      field({ coordinates: [ring(0, 0, 4, 1), ring(1.5, 0.25, 2.5, 0.75)], type: "Polygon" }),
    ).toEqual([10, null, null, 10]);
  });

  test("ignores ring winding order and accepts unclosed rings", () => {
    const counterClockwise = constantField({ coordinates: [ring(1, 1, 7, 7), ring(3, 3, 5, 5)], type: "Polygon" });
    const clockwise = constantField({
      coordinates: [[...ring(1, 1, 7, 7)].reverse(), [...ring(3, 3, 5, 5)].reverse()],
      type: "Polygon",
    });
    const unclosed = constantField({
      coordinates: [ring(1, 1, 7, 7).slice(0, -1), ring(3, 3, 5, 5).slice(0, -1)],
      type: "Polygon",
    });

    expect(clockwise.values).toEqual(counterClockwise.values);
    expect(unclosed.values).toEqual(counterClockwise.values);
  });

  test("a MultiPolygon mask is the union of its polygons, including overlaps and islands in holes", () => {
    const grid = constantField({
      coordinates: [
        [ring(0, 0, 3, 3)],
        [ring(2, 2, 4, 4)],
        [ring(4, 4, 8, 8), ring(5, 5, 7, 7)],
        // An island inside the previous polygon's hole covers one cell center again.
        [ring(6.25, 6.25, 6.75, 6.75)],
      ],
      type: "MultiPolygon",
    });

    expect(maskPattern(grid)).toEqual([
      "....####",
      "....#.##",
      "....#..#",
      "....####",
      "..##....",
      "####....",
      "###.....",
      "###.....",
    ]);
  });

  test("accepts Features and FeatureCollections and ignores non-polygonal geometry", () => {
    const polygon = { coordinates: [ring(1, 1, 7, 7), ring(3, 3, 5, 5)], type: "Polygon" };
    const expected = constantField(polygon).values;

    expect(constantField({ geometry: polygon, properties: {}, type: "Feature" }).values).toEqual(expected);
    expect(
      constantField({
        features: [
          { geometry: polygon, properties: {}, type: "Feature" },
          { geometry: { coordinates: [0.5, 0.5], type: "Point" }, properties: {}, type: "Feature" },
          { geometry: null, properties: {}, type: "Feature" },
        ],
        type: "FeatureCollection",
      }).values,
    ).toEqual(expected);
    expect(
      constantField({ geometries: [polygon], type: "GeometryCollection" }).values,
    ).toEqual(expected);
  });

  test("a mask without polygonal area hides the whole field; no mask leaves it unclipped", () => {
    expect(constantField({ features: [], type: "FeatureCollection" }).values.every((value) => value === null)).toBe(
      true,
    );
    expect(constantField({ coordinates: [1, 1], type: "Point" }).values.every((value) => value === null)).toBe(true);
    expect(constantField(null).values.every((value) => value !== null)).toBe(true);
    expect(constantField(undefined).values.every((value) => value !== null)).toBe(true);
  });

  test("ignores rings that cannot enclose area and non-finite positions", () => {
    const expected = constantField({ coordinates: [ring(1, 1, 7, 7), ring(3, 3, 5, 5)], type: "Polygon" }).values;

    expect(
      constantField({
        coordinates: [
          [ring(1, 1, 7, 7), ring(3, 3, 5, 5), [[2, 2], [2.5, 2.5]], "not-a-ring"],
          // No usable exterior ring: the whole polygon contributes nothing.
          [[[0, 0], [8, 8]], ring(0, 0, 8, 8)],
          [[...ring(1, 1, 7, 7), [Number.NaN, 4]], ring(3, 3, 5, 5)],
        ],
        type: "MultiPolygon",
      }).values,
    ).toEqual(expected);
  });

  test("the IDW interpolator samples no value outside the mask or inside a hole", () => {
    const interpolator = createIdwInterpolator(
      [{ id: "only", latitude: 4, longitude: 4, metrics: { value: 10 } }],
      {
        domainBounds: [0, 0, 8, 8],
        maskGeoJson: { coordinates: [ring(1, 1, 7, 7), ring(3, 3, 5, 5)], type: "Polygon" },
        valueMetric: "value",
      },
    );

    expect(interpolator.getValueAtCoordinate([2, 2])).toBeCloseTo(10, 10);
    expect(interpolator.getValueAtCoordinate([0.5, 0.5])).toBeNull();
    expect(interpolator.getValueAtCoordinate([4, 4])).toBeNull();
  });

  test("masks the spatial-grid interpolation path used for many measurements", () => {
    // More than 256 measurements leave the fast IDW path.
    const points = Array.from({ length: 300 }, (_, index) => ({
      id: `p${index}`,
      latitude: 0.25 + (Math.floor(index / 20) * 7.5) / 15,
      longitude: 0.25 + ((index % 20) * 7.5) / 19,
      metrics: { value: index % 7 },
    }));
    const grid = createScalarFieldGrid(points, {
      domainBounds: [0, 0, 8, 8],
      fieldColumns: 8,
      fieldRows: 8,
      maskGeoJson: { coordinates: [ring(1, 1, 7, 7), ring(3, 3, 5, 5)], type: "Polygon" },
      valueMetric: "value",
    });

    expect(maskPattern(grid)).toEqual([
      "........",
      ".######.",
      ".######.",
      ".##..##.",
      ".##..##.",
      ".######.",
      ".######.",
      "........",
    ]);
  });

  test("infers the value domain from cells inside the mask only", () => {
    const grid = createScalarFieldGrid(
      [
        { id: "west", latitude: 0, longitude: 0.5, metrics: { value: 0 } },
        { id: "east", latitude: 0, longitude: 2.5, metrics: { value: 30 } },
      ],
      {
        domainBounds: [0, -0.5, 3, 0.5],
        fieldColumns: 3,
        fieldRows: 1,
        maskGeoJson: { coordinates: [ring(0, -0.5, 2, 0.5)], type: "Polygon" },
        valueMetric: "value",
      },
    );

    expect(grid.values[0]).toBeCloseTo(0, 10);
    expect(grid.values[1]).toBeCloseTo(15, 10);
    expect(grid.values[2]).toBeNull();
    expect(grid.valueDomain?.[0]).toBeCloseTo(0, 10);
    expect(grid.valueDomain?.[1]).toBeCloseTo(15, 10);
  });

  test("clips the field raster: masked cells and hole cells are transparent", () => {
    const pixels = captureFieldImagePixels();
    const grid = constantField({ coordinates: [ring(1, 1, 7, 7), ring(3, 3, 5, 5)], type: "Polygon" });

    createHeatFieldImage(grid, { colorRamp: [[0, "#ffffff"]], valueDomain: [0, 20] });
    const alpha = Array.from(pixels()).filter((_, index) => index % 4 === 3);

    expect(alpha.map((value) => (value > 0 ? "#" : ".")).join("")).toBe(maskPattern(grid).join(""));
  });

  test("clips contours: no contour segment crosses a hole or leaves the mask", () => {
    const points = [
      { id: "west", latitude: 4, longitude: 0.5, metrics: { value: 0 } },
      { id: "east", latitude: 4, longitude: 7.5, metrics: { value: 70 } },
    ];
    const field = (maskGeoJson: unknown) =>
      createScalarFieldGrid(points, {
        domainBounds: [0, 0, 8, 8],
        fieldColumns: 8,
        fieldRows: 8,
        maskGeoJson: maskGeoJson as never,
        valueDomain: [0, 70],
        valueMetric: "value",
      });
    const mask = { coordinates: [ring(0, 0, 8, 8), ring(2, 2, 6, 6)], type: "Polygon" };
    const unmasked = createHeatFieldContourFeatureCollection(field(null), { levels: [35] });
    const masked = createHeatFieldContourFeatureCollection(field(mask), { levels: [35] });

    expect(unmasked.features).toHaveLength(1);
    expect(masked.features).toHaveLength(1);
    const maskedLatitudes = contourCoordinates(masked.features[0]!).map(([, latitude]) => latitude);
    // The level crosses near longitude 4, so only segments above and below the hole remain.
    expect(maskedLatitudes.some((latitude) => latitude > 2 && latitude < 6)).toBe(false);
    expect(contourCoordinates(unmasked.features[0]!).length).toBeGreaterThan(
      contourCoordinates(masked.features[0]!).length,
    );
  });
});

describe("heat layer order in a Map View composition", () => {
  test("draws a field heat surface, its contours and data points between neighboring Map Layers", async () => {
    const events = installOrderRecordingCanvas();
    const bounds: ViewportAggregationQuery["bounds"] = [0, 0, 6, 4];
    const getViewport = () => ({ bounds, zoom: 5 });
    const project = ([longitude, latitude]: [number, number]) => ({
      x: longitude * 100,
      y: (4 - latitude) * 100,
    });
    const unproject = (x: number, y: number): [number, number] => [x / 100, 4 - y / 100];
    const surface = {
      handleFeatureClick() {},
      handleFeatureContextMenu() {},
      handleFeatureHover() {},
      isFeatureHovered: () => false,
      isFeatureSelected: () => false,
      setViewState() {},
    };
    const stations = [
      { id: "cold", latitude: 1, longitude: 1, metrics: { value: 0 } },
      { id: "warm", latitude: 3, longitude: 5, metrics: { value: 20 } },
    ];

    await act(async () => {
      render(
        <MapsOverlayLayers
          getViewport={getViewport}
          project={project}
          surface={surface}
          unproject={unproject}
        >
          <PointLayer
            getPointColor={() => "#aa0000"}
            points={[{ id: "below", latitude: 2, longitude: 2 }]}
          />
          <HeatLayer
            dataPointColor="#00aa00"
            domainBounds={bounds}
            fieldColumns={6}
            fieldContourColor="#0000aa"
            fieldContourLevels={[10]}
            fieldRenderMode="raster-contours"
            fieldRows={4}
            heatmapSurfaceMode="field"
            points={stations}
            showDataPoints
            valueMetric="value"
          />
          <PointLayer
            getPointColor={() => "#aaaa00"}
            points={[{ id: "above", latitude: 2, longitude: 4 }]}
          />
        </MapsOverlayLayers>,
      );
    });

    await waitFor(() => expect(events.sequence()).toContain("raster"));
    // Circles fill, then stroke their white outline; each heat data point is one circle.
    expect(events.sequence()).toEqual([
      "fill #aa0000",
      "stroke #ffffff",
      "raster",
      "stroke #0000aa",
      "fill #00aa00",
      "stroke #ffffff",
      "fill #00aa00",
      "stroke #ffffff",
      "fill #aaaa00",
      "stroke #ffffff",
    ]);
  });
});

/* -------------------------------------------------------------------------- */

function weightsOf(index: ReturnType<typeof createHeatLayerSourceIndex>) {
  return index
    .getFeatureCollection([-180, -90, 180, 90])
    .features.map((feature) => feature.properties.weight);
}

function createDensityPlan({
  colorRamp = [
    [0, "rgba(0, 0, 0, 0)"],
    [1, "#dc2626"],
  ],
  data = {
    features: [
      {
        geometry: { coordinates: [0, 0] as [number, number], type: "Point" as const },
        properties: {
          kind: "heat-point" as const,
          label: "",
          pointCount: 1,
          pointId: "a",
          rawWeight: 1,
          weight: 1,
        },
        type: "Feature" as const,
      },
    ],
    type: "FeatureCollection" as const,
  },
  radius = { meters: 100_000 },
  strategy = "stable-raster",
  surfaceCache = null,
}: Partial<Omit<Parameters<typeof createHeatSurfaceRenderPlan>[0], "colorRamp">> & {
  colorRamp?: readonly (readonly [number, string])[];
}) {
  const viewport = {
    bounds: [-10, -8, 10, 8] as [number, number, number, number],
    height: 400,
    project: ([longitude, latitude]: [number, number]) => ({
      x: (longitude + 10) * 30,
      y: (8 - latitude) * 25,
    }),
    unproject: (x: number, y: number): [number, number] => [x / 30 - 10, 8 - y / 25],
    width: 600,
    zoom: 4,
  };

  return createHeatSurfaceRenderPlan({
    colorRamp: prepareHeatLayerColorRamp(colorRamp),
    data,
    height: viewport.height,
    intensity: 1,
    map: createMapsHeatSurfaceViewport(viewport),
    maxRasterPixels: 100_000,
    minZoomDeltaForRebuild: 1,
    mode: "interpolated",
    overscanRatio: 1,
    radius,
    strategy,
    surfaceCache,
    width: viewport.width,
  });
}

function maskPattern(grid: ScalarFieldGrid) {
  return Array.from({ length: grid.rows }, (_, row) =>
    grid.values
      .slice(row * grid.columns, (row + 1) * grid.columns)
      .map((value) => (value === null ? "." : "#"))
      .join(""),
  );
}

function createLinearGrid(row: readonly number[]): ScalarFieldGrid {
  return {
    bounds: [0, 0, row.length, 2],
    columns: row.length,
    rows: 2,
    valueDomain: [Math.min(...row), Math.max(...row)],
    values: [...row, ...row],
  };
}

type ContourFeature = ReturnType<typeof createHeatFieldContourFeatureCollection>["features"][number];

function contourCoordinates(feature: ContourFeature) {
  const geometry = feature.geometry as { coordinates: [number, number][][] };
  return geometry.coordinates.flat();
}

function contourLongitudes(feature: ContourFeature) {
  return [...new Set(contourCoordinates(feature).map(([longitude]) => Math.round(longitude * 1e9) / 1e9))];
}

function captureFieldImagePixels() {
  let captured: Uint8ClampedArray = new Uint8ClampedArray();

  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("maps-heat-fixture-canvas");
  if (typeof ImageData === "undefined") vi.stubGlobal("ImageData", class {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        createImageData: (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData: (imageData: { data: Uint8ClampedArray }) => {
          captured = imageData.data;
        },
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,");

  return () => captured;
}

function installOrderRecordingCanvas() {
  const events: string[] = [];
  const state: Record<string, unknown> = {};
  const context = new Proxy(state, {
    get(target, property) {
      if (property in target) return target[property as string];
      if (property === "fill") return () => events.push(`fill ${String(target.fillStyle)}`);
      if (property === "stroke") return () => events.push(`stroke ${String(target.strokeStyle)}`);
      if (property === "drawImage") return () => events.push("raster");
      if (property === "measureText") return () => ({ width: 0 });
      if (property === "getTransform") return () => new DOMMatrix();
      return () => context;
    },
    set(target, property, value) {
      target[property as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as unknown as RenderingContext,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 400,
    height: 400,
    left: 0,
    right: 600,
    toJSON() {},
    top: 0,
    width: 600,
    x: 0,
    y: 0,
  });

  class LoadedImage {
    complete = false;
    decoding = "auto";
    height = 0;
    naturalHeight = 0;
    naturalWidth = 0;
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    width = 0;
    #src = "";

    get src() {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      this.complete = true;
      this.height = this.naturalHeight = 4;
      this.width = this.naturalWidth = 6;
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", LoadedImage);

  return {
    // Consecutive identical events are one draw of one Map Layer part.
    sequence: () => {
      const start = events.lastIndexOf("fill #aa0000");
      return events
        .slice(Math.max(0, start))
        .filter((event, index, all) => event !== all[index - 1]);
    },
  };
}
