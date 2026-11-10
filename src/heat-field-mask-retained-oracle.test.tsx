import { createHash } from "node:crypto";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { MapPoint, ViewportAggregationQuery } from "./aggregation";
import { HeatLayer } from "./heat-layer";
import { MapsOverlayLayers } from "./maps-overlay-layers";
import { createScalarFieldGrid, type HeatFieldMaskGeoJson, type ScalarFieldGrid } from "./scalar-field";
import {
  createHeatFieldContourFeatureCollection,
  createHeatFieldImage,
} from "./scalar-field-render";

/*
 * PRINCIPLE-010 / TEST-022 differential oracle for masked scalar fields (#171).
 *
 * The retained path is the production one: a `HeatLayer` in field mode on the
 * Maps overlay, re-rendered through a mutation sequence of masks and data, with
 * its memoized (sync) or retained and superseded (async) field artifacts.
 *
 * The oracle shares neither that retention nor the mask implementation. For
 * every step it interpolates a fresh unmasked field, clips it with its own
 * winding-number point-in-polygon test, and derives the value domain from the
 * remaining cells. Only the stateless image/contour kernels are reused. The
 * retained path is observed through what the canvas actually draws: the field
 * raster's image source and the stroked contour vertices.
 */

const BOUNDS: ViewportAggregationQuery["bounds"] = [0, 0, 12, 8];
const COLUMNS = 12;
const ROWS = 8;
const CONTOUR_COLOR = "#0000aa";
const CONTOUR_LEVELS = [8, 16];
const PIXELS_PER_DEGREE = 50;

const ring = (west: number, south: number, east: number, north: number): [number, number][] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

// Ring edges sit on quarter degrees, so no cell center (at half degrees) is on a boundary.
const MASK_WITH_HOLE: HeatFieldMaskGeoJson = {
  coordinates: [ring(1.25, 1.25, 10.75, 6.75), ring(4.25, 2.25, 7.75, 5.75)],
  type: "Polygon",
};
const MASK_TRIANGLE: HeatFieldMaskGeoJson = {
  geometry: {
    coordinates: [
      [
        [0.25, 0.25],
        [11.75, 0.25],
        [6.1, 7.75],
        [0.25, 0.25],
      ],
    ],
    type: "Polygon",
  },
  properties: {},
  type: "Feature",
};
const MASK_ISLANDS: HeatFieldMaskGeoJson = {
  features: [
    {
      geometry: {
        coordinates: [
          [ring(0.25, 0.25, 5.75, 7.75), ring(1.25, 1.25, 4.75, 6.75)],
          [ring(2.25, 2.25, 3.75, 5.75)],
          [ring(8.25, 3.25, 11.75, 7.75)],
        ],
        type: "MultiPolygon",
      },
      properties: {},
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
};
const MASK_WITHOUT_AREA: HeatFieldMaskGeoJson = { features: [], type: "FeatureCollection" };

const STATIONS: readonly MapPoint[] = [
  { id: "sw", latitude: 1, longitude: 1, metrics: { value: 0 } },
  { id: "se", latitude: 1.5, longitude: 11, metrics: { value: 12 } },
  { id: "nw", latitude: 7, longitude: 2, metrics: { value: 18 } },
  { id: "ne", latitude: 6.5, longitude: 10.5, metrics: { value: 24 } },
];
const LATER_STATIONS: readonly MapPoint[] = [
  { id: "sw", latitude: 1, longitude: 1, metrics: { value: 22 } },
  { id: "se", latitude: 1.5, longitude: 11, metrics: { value: 3 } },
  { id: "center", latitude: 4, longitude: 6, metrics: { value: 30 } },
];

type FieldInputs = {
  maskGeoJson: HeatFieldMaskGeoJson | null;
  points: readonly MapPoint[];
};

const MUTATION_SEQUENCE: readonly FieldInputs[] = [
  { maskGeoJson: null, points: STATIONS },
  { maskGeoJson: MASK_WITH_HOLE, points: STATIONS },
  { maskGeoJson: MASK_TRIANGLE, points: STATIONS },
  { maskGeoJson: MASK_WITH_HOLE, points: STATIONS },
  { maskGeoJson: MASK_WITH_HOLE, points: LATER_STATIONS },
  { maskGeoJson: MASK_ISLANDS, points: LATER_STATIONS },
  { maskGeoJson: MASK_WITHOUT_AREA, points: LATER_STATIONS },
  { maskGeoJson: MASK_ISLANDS, points: STATIONS },
  { maskGeoJson: null, points: STATIONS },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("retained masked scalar field differential oracle", () => {
  test.each([
    { fieldAsyncRender: false, name: "memoized (sync)" },
    { fieldAsyncRender: true, name: "retained (async)" },
  ])("$name field artifacts match a fresh uncached masked field over a mask/data mutation sequence", async ({
    fieldAsyncRender,
  }) => {
    const canvas = installRecordingCanvas();
    const view = await renderField(MUTATION_SEQUENCE[0]!, fieldAsyncRender);
    const distinctRasters = new Set<string>();
    const distinctContours = new Set<string>();

    for (const [step, inputs] of MUTATION_SEQUENCE.entries()) {
      if (step > 0) await view.update(inputs);

      const reference = createReferenceArtifact(inputs);

      await waitFor(() => {
        expect(canvas.latestFrame().rasterUrl, `raster at step ${step}`).toBe(reference.rasterUrl);
        expect(canvas.latestFrame().contourVertices, `contours at step ${step}`).toEqual(
          reference.contourVertices,
        );
      });
      distinctRasters.add(reference.rasterUrl);
      distinctContours.add(reference.contourVertices.join(" "));
    }

    // The sequence must actually exercise different clips, or equality above proves nothing.
    expect(distinctRasters.size).toBe(7);
    expect(distinctContours.size).toBeGreaterThan(4);
  });

  test("a superseded async mask request never reaches the canvas", async () => {
    const canvas = installRecordingCanvas();
    const initial: FieldInputs = { maskGeoJson: null, points: STATIONS };
    const superseded: FieldInputs = { maskGeoJson: MASK_TRIANGLE, points: STATIONS };
    const newest: FieldInputs = { maskGeoJson: MASK_WITH_HOLE, points: STATIONS };
    const view = await renderField(initial, true);

    await waitFor(() =>
      expect(canvas.latestFrame().rasterUrl).toBe(createReferenceArtifact(initial).rasterUrl),
    );
    await act(async () => {
      view.rerender(superseded);
      view.rerender(newest);
    });
    await waitFor(() =>
      expect(canvas.latestFrame().rasterUrl).toBe(createReferenceArtifact(newest).rasterUrl),
    );

    expect(canvas.drawnRasterUrls()).not.toContain(createReferenceArtifact(superseded).rasterUrl);
  });

  test("teardown discards an in-flight async mask request", async () => {
    const canvas = installRecordingCanvas();
    const initial: FieldInputs = { maskGeoJson: null, points: STATIONS };
    const pending: FieldInputs = { maskGeoJson: MASK_WITH_HOLE, points: STATIONS };
    const view = await renderField(initial, true);

    await waitFor(() =>
      expect(canvas.latestFrame().rasterUrl).toBe(createReferenceArtifact(initial).rasterUrl),
    );
    await act(async () => {
      view.rerender(pending);
      view.unmount();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(canvas.drawnRasterUrls()).not.toContain(createReferenceArtifact(pending).rasterUrl);
  });
});

/* ------------------------------- retained path ------------------------------ */

async function renderField(initial: FieldInputs, fieldAsyncRender: boolean) {
  const getViewport = () => ({ bounds: BOUNDS, zoom: 5 });
  const surface = {
    handleFeatureClick() {},
    handleFeatureContextMenu() {},
    handleFeatureHover() {},
    isFeatureHovered: () => false,
    isFeatureSelected: () => false,
    setViewState() {},
  };
  const tree = ({ maskGeoJson, points }: FieldInputs) => (
    <MapsOverlayLayers getViewport={getViewport} project={project} surface={surface} unproject={unproject}>
      <HeatLayer
        domainBounds={BOUNDS}
        fieldAsyncRender={fieldAsyncRender}
        fieldColumns={COLUMNS}
        fieldContourColor={CONTOUR_COLOR}
        fieldContourLevels={CONTOUR_LEVELS}
        fieldOpacity={1}
        fieldRenderMode="raster-contours"
        fieldRows={ROWS}
        heatmapSurfaceMode="field"
        maskGeoJson={maskGeoJson}
        points={points}
        valueMetric="value"
      />
    </MapsOverlayLayers>
  );
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(tree(initial));
  });

  return {
    rerender: (inputs: FieldInputs) => view.rerender(tree(inputs)),
    unmount: () => view.unmount(),
    update: (inputs: FieldInputs) =>
      act(async () => {
        view.rerender(tree(inputs));
      }),
  };
}

function project([longitude, latitude]: [number, number]) {
  return { x: longitude * PIXELS_PER_DEGREE, y: (BOUNDS[3] - latitude) * PIXELS_PER_DEGREE };
}

function unproject(x: number, y: number): [number, number] {
  return [x / PIXELS_PER_DEGREE, BOUNDS[3] - y / PIXELS_PER_DEGREE];
}

/* ---------------------------------- oracle ---------------------------------- */

function createReferenceArtifact({ maskGeoJson, points }: FieldInputs) {
  const unmasked = createScalarFieldGrid(points, {
    domainBounds: BOUNDS,
    fieldColumns: COLUMNS,
    fieldRows: ROWS,
    valueMetric: "value",
  });
  const polygons = maskGeoJson ? referencePolygons(maskGeoJson) : null;
  const [west, , , north] = BOUNDS;
  const values = unmasked.values.map((value, index) => {
    const longitude = west + ((index % COLUMNS) + 0.5) * ((BOUNDS[2] - west) / COLUMNS);
    const latitude = north - (Math.floor(index / COLUMNS) + 0.5) * ((north - BOUNDS[1]) / ROWS);

    return !polygons || referenceMaskContains(polygons, longitude, latitude) ? value : null;
  });
  const kept = values.filter((value): value is number => value !== null);
  const grid: ScalarFieldGrid = {
    ...unmasked,
    // With nothing left inside the mask the domain falls back to the measured values.
    valueDomain: kept.length > 0 ? [Math.min(...kept), Math.max(...kept)] : unmasked.valueDomain,
    values,
  };
  const contours = createHeatFieldContourFeatureCollection(grid, { levels: CONTOUR_LEVELS });

  return {
    contourVertices: sortVertices(
      contours.features.flatMap((feature) =>
        (feature.geometry as { coordinates: [number, number][][] }).coordinates
          .filter((line) => line.length >= 2)
          .flat()
          .map((coordinate) => project(coordinate)),
      ),
    ),
    rasterUrl: digest(createHeatFieldImage(grid)!.url),
  };
}

type ReferencePolygon = [number, number][][];

function referencePolygons(geoJson: unknown): ReferencePolygon[] {
  const node = geoJson as {
    coordinates?: unknown;
    features?: unknown[];
    geometry?: unknown;
    type: string;
  };

  if (node.type === "FeatureCollection") return (node.features ?? []).flatMap(referencePolygons);
  if (node.type === "Feature") return referencePolygons(node.geometry);
  if (node.type === "MultiPolygon") return node.coordinates as ReferencePolygon[];
  return [node.coordinates as ReferencePolygon];
}

function referenceMaskContains(polygons: readonly ReferencePolygon[], x: number, y: number) {
  return polygons.some(
    ([exterior, ...holes]) =>
      windingNumber(exterior!, x, y) !== 0 && holes.every((hole) => windingNumber(hole, x, y) === 0),
  );
}

// Sunday's winding-number test: a different algorithm from production's even-odd crossing rule.
function windingNumber(closedRing: readonly [number, number][], x: number, y: number) {
  let winding = 0;

  for (let index = 0; index < closedRing.length - 1; index += 1) {
    const [x0, y0] = closedRing[index]!;
    const [x1, y1] = closedRing[index + 1]!;
    const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);

    if (y0 <= y && y1 > y && side > 0) winding += 1;
    if (y0 > y && y1 <= y && side < 0) winding -= 1;
  }

  return winding;
}

// The field raster is an image source that encodes every pixel; compare it by digest.
function digest(url: string) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function sortVertices(vertices: readonly { x: number; y: number }[]) {
  return vertices
    .map(({ x, y }) => `${x.toFixed(4)},${y.toFixed(4)}`)
    .sort();
}

/* ----------------------------- recording canvas ----------------------------- */

function installRecordingCanvas() {
  type Frame = { contourVertices: string[]; rasterUrl: string | null };
  const drawnRasterUrls: string[] = [];
  const state: Record<string, unknown> = {};
  let frame: Frame = { contourVertices: [], rasterUrl: null };
  let completedFrame: Frame = frame;
  let path: { x: number; y: number }[] = [];
  const context = new Proxy(state, {
    get(target, property) {
      if (property in target) return target[property as string];
      if (property === "clearRect")
        return () => {
          frame = { contourVertices: [], rasterUrl: null };
        };
      if (property === "beginPath") return () => (path = []);
      if (property === "moveTo" || property === "lineTo")
        return (x: number, y: number) => path.push({ x, y });
      if (property === "stroke")
        return () => {
          if (target.strokeStyle === CONTOUR_COLOR) {
            frame.contourVertices = sortVertices([
              ...frame.contourVertices.map((vertex) => {
                const [x, y] = vertex.split(",").map(Number);
                return { x: x!, y: y! };
              }),
              ...path,
            ]);
          }
          completedFrame = frame;
        };
      if (property === "drawImage")
        return (image: { src: string }) => {
          frame.rasterUrl = digest(image.src);
          drawnRasterUrls.push(frame.rasterUrl);
          completedFrame = frame;
        };
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
      this.height = this.naturalHeight = ROWS;
      this.width = this.naturalWidth = COLUMNS;
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", LoadedImage);

  return {
    drawnRasterUrls: () => drawnRasterUrls,
    latestFrame: () => completedFrame,
  };
}
