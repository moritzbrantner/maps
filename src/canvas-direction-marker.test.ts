import { describe, expect, it } from "vitest";

import { createCanvasMapScene, hitTestCanvasMapScene } from "./canvas-map-renderer";
import type { MapRenderDirectionMarker, MapVectorRenderFrame } from "./map-render-frame";

describe("Canvas direction marker", () => {
  it("derives screen rotation from projected path direction without becoming interaction authority", () => {
    const marker: MapRenderDirectionMarker = {
      anchor: [10, 0],
      color: "#0f766e",
      feature: { id: "flow-a" },
      featureId: "flow-a",
      interactive: false,
      kind: "direction-marker",
      opacity: 0.72,
      previous: [5, 0],
      primitiveId: "flow-a:direction",
      size: 12,
    };
    const frame: MapVectorRenderFrame = { kind: "vector", primitives: [marker] };

    const scene = createCanvasMapScene(frame, ([x, y]) => ({ x: x * 2, y: y * 3 }), {
      height: 100,
      width: 100,
    });

    expect(scene.primitives).toHaveLength(1);
    expect(scene.primitives[0]).toMatchObject({
      angle: 0,
      kind: "direction-marker",
      renderPrimitive: marker,
      x: 20,
      y: 0,
    });
    expect(hitTestCanvasMapScene(scene, { x: 20, y: 0 })).toBeNull();
  });
});
