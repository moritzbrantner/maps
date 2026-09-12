import { describe, expect, it } from "vitest";

import { createCanvasMapScene, hitTestCanvasMapScene } from "./canvas-map-renderer";
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
