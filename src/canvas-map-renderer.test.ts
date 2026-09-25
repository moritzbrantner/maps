import { describe, expect, it, vi } from "vitest";

import {
  createCanvasMapScene,
  createCanvasMapSceneProjector,
  hitTestCanvasMapScene,
} from "./canvas-map-renderer";
import type {
  MapRenderCircle,
  MapRenderLine,
  MapRenderPolygon,
  MapVectorRenderFrame,
} from "./map-render-frame";

describe("Canvas map renderer", () => {
  it("projects valid primitives and rejects a whole primitive with invalid projection", () => {
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [
        circle("circle", [1, 2]),
        line("line", [
          [3, 4],
          [99, 99],
        ]),
      ],
    };

    const scene = createCanvasMapScene(
      frame,
      ([x, y]) => (x === 99 ? null : { x: x * 10, y: y * 10 }),
      { width: 320, height: 180 },
    );

    expect(scene).toMatchObject({ height: 180, width: 320 });
    expect(scene.primitives).toHaveLength(1);
    expect(scene.primitives[0]).toMatchObject({ kind: "circle", x: 10, y: 20 });
  });

  it("picks in reverse draw order", () => {
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [circle("bottom", [10, 10]), circle("top", [10, 10])],
    };
    const scene = identityScene(frame);

    expect(hitTestCanvasMapScene(scene, { x: 10, y: 10 })?.renderPrimitive.featureId).toBe("top");
  });

  it("ignores noninteractive primitives during hit testing", () => {
    const passive = circle("passive", [10, 10]);
    passive.interactive = false;
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [circle("active", [10, 10]), passive],
    };
    const scene = identityScene(frame);

    expect(hitTestCanvasMapScene(scene, { x: 10, y: 10 })?.renderPrimitive.featureId).toBe(
      "active",
    );
  });

  it("uses bounded screen-space tolerance for line picking", () => {
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [
        line("road", [
          [0, 0],
          [20, 0],
        ]),
      ],
    };
    const scene = identityScene(frame);

    expect(hitTestCanvasMapScene(scene, { x: 10, y: 3 })?.renderPrimitive.featureId).toBe("road");
    expect(hitTestCanvasMapScene(scene, { x: 10, y: 9 })).toBeNull();
  });

  it("uses even-odd polygon semantics while keeping visible hole strokes pickable", () => {
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [
        polygon("area", [
          [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
            [0, 0],
          ],
          [
            [4, 4],
            [16, 4],
            [16, 16],
            [4, 16],
            [4, 4],
          ],
        ]),
      ],
    };
    const scene = identityScene(frame);

    expect(hitTestCanvasMapScene(scene, { x: 2, y: 2 })?.renderPrimitive.featureId).toBe("area");
    expect(hitTestCanvasMapScene(scene, { x: 10, y: 10 })).toBeNull();
    expect(hitTestCanvasMapScene(scene, { x: 5, y: 10 })?.renderPrimitive.featureId).toBe("area");
  });

  it("keeps projected scene identity tied to the semantic primitive", () => {
    const semantic = circle("point-42", [4, 5]);
    semantic.primitiveId = "layer:point-42:circle";
    const scene = identityScene({ kind: "vector", primitives: [semantic] });
    const hit = hitTestCanvasMapScene(scene, { x: 4, y: 5 });

    expect(hit?.renderPrimitive).toBe(semantic);
    expect(hit?.renderPrimitive.featureId).toBe("point-42");
    expect(hit?.renderPrimitive.primitiveId).toBe("layer:point-42:circle");
  });
});

function identityScene(frame: MapVectorRenderFrame) {
  return createCanvasMapScene(frame, ([x, y]) => ({ x, y }), { width: 100, height: 100 });
}

function base(featureId: string) {
  return {
    feature: { id: featureId },
    featureId,
    interactive: true,
    primitiveId: featureId,
  };
}

function circle(featureId: string, center: [number, number]): MapRenderCircle {
  return {
    ...base(featureId),
    center,
    fillColor: "#000000",
    fillOpacity: 1,
    kind: "circle",
    label: null,
    radius: 5,
    strokeColor: "#ffffff",
    strokeOpacity: 1,
    strokeWidth: 2,
  };
}

function line(featureId: string, coordinates: [number, number][]): MapRenderLine {
  return {
    ...base(featureId),
    coordinates,
    kind: "line",
    strokeColor: "#000000",
    strokeOpacity: 1,
    strokeWidth: 2,
  };
}

function polygon(featureId: string, rings: [number, number][][]): MapRenderPolygon {
  return {
    ...base(featureId),
    fillColor: "#000000",
    fillOpacity: 1,
    kind: "polygon",
    rings,
    strokeColor: "#000000",
    strokeOpacity: 1,
    strokeWidth: 2,
  };
}

describe("retained Canvas projection", () => {
  it("reuses immutable primitives while preserving holes, ordering and picking", () => {
    const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
    const prepare = createCanvasMapSceneProjector();
    const area = polygon("area", [
      [
        [0, 0],
        [40, 0],
        [40, 40],
        [0, 40],
        [0, 0],
      ],
      [
        [10, 10],
        [30, 10],
        [30, 30],
        [10, 30],
        [10, 10],
      ],
    ]);
    const lower = circle("lower", [4, 4]);
    const upper = circle("upper", [4, 4]);
    const frame: MapVectorRenderFrame = { kind: "vector", primitives: [area, lower, upper] };
    const size = { width: 100, height: 100 };
    const initial = prepare(frame, project, size);
    const calls = project.mock.calls.length;
    expect(prepare(frame, project, size)).toEqual(initial);
    expect(project).toHaveBeenCalledTimes(calls);
    expect(hitTestCanvasMapScene(initial, { x: 20, y: 20 })).toBeNull();
    expect(hitTestCanvasMapScene(initial, { x: 4, y: 4 })?.renderPrimitive.featureId).toBe("upper");
    const reordered = prepare({ ...frame, primitives: [area, upper, lower] }, project, size);
    expect(project).toHaveBeenCalledTimes(calls);
    expect(reordered.primitives[1]).toBe(initial.primitives[2]);
    expect(hitTestCanvasMapScene(reordered, { x: 4, y: 4 })?.renderPrimitive.featureId).toBe(
      "lower",
    );
    expect(reordered).toEqual(
      createCanvasMapScene(
        { ...frame, primitives: [area, upper, lower] },
        ([x, y]) => ({ x, y }),
        size,
      ),
    );
  });

  it("invalidates changed primitives, dimensions and camera callbacks independently", () => {
    const prepare = createCanvasMapSceneProjector();
    const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [circle("a", [1, 2]), circle("b", [3, 4])],
    };
    const size = { width: 100, height: 100 };
    const initial = prepare(frame, project, size);
    const changed: MapVectorRenderFrame = {
      ...frame,
      primitives: [frame.primitives[0]!, circle("b", [8, 9])],
    };
    const updated = prepare(changed, project, size);
    expect(project).toHaveBeenCalledTimes(3);
    expect(updated.primitives[0]).toBe(initial.primitives[0]);
    expect(updated.primitives[1]).toMatchObject({ x: 8, y: 9 });
    prepare(changed, project, { ...size, width: 200 });
    expect(project).toHaveBeenCalledTimes(5);
    prepare(changed, project, { width: 200, height: 150 });
    expect(project).toHaveBeenCalledTimes(7);
    const moved = vi.fn(([x, y]: [number, number]) => ({ x: x + 10, y }));
    const result = prepare(changed, moved, size);
    expect(moved).toHaveBeenCalledTimes(2);
    expect(result.primitives[0]).toMatchObject({ x: 11, y: 2 });
  });

  it("projects a dense retained frame through one packed runtime call per camera revision", () => {
    const prepare = createCanvasMapSceneProjector();
    const scalar = vi.fn(([x, y]: [number, number]) => ({ x, y }));
    const packed = vi.fn((coordinates: Float64Array) => {
      const result = new Float64Array(coordinates.length);
      for (let index = 0; index < coordinates.length; index += 2) {
        result[index] = coordinates[index]! * 10;
        result[index + 1] = coordinates[index + 1]! * 10;
      }
      return result;
    });
    const project = Object.assign(scalar, { projectPacked: packed });
    const shared: [number, number] = [5, 6];
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [
        circle("point", shared),
        line("road", [shared, [7, 8], [9, 10]]),
        polygon("area", [[[1, 2], [3, 4], shared]]),
      ],
    };
    const size = { width: 100, height: 100 };

    const first = prepare(frame, project, size, 1);
    expect(packed).toHaveBeenCalledTimes(1);
    expect(scalar).not.toHaveBeenCalled();
    expect(packed.mock.calls[0]![0]).toHaveLength(10);
    expect(first.primitives[0]).toMatchObject({ x: 50, y: 60 });

    prepare(frame, project, size, 1);
    expect(packed).toHaveBeenCalledTimes(1);
    expect(scalar).not.toHaveBeenCalled();

    prepare(frame, project, size, 2);
    expect(packed).toHaveBeenCalledTimes(2);
    expect(scalar).not.toHaveBeenCalled();
  });

  it("preserves per-coordinate rejection in packed projection without failing the frame", () => {
    const prepare = createCanvasMapSceneProjector();
    const scalar = vi.fn(([x, y]: [number, number]) => ({ x, y }));
    const project = Object.assign(scalar, {
      projectPacked(coordinates: Float64Array) {
        const result = new Float64Array(coordinates.length);
        for (let index = 0; index < coordinates.length; index += 2) {
          const x = coordinates[index]!;
          result[index] = x === 99 ? Number.NaN : x;
          result[index + 1] = x === 99 ? Number.NaN : coordinates[index + 1]!;
        }
        return result;
      },
    });
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [
        circle("visible", [1, 2]),
        line("hidden", [
          [3, 4],
          [99, 5],
        ]),
      ],
    };

    const scene = prepare(frame, project, { width: 100, height: 100 });
    expect(scene.primitives.map((primitive) => primitive.renderPrimitive.featureId)).toEqual([
      "visible",
    ]);
    expect(scalar).not.toHaveBeenCalled();
  });

  it("caches whole-primitive rejection and retries it after a camera change", () => {
    const prepare = createCanvasMapSceneProjector();
    const invalid = vi.fn(([x, y]: [number, number]) => (x === 99 ? null : { x, y }));
    const frame: MapVectorRenderFrame = {
      kind: "vector",
      primitives: [
        line("line", [
          [1, 2],
          [99, 3],
        ]),
        polygon("polygon", [
          [
            [0, 0],
            [20, 0],
            [20, 20],
          ],
          [
            [3, 3],
            [99, 3],
            [3, 5],
          ],
        ]),
      ],
    };
    const size = { width: 100, height: 100 };
    expect(prepare(frame, invalid, size).primitives).toEqual([]);
    const calls = invalid.mock.calls.length;
    expect(prepare(frame, invalid, size).primitives).toEqual([]);
    expect(invalid).toHaveBeenCalledTimes(calls);
    expect(prepare(frame, ([x, y]) => ({ x, y }), size).primitives).toHaveLength(2);
  });
});
