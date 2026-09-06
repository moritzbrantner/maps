import { describe, expect, it, vi } from "vitest";

import {
  createCanvasPointClusterScene,
  drawCanvasPointClusterScene,
  hitTestCanvasPointClusterScene,
} from "./canvas-point-cluster-renderer";
import { createPointClusterRenderFrame } from "./point-cluster-render-frame";

describe("Canvas2D point/cluster renderer", () => {
  const frame = createPointClusterRenderFrame({
    features: [
      {
        clusterId: 4,
        coordinates: [10, 50],
        expansionZoom: 8,
        kind: "cluster" as const,
        metrics: { demand: 10 },
        pointCount: 30,
        pointCountAbbreviated: "30",
      },
      {
        coordinates: [12, 52],
        kind: "point" as const,
        metrics: { demand: 3 },
        point: {
          id: "berlin",
          label: "Berlin",
          latitude: 52,
          longitude: 12,
          metrics: { demand: 3 },
          properties: {},
        },
      },
    ],
    summary: {
      bounds: [5, 45, 15, 55],
      metrics: { demand: 13 },
      visibleClusterCount: 1,
      visiblePointCount: 31,
      visibleUnclusteredCount: 1,
      zoom: 5,
    },
  });

  it("projects the renderer-neutral frame without changing semantic identity", () => {
    const scene = createCanvasPointClusterScene(
      frame,
      ([longitude, latitude]) => ({ x: longitude * 10, y: latitude * 5 }),
      { height: 400, width: 800 },
    );

    expect(scene.width).toBe(800);
    expect(scene.height).toBe(400);
    expect(scene.features.map(({ renderFeature, x, y }) => [renderFeature.id, x, y])).toEqual([
      ["cluster:4", 100, 250],
      ["point:berlin", 120, 260],
    ]);
    expect(scene.features[0]?.renderFeature.feature).toBe(frame.features[0]?.feature);
  });

  it("hit tests deterministically in reverse paint order", () => {
    const scene = createCanvasPointClusterScene(frame, () => ({ x: 50, y: 50 }), {
      height: 100,
      width: 100,
    });

    expect(hitTestCanvasPointClusterScene(scene, { x: 50, y: 50 })?.renderFeature.id).toBe(
      "point:berlin",
    );
    expect(hitTestCanvasPointClusterScene(scene, { x: 99, y: 99 })).toBeNull();
  });

  it("draws only frame-provided pixels and labels", () => {
    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
      fillText: vi.fn(),
      font: "",
      globalAlpha: 1,
      lineWidth: 0,
      stroke: vi.fn(),
      strokeStyle: "",
      textAlign: "start",
      textBaseline: "alphabetic",
    } as unknown as CanvasRenderingContext2D;
    const scene = createCanvasPointClusterScene(
      frame,
      ([longitude, latitude]) => ({ x: longitude, y: latitude }),
      { height: 200, width: 300 },
    );

    drawCanvasPointClusterScene(context, scene, { selectedFeatureId: "cluster:4" });

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 300, 200);
    expect(context.arc).toHaveBeenCalledTimes(2);
    expect(context.fillText).toHaveBeenCalledWith("30", 10, 50);
    expect(context.stroke).toHaveBeenCalledTimes(2);
  });
});
