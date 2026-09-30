import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeoJsonLayer, type GeoJsonLayerProps } from "./geojson-layer";
import * as geometry from "./geojson-rendering";
import { MapsOverlayLayers, type MapsOverlayLayersController } from "./maps-overlay-layers";
import { PointLayer } from "./point-layer";
import type { CanvasMapScene } from "./canvas-map-renderer";
import type { MapScreenInteractionState } from "./map-screen-render-frame";

type Props = GeoJsonLayerProps<Record<string, unknown>>;
const size = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 600,
  bottom: 400,
  width: 600,
  height: 400,
  toJSON() {},
};
const getViewport = () => null;
const unproject = () => null;
function lineCollection(count = 1000): Props["featureCollection"] {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "road",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: Array.from({ length: count }, (_, index) => [100 + index / count, 40]),
        },
      },
    ],
  };
}
function createSurface() {
  return {
    handleFeatureClick: vi.fn(),
    handleFeatureContextMenu: vi.fn(),
    handleFeatureHover: vi.fn(),
    isFeatureHovered: vi.fn(() => false),
    isFeatureSelected: vi.fn(() => false),
    setViewState: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(size);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("retained Maps overlay geometry", () => {
  it.each([1000, 10000])(
    "does no projection, style or anchor work on hover/selection for %i coordinates",
    (count) => {
      const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
      const style = vi.fn(() => ({ lineWidth: 2 }));
      const anchor = vi.spyOn(geometry, "getGeometryCenter");
      const props: Props = { featureCollection: lineCollection(count), getFeatureStyle: style };
      const surface = createSurface();
      const frames: Array<{ scene: CanvasMapScene; interaction: MapScreenInteractionState }> = [];
      const draw = (scene: CanvasMapScene, interaction: MapScreenInteractionState) => {
        if (scene.primitives.length) frames.push({ scene, interaction });
        return true;
      };
      const view = (currentSurface = surface, currentProps = props) => (
        <MapsOverlayLayers
          project={project}
          getViewport={getViewport}
          unproject={unproject}
          surface={currentSurface}
          renderApplicationFrame={draw}
        >
          <GeoJsonLayer {...currentProps} />
        </MapsOverlayLayers>
      );
      const mounted = render(view());
      expect(project).toHaveBeenCalledTimes(count);
      expect(style).toHaveBeenCalledTimes(1);
      expect(anchor).toHaveBeenCalledTimes(1);
      const initial = frames.at(-1)!.scene.primitives[0];
      mounted.rerender(
        view(
          { ...surface, isFeatureHovered: vi.fn(() => true), isFeatureSelected: vi.fn(() => true) },
          { ...props, selectedFeatureId: "road", hoveredFeatureId: "road" },
        ),
      );
      expect(project).toHaveBeenCalledTimes(count);
      expect(style).toHaveBeenCalledTimes(1);
      expect(anchor).toHaveBeenCalledTimes(1);
      expect(frames.at(-1)!.scene.primitives[0]).toBe(initial);
      expect(frames.at(-1)!.interaction.hoveredPrimitiveIds?.size).toBe(1);
      expect(frames.at(-1)!.interaction.selectedPrimitiveIds?.size).toBe(1);
    },
  );

  it("invalidates projection for the camera, and preparation for style, identity, eligibility and data", () => {
    const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
    const movedProject = vi.fn(([x, y]: [number, number]) => ({ x: x + 10, y }));
    const style = vi.fn(() => ({ lineWidth: 2 }));
    const collection = lineCollection(10);
    const surface = createSurface();
    const frames: CanvasMapScene[] = [];
    const draw = (scene: CanvasMapScene) => {
      if (scene.primitives.length) frames.push(scene);
      return true;
    };
    const view = (props: Partial<Props> = {}, projection = project) => (
      <MapsOverlayLayers
        project={projection}
        getViewport={getViewport}
        unproject={unproject}
        surface={surface}
        renderApplicationFrame={draw}
      >
        <GeoJsonLayer featureCollection={collection} getFeatureStyle={style} {...props} />
      </MapsOverlayLayers>
    );
    const mounted = render(view());
    const initial = frames.at(-1)!.primitives[0]!.renderPrimitive;
    mounted.rerender(view({}, movedProject));
    expect(movedProject).toHaveBeenCalledTimes(10);
    expect(style).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)!.primitives[0]!.renderPrimitive).toBe(initial);
    const replacementStyle = vi.fn(() => ({ lineWidth: 7 }));
    mounted.rerender(view({ getFeatureStyle: replacementStyle, lineColor: "#123456" }));
    expect(replacementStyle).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)!.primitives[0]!.renderPrimitive).toMatchObject({
      strokeWidth: 7,
      strokeColor: "#123456",
    });
    mounted.rerender(view({ getFeatureId: () => "renamed", isFeatureInteractive: () => false }));
    expect(frames.at(-1)!.primitives[0]!.renderPrimitive).toMatchObject({
      featureId: "renamed",
      interactive: false,
    });
    const replacement = lineCollection(12);
    mounted.rerender(view({ featureCollection: replacement }));
    expect(project.mock.calls.length).toBe(42);
  });

  it("releases retained native point preparation when a layer is removed", () => {
    const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
    const surface = createSurface();
    const filterPoint = vi.fn(() => true);
    const points = [{ id: "native", longitude: 100, latitude: 40 }];
    const view = (visible: boolean) => (
      <MapsOverlayLayers
        project={project}
        getViewport={getViewport}
        unproject={unproject}
        surface={surface}
      >
        {visible && <PointLayer points={points} filterPoint={filterPoint} />}
      </MapsOverlayLayers>
    );

    const mounted = render(view(true));
    expect(filterPoint).toHaveBeenCalledOnce();
    mounted.rerender(view(false));
    filterPoint.mockClear();
    mounted.rerender(view(true));
    expect(filterPoint).toHaveBeenCalledOnce();
  });

  it("keeps click handlers current and releases removed layers", () => {
    const controller = createRef<MapsOverlayLayersController>();
    const project = vi.fn(([x, y]: [number, number]) => ({ x, y }));
    const props = { featureCollection: lineCollection(10) };
    const first = createSurface();
    const second = createSurface();
    const view = (surface = first, visible = true) => (
      <MapsOverlayLayers
        ref={controller}
        project={project}
        getViewport={getViewport}
        unproject={unproject}
        surface={surface}
      >
        {visible && <GeoJsonLayer {...props} />}
      </MapsOverlayLayers>
    );
    const mounted = render(view());
    act(() => {
      expect(controller.current?.handleClickAtClientPoint(100, 40)).toBe(true);
    });
    expect(first.handleFeatureClick).toHaveBeenCalledTimes(1);
    mounted.rerender(view(second));
    act(() => {
      controller.current?.handleClickAtClientPoint(100, 40);
    });
    expect(first.handleFeatureClick).toHaveBeenCalledTimes(1);
    expect(second.handleFeatureClick).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledTimes(10);
    mounted.rerender(view(second, false));
    expect(controller.current?.pickAtClientPoint(100, 40)).toBeNull();
    mounted.rerender(view(second));
    expect(project).toHaveBeenCalledTimes(20);
  });
});
