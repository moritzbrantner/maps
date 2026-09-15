import { describe, expect, test } from "vitest";

import type { MapRenderCircle, MapRenderLine } from "./map-render-frame";
import type { MapScreenRenderFrame } from "./map-screen-render-frame";
import { createMapsWgpuApplicationFrame } from "./wgpu-application-frame";

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
      createMapsWgpuApplicationFrame(frame, {
        selectedPrimitiveIds: new Set(["circle-a"]),
      }),
    ).toEqual({
      circles: [
        {
          fillColor: [
            0.033104766570885055,
            0.13286832155381798,
            0.31854677812509186,
            0.5,
          ],
          radius: 7,
          strokeColor: [1, 1, 1, 0.6000000000000001],
          strokeWidth: 3.5,
          x: 120,
          y: 80,
        },
      ],
      height: 480,
      width: 640,
    });
  });

  test("fails closed for mixed primitive kinds", () => {
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
      strokeWidth: 2,
    };
    const frame: MapScreenRenderFrame = {
      height: 480,
      primitives: [
        {
          kind: "line",
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 20 },
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
});
