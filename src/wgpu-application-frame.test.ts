import { describe, expect, test } from "vitest";

import type {
  MapRenderCircle,
  MapRenderDirectionMarker,
  MapRenderLine,
  MapRenderPolygon,
} from "./map-render-frame";
import type { MapScreenRenderFrame } from "./map-screen-render-frame";
import {
  createMapsRetainedApplicationRuns,
  createMapsWgpuApplicationFrame,
  createMapsWgpuApplicationFramePacker,
  MAPS_WGPU_APPLICATION_CIRCLE,
  MAPS_RETAINED_APPLICATION_MAX_RUNS,
  MAPS_RETAINED_POINT_RUN_MIN,
  MAPS_RETAINED_POLYGON_PAINT_STRIDE,
  MAPS_RETAINED_SHAPE_CIRCLE,
  MAPS_RETAINED_SHAPE_DIRECTION_MARKER,
  MAPS_RETAINED_SHAPE_LINE,
  MAPS_WGPU_APPLICATION_POLYGON,
  readMapsWgpuApplicationCircles,
  type MapsWgpuApplicationFrame,
} from "./wgpu-application-frame";

/** The packed frame with its typed transport decoded, for structural comparison. */
function decoded(frame: MapsWgpuApplicationFrame | null) {
  if (!frame) return frame;
  const { circleCount: _count, circleData: _data, order, ...rest } = frame;
  const circles = readMapsWgpuApplicationCircles(frame).map((circle) => ({
    ...circle,
    fillColor: circle.fillColor.map((value) => Number(value.toFixed(6))),
    strokeColor: circle.strokeColor.map((value) => Number(value.toFixed(6))),
  }));
  return { ...rest, circles, order: Array.from(order) };
}

describe("wgpu application frame", () => {
  test("packs a complete labeled circle frame with interaction-adjusted stroke width", () => {
    const primitive: MapRenderCircle = {
      center: [0, 0],
      feature: null,
      featureId: "point-a",
      fillColor: "#336699",
      fillOpacity: 0.5,
      interactive: true,
      kind: "circle",
      label: "A",
      primitiveId: "circle-a",
      radius: 7,
      strokeColor: "rgba(255, 255, 255, 0.8)",
      strokeOpacity: 0.75,
      strokeWidth: 2,
    };
    const frame: MapScreenRenderFrame = {
      height: 480,
      primitives: [{ kind: "circle", renderPrimitive: primitive, x: 120, y: 80 }],
      width: 640,
    };

    expect(
      decoded(
        createMapsWgpuApplicationFrame(frame, {
          selectedPrimitiveIds: new Set(["circle-a"]),
        }),
      ),
    ).toEqual({
      circles: [
        {
          fillColor: [0.2, 0.4, 0.6, 0.5],
          radius: 7,
          strokeColor: [1, 1, 1, 0.6],
          strokeWidth: 3.5,
          x: 120,
          y: 80,
        },
      ],
      directionMarkers: [],
      height: 480,
      lines: [],
      order: [MAPS_WGPU_APPLICATION_CIRCLE, 0, 1],
      polygons: [],
      width: 640,
    });
  });

  test("packs circles, lines, and flow direction markers in source render order", () => {
    const circle: MapRenderCircle = {
      center: [0, 0],
      feature: null,
      featureId: "point-a",
      fillColor: "#ffffff",
      fillOpacity: 1,
      interactive: true,
      kind: "circle",
      label: null,
      primitiveId: "circle-a",
      radius: 4,
      strokeColor: "#000000",
      strokeOpacity: 1,
      strokeWidth: 1,
    };
    const line: MapRenderLine = {
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 1],
      ],
      feature: null,
      featureId: "line-a",
      interactive: true,
      kind: "line",
      primitiveId: "line-a",
      strokeColor: "#000000",
      strokeOpacity: 0.5,
      strokeWidth: 2,
    };
    const marker: MapRenderDirectionMarker = {
      anchor: [2, 1],
      color: "#ff0000",
      feature: null,
      featureId: "line-a",
      interactive: false,
      kind: "direction-marker",
      opacity: 0.75,
      previous: [1, 1],
      primitiveId: "marker-a",
      size: 10,
    };
    const frame: MapScreenRenderFrame = {
      height: 480,
      primitives: [
        { kind: "circle", renderPrimitive: circle, x: 120, y: 80 },
        {
          kind: "line",
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 20 },
            { x: 30, y: 20 },
          ],
          renderPrimitive: line,
        },
        {
          angle: Math.PI / 2,
          kind: "direction-marker",
          renderPrimitive: marker,
          x: 30,
          y: 20,
        },
      ],
      width: 640,
    };

    expect(
      decoded(
        createMapsWgpuApplicationFrame(frame, {
          hoveredPrimitiveIds: new Set(["line-a"]),
        }),
      ),
    ).toEqual({
      circles: [
        {
          fillColor: [1, 1, 1, 1],
          radius: 4,
          strokeColor: [0, 0, 0, 1],
          strokeWidth: 1,
          x: 120,
          y: 80,
        },
      ],
      directionMarkers: [
        {
          angle: Math.PI / 2,
          color: [1, 0, 0, 0.75],
          size: 10,
          x: 30,
          y: 20,
        },
      ],
      height: 480,
      lines: [
        {
          color: [0, 0, 0, 0.5],
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 20 },
            { x: 30, y: 20 },
          ],
          strokeWidth: 3,
        },
      ],
      order: [0, 0, 1, 1, 0, 1, 2, 0, 1],
      polygons: [],
      width: 640,
    });
  });

  test("packs projected polygon rings with encoded sRGB paint for WebGPU", () => {
    const polygon: MapRenderPolygon = {
      feature: null,
      featureId: "polygon-a",
      fillColor: "#336699",
      fillOpacity: 0.4,
      interactive: true,
      kind: "polygon",
      primitiveId: "polygon-a",
      rings: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
        [
          [1, 1],
          [1, 3],
          [3, 3],
          [3, 1],
          [1, 1],
        ],
      ],
      strokeColor: "#ffffff",
      strokeOpacity: 1,
      strokeWidth: 2,
    };
    const frame: MapScreenRenderFrame = {
      height: 480,
      primitives: [
        {
          kind: "polygon",
          renderPrimitive: polygon,
          rings: [
            [
              { x: 10, y: 10 },
              { x: 50, y: 10 },
              { x: 50, y: 50 },
              { x: 10, y: 50 },
              { x: 10, y: 10 },
            ],
            [
              { x: 20, y: 20 },
              { x: 20, y: 40 },
              { x: 40, y: 40 },
              { x: 40, y: 20 },
              { x: 20, y: 20 },
            ],
          ],
        },
      ],
      width: 640,
    };

    const packed = createMapsWgpuApplicationFrame(frame, {
      selectedPrimitiveIds: new Set(["polygon-a"]),
    });

    expect(packed).not.toBeNull();
    expect(Array.from(packed?.order ?? [])).toEqual([MAPS_WGPU_APPLICATION_POLYGON, 0, 1]);
    expect(packed?.polygons).toHaveLength(1);
    expect(packed?.polygons[0]).toMatchObject({
      fillColor: [0.2, 0.4, 0.6, 0.4],
      rings: [
        [
          { x: 10, y: 10 },
          { x: 50, y: 10 },
          { x: 50, y: 50 },
          { x: 10, y: 50 },
        ],
        [
          { x: 20, y: 20 },
          { x: 20, y: 40 },
          { x: 40, y: 40 },
          { x: 40, y: 20 },
        ],
      ],
      strokeColor: [1, 1, 1, 1],
      strokeWidth: 3.5,
    });
  });

  test("keeps polygon entries in source painter order", () => {
    const circle: MapRenderCircle = {
      center: [0, 0],
      feature: null,
      featureId: "point-a",
      fillColor: "#ffffff",
      fillOpacity: 1,
      interactive: true,
      kind: "circle",
      label: null,
      primitiveId: "circle-a",
      radius: 4,
      strokeColor: "#000000",
      strokeOpacity: 1,
      strokeWidth: 1,
    };
    const polygon: MapRenderPolygon = {
      feature: null,
      featureId: "polygon-a",
      fillColor: "#336699",
      fillOpacity: 1,
      interactive: true,
      kind: "polygon",
      primitiveId: "polygon-a",
      rings: [
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
      strokeColor: "#ffffff",
      strokeOpacity: 1,
      strokeWidth: 1,
    };
    const line: MapRenderLine = {
      coordinates: [
        [0, 0],
        [1, 1],
      ],
      feature: null,
      featureId: "line-a",
      interactive: true,
      kind: "line",
      primitiveId: "line-a",
      strokeColor: "#000000",
      strokeOpacity: 1,
      strokeWidth: 1,
    };
    const frame: MapScreenRenderFrame = {
      height: 100,
      primitives: [
        { kind: "circle", renderPrimitive: circle, x: 10, y: 10 },
        {
          kind: "polygon",
          renderPrimitive: polygon,
          rings: [
            [
              { x: 20, y: 20 },
              { x: 40, y: 20 },
              { x: 20, y: 40 },
              { x: 20, y: 20 },
            ],
          ],
        },
        {
          kind: "line",
          points: [
            { x: 50, y: 50 },
            { x: 70, y: 70 },
          ],
          renderPrimitive: line,
        },
      ],
      width: 100,
    };

    expect(Array.from(createMapsWgpuApplicationFrame(frame)?.order ?? [])).toEqual([
      0,
      0,
      1,
      MAPS_WGPU_APPLICATION_POLYGON,
      0,
      1,
      1,
      0,
      1,
    ]);
  });

  test("keeps zero-area rings that Canvas still strokes and omits collapsed polygons", () => {
    const polygon: MapRenderPolygon = {
      feature: null,
      featureId: "polygon-a",
      fillColor: "#336699",
      fillOpacity: 1,
      interactive: true,
      kind: "polygon",
      primitiveId: "polygon-a",
      rings: [],
      strokeColor: "#ffffff",
      strokeOpacity: 1,
      strokeWidth: 1,
    };
    const frame = (rings: { x: number; y: number }[][]): MapScreenRenderFrame => ({
      height: 100,
      primitives: [{ kind: "polygon", renderPrimitive: polygon, rings }],
      width: 100,
    });

    const packed = createMapsWgpuApplicationFrame(
      frame([
        [
          { x: 10, y: 10 },
          { x: 20, y: 20 },
          { x: 10, y: 10 },
        ],
        [
          { x: 30, y: 30 },
          { x: 30, y: 30 },
        ],
      ]),
    );

    expect(packed?.polygons[0]?.rings).toEqual([
      [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
    ]);
    const collapsed = createMapsWgpuApplicationFrame(
      frame([
        [
          { x: 30, y: 30 },
          { x: 30, y: 30 },
        ],
      ]),
    );
    expect(collapsed?.polygons).toEqual([]);
    expect(Array.from(collapsed?.order ?? [])).toEqual([]);
    expect(
      createMapsWgpuApplicationFrame(
        frame([
          [
            { x: 10, y: 10 },
            { x: Number.NaN, y: 20 },
            { x: 20, y: 10 },
          ],
        ]),
      ),
    ).toBeNull();
  });

  test("fails closed for degenerate line geometry", () => {
    const line: MapRenderLine = {
      coordinates: [
        [0, 0],
        [0, 0],
      ],
      feature: null,
      featureId: "line-a",
      interactive: true,
      kind: "line",
      primitiveId: "line-a",
      strokeColor: "#000000",
      strokeOpacity: 1,
      strokeWidth: 2,
    };
    const frame: MapScreenRenderFrame = {
      height: 480,
      primitives: [
        {
          kind: "line",
          points: [
            { x: 10, y: 10 },
            { x: 10, y: 10 },
          ],
          renderPrimitive: line,
        },
      ],
      width: 640,
    };

    expect(createMapsWgpuApplicationFrame(frame)).toBeNull();
  });

  test("fails closed for unsupported CSS colors", () => {
    const primitive: MapRenderCircle = {
      center: [0, 0],
      feature: null,
      featureId: "point-a",
      fillColor: "rebeccapurple",
      fillOpacity: 1,
      interactive: true,
      kind: "circle",
      label: null,
      primitiveId: "circle-a",
      radius: 7,
      strokeColor: "#ffffff",
      strokeOpacity: 1,
      strokeWidth: 2,
    };
    const frame: MapScreenRenderFrame = {
      height: 480,
      primitives: [{ kind: "circle", renderPrimitive: primitive, x: 120, y: 80 }],
      width: 640,
    };

    expect(createMapsWgpuApplicationFrame(frame)).toBeNull();
  });

  test("packs dense circles into reused typed buffers with cached paint and one order run", () => {
    const circles = (count: number, offset = 0) => ({
      height: 600,
      primitives: Array.from({ length: count }, (_, index) => ({
        kind: "circle" as const,
        renderPrimitive: {
          center: [0, 0],
          feature: null,
          featureId: `point-${index}`,
          fillColor: index % 2 ? "#336699" : "#ffffff",
          fillOpacity: 1,
          interactive: true,
          kind: "circle" as const,
          label: null,
          primitiveId: `circle-${index}`,
          radius: 4,
          strokeColor: "#000000",
          strokeOpacity: 1,
          strokeWidth: 1,
        } satisfies MapRenderCircle,
        x: (index % 800) + offset,
        y: Math.floor(index / 800),
      })),
      width: 800,
    });
    const packer = createMapsWgpuApplicationFramePacker();
    const dense = circles(10_000);

    const first = packer.pack(dense)!;
    const afterFirst = packer.stats();
    // A camera-only frame: same primitives at new screen positions.
    const moved = circles(10_000, 3);
    const second = packer.pack(moved)!;
    const afterSecond = packer.stats();

    expect(first.circleCount).toBe(10_000);
    expect(Array.from(second.order)).toEqual([MAPS_WGPU_APPLICATION_CIRCLE, 0, 10_000]);
    // Three distinct paint values, parsed once across both frames.
    expect(afterFirst.paintParses).toBe(3);
    expect(afterSecond.paintParses).toBe(3);
    // The second frame reuses the grown buffers.
    expect(afterSecond.bufferAllocations).toBe(afterFirst.bufferAllocations);
    expect(second.circleData.buffer).toBe(first.circleData.buffer);
    // Bridge bytes: 12 f32 per circle plus one 3 x u32 order run per frame.
    expect(afterSecond.transportBytes - afterFirst.transportBytes).toBe(10_000 * 12 * 4 + 12);
    expect(readMapsWgpuApplicationCircles(second)[0]).toMatchObject({ x: 3, y: 0 });
  });
});

describe("retained application runs (#195)", () => {
  const base = { feature: null, featureId: "f", interactive: true };
  const circle = (id: string, label: string | null = null): MapRenderCircle => ({
    ...base,
    center: [1, 2],
    fillColor: "#ff0000",
    fillOpacity: 1,
    kind: "circle",
    label,
    primitiveId: id,
    radius: 4,
    strokeColor: "#000000",
    strokeOpacity: 1,
    strokeWidth: 1,
  });
  const line = (id: string, coordinates: [number, number][] = [[0, 0], [1, 1]]): MapRenderLine => ({
    ...base,
    coordinates,
    kind: "line",
    primitiveId: id,
    strokeColor: "rgba(0, 128, 255, 0.5)",
    strokeOpacity: 0.8,
    strokeWidth: 3,
  });
  const marker = (id: string): MapRenderDirectionMarker => ({
    ...base,
    anchor: [1, 1],
    color: "#00ff00",
    kind: "direction-marker",
    opacity: 1,
    previous: [0, 0],
    primitiveId: id,
    size: 9,
  });
  const runs = (primitives: Parameters<typeof createMapsRetainedApplicationRuns>[0]["primitives"]) =>
    createMapsRetainedApplicationRuns({ kind: "vector", primitives });

  const circles = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => circle(`${prefix}${index}`));

  test("splits painter order into point and shape runs", () => {
    const result = runs([
      ...circles(MAPS_RETAINED_POINT_RUN_MIN, "a"),
      line("l"),
      marker("m"),
      ...circles(MAPS_RETAINED_POINT_RUN_MIN, "b"),
    ]);

    expect(result?.map((run) => run.kind)).toEqual(["points", "polygons", "points"]);
    const shapes = result![1]!;
    if (shapes.kind !== "polygons") throw new Error("expected shapes");
    expect(Array.from(shapes.polygons.ringCounts)).toEqual([1, 1]);
    expect(Array.from(shapes.polygons.pointCounts)).toEqual([2, 2]);
    // The marker ring is [previous, anchor].
    expect(Array.from(shapes.polygons.lonLat)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
    const paint = shapes.polygons.paint;
    const stride = MAPS_RETAINED_POLYGON_PAINT_STRIDE;
    expect(paint[3]).toBe(0);
    expect(paint[7]).toBeCloseTo(0.4);
    expect(paint[8]).toBe(3);
    expect(paint[9]).toBe(MAPS_RETAINED_SHAPE_LINE);
    expect(paint[stride + 8]).toBe(9);
    expect(paint[stride + 9]).toBe(MAPS_RETAINED_SHAPE_DIRECTION_MARKER);
  });

  test("keeps short circle runs, such as flow endpoints, in the shape group", () => {
    const flow = [line("l1"), marker("m1"), circle("to1"), circle("from1")];
    const result = runs([...flow, line("l2"), circle("to2")]);

    expect(result?.map((run) => run.kind)).toEqual(["polygons"]);
    const [shapes] = result!;
    if (shapes?.kind !== "polygons") throw new Error("expected shapes");
    const stride = MAPS_RETAINED_POLYGON_PAINT_STRIDE;
    expect(shapes.polygons.paint[2 * stride + 9]).toBe(MAPS_RETAINED_SHAPE_CIRCLE);
    expect(shapes.polygons.paint[2 * stride + 10]).toBe(4);
    expect(shapes.polygons.paint[2 * stride + 3]).toBe(1);
    // A frame of circles only stays one instanced point group, however short.
    expect(runs([circle("a")])?.map((run) => run.kind)).toEqual(["points"]);
  });

  test("applies the screen transport's interaction stroke deltas to lines", () => {
    const result = createMapsRetainedApplicationRuns(
      { kind: "vector", primitives: [line("l")] },
      { selectedPrimitiveIds: new Set(["l"]) },
    );
    const [shapes] = result!;
    if (shapes?.kind !== "polygons") throw new Error("expected shapes");
    expect(shapes.polygons.paint[8]).toBe(4.5);
  });

  test("retains labeled circles with their unlabeled neighbours (#204)", () => {
    // Only the label text needs a screen position; the circles stay in painter order.
    const result = runs([
      ...circles(MAPS_RETAINED_POINT_RUN_MIN, "a"),
      circle("labeled", "Label"),
      ...circles(MAPS_RETAINED_POINT_RUN_MIN, "b"),
    ]);
    expect(result?.map((run) => run.kind)).toEqual(["points"]);
    const [points] = result!;
    if (points?.kind !== "points") throw new Error("expected points");
    expect(points.points.count).toBe(MAPS_RETAINED_POINT_RUN_MIN * 2 + 1);
    expect(runs([circle("labeled", "Label")])?.map((run) => run.kind)).toEqual(["points"]);
    // A labeled flow endpoint stays in its shape group.
    expect(runs([line("l"), circle("labeled", "Label")])?.map((run) => run.kind)).toEqual([
      "polygons",
    ]);
  });

  test("keeps frames that still need screen work on the projected path", () => {
    expect(runs([])).toBeNull();
    expect(runs([line("degenerate", [[1, 1], [1, 1]])])).toBeNull();
    expect(runs([line("nan", [[0, 0], [Number.NaN, 1]])])).toBeNull();

    const pitched = { shapes: false };
    expect(
      createMapsRetainedApplicationRuns({ kind: "vector", primitives: [circle("a"), line("l")] }, {}, pitched),
    ).toBeNull();
    expect(
      createMapsRetainedApplicationRuns({ kind: "vector", primitives: [circle("a")] }, {}, pitched),
    ).toHaveLength(1);

    const alternating = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        index % 2 === 0 ? circles(MAPS_RETAINED_POINT_RUN_MIN, `c${index}-`) : [line(`l${index}`)],
      ).flat();
    expect(runs(alternating(MAPS_RETAINED_APPLICATION_MAX_RUNS + 1))).toBeNull();
    expect(runs(alternating(MAPS_RETAINED_APPLICATION_MAX_RUNS))).toHaveLength(
      MAPS_RETAINED_APPLICATION_MAX_RUNS,
    );
  });
});

