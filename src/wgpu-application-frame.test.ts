import { describe, expect, test } from "vitest";

import type {
  MapRenderCircle,
  MapRenderDirectionMarker,
  MapRenderLine,
  MapRenderPolygon,
} from "./map-render-frame";
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
      directionMarkers: [],
      height: 480,
      lines: [],
      width: 640,
    });
  });

  test("packs circles, lines, and flow direction markers into one GPU frame", () => {
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
      createMapsWgpuApplicationFrame(frame, {
        hoveredPrimitiveIds: new Set(["line-a"]),
      }),
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
      width: 640,
    });
  });

  test("fails closed for polygons until even-odd GPU filling is supported", () => {
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
          [1, 0],
          [1, 1],
          [0, 1],
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
              { x: 20, y: 10 },
              { x: 20, y: 20 },
              { x: 10, y: 20 },
            ],
          ],
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
