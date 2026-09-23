import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PointLayer } from "./point-layer";
import { FlowLayer } from "./flow-layer";
import { MapsOverlayLayers, type MapsOverlayLayersController } from "./maps-overlay-layers";
import type { CanvasMapScene } from "./canvas-map-renderer";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 600,
    bottom: 400,
    width: 600,
    height: 400,
    toJSON() {},
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const getViewport = () => null;
const unproject = () => null;
const surface = {
  handleFeatureClick() {},
  handleFeatureContextMenu() {},
  handleFeatureHover() {},
  isFeatureHovered: () => false,
  isFeatureSelected: () => false,
  setViewState() {},
};

describe("Native Map Layer retention regressions", () => {
  it.each([1000, 10000])(
    "retains point source preparation and projection across interaction changes (%i points)",
    (count) => {
      const points = Array.from({ length: count }, (_, i) => ({
        id: `p-${i}`,
        longitude: i / 100,
        latitude: 0,
      }));
      const color = vi.fn(() => "#2563eb");
      const filter = vi.fn(() => true);
      const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
      const frames: CanvasMapScene[] = [];
      const draw = (scene: CanvasMapScene) => {
        frames.push(scene);
        return true;
      };
      const ref = createRef<MapsOverlayLayersController>();
      const view = (hovered = false) => (
        <MapsOverlayLayers
          ref={ref}
          project={project}
          getViewport={getViewport}
          unproject={unproject}
          surface={hovered ? { ...surface, isFeatureHovered: () => true } : surface}
          renderApplicationFrame={draw}
        >
          <PointLayer points={points} getPointColor={color} filterPoint={filter} />
        </MapsOverlayLayers>
      );
      const mounted = render(view());
      project.mockClear();
      color.mockClear();
      filter.mockClear();
      const original = frames.at(-1)!.primitives[0]!.renderPrimitive;
      mounted.rerender(view(true));
      expect(color).toHaveBeenCalledTimes(0);
      expect(filter).toHaveBeenCalledTimes(0);
      expect(project).toHaveBeenCalledTimes(0);
      expect(original).toBe(frames.at(-1)!.primitives[0]!.renderPrimitive);
      project.mockClear();
      color.mockClear();
      filter.mockClear();
      act(() => ref.current!.redraw());
      expect(color).toHaveBeenCalledTimes(0);
      expect(filter).toHaveBeenCalledTimes(0);
    },
  );

  it.each(["arc", "s-curve"] as const)(
    "retains flow weighting and paths across interaction changes (%s)",
    (shape) => {
      const flows = Array.from({ length: 100 }, (_, i) => ({
        id: `f-${i}`,
        from: [i / 100, 0] as [number, number],
        to: [i / 100 + 1, 1] as [number, number],
      }));
      const weight = vi.fn(() => 1);
      const color = vi.fn(() => "#2563eb");
      const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
      const draw = () => true;
      const view = (hovered = false) => (
        <MapsOverlayLayers
          project={project}
          getViewport={getViewport}
          unproject={unproject}
          surface={hovered ? { ...surface, isFeatureHovered: () => true } : surface}
          renderApplicationFrame={draw}
        >
          <FlowLayer
            flows={flows}
            getWeight={weight}
            getFlowColor={color}
            flowShape={shape}
            showEndpoints={false}
          />
        </MapsOverlayLayers>
      );
      const mounted = render(view());
      weight.mockClear();
      color.mockClear();
      project.mockClear();
      mounted.rerender(view(true));
      expect(weight).toHaveBeenCalledTimes(0);
      expect(color).toHaveBeenCalledTimes(0);
      expect(project).not.toHaveBeenCalled();
    },
  );
});
