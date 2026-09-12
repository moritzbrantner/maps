import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FlowLayer } from "./flow-layer";
import { MapView } from "./map-view";

vi.mock("./canvas-flat-runtime", async () => {
  const React = await import("react");

  type ViewState = {
    center: [number, number];
    zoom: number;
  };
  type Reason =
    | "cluster-expand"
    | "fit-bounds"
    | "fit-to-data"
    | "fly-to"
    | "pan"
    | "programmatic"
    | "zoom";
  type Controller = {
    fitBounds: (
      bounds: [number, number, number, number],
      options?: { maxZoom?: number; reason?: Reason },
    ) => void;
    project: (coordinates: [number, number]) => { x: number; y: number };
    setViewState: (viewState: ViewState, reason?: Reason) => void;
    unproject: (x: number, y: number) => [number, number];
  };
  type Props = {
    onControllerReady?: (controller: Controller | null) => void;
    onReady?: () => void;
    onViewStateChange: (viewState: ViewState, reason: Reason) => void;
  };

  function MockMapsCanvasFlatRuntime(props: Props) {
    React.useEffect(() => {
      const controller: Controller = {
        fitBounds(bounds, options = {}) {
          props.onViewStateChange(
            {
              center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
              zoom: Math.min(options.maxZoom ?? 5, 5),
            },
            options.reason ?? "fit-bounds",
          );
        },
        project(coordinates) {
          return {
            x: 400 + coordinates[0] * 10,
            y: 300 - coordinates[1] * 5,
          };
        },
        setViewState(next, reason = "programmatic") {
          props.onViewStateChange(next, reason);
        },
        unproject(x) {
          return x <= 0 ? [-180, -85] : [180, 85];
        },
      };

      props.onControllerReady?.(controller);
      props.onReady?.();
      return () => props.onControllerReady?.(null);
    }, []);

    return <canvas data-flat-runtime="maps" />;
  }

  return { MapsCanvasFlatRuntime: MockMapsCanvasFlatRuntime };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Maps-owned FlowLayer Canvas runtime", () => {
  test("renders flow geometry and preserves shared feature interaction semantics", async () => {
    const onFeatureSelect = vi.fn();
    const onHoveredFeatureIdChange = vi.fn();
    const onSelectedFeatureIdChange = vi.fn();
    const flows = [
      {
        from: [-10, 0] as [number, number],
        id: "route-a",
        metrics: { weight: 4 },
        to: [10, 0] as [number, number],
      },
    ];

    render(
      <MapView
        flatRuntime="maps"
        fitToData={false}
        initialViewState={{ center: [0, 0], zoom: 2 }}
        mapLabel="Flow Canvas Maps runtime"
        mapStyle={{ tiles: false }}
      >
        <FlowLayer
          flows={flows}
          getFeatureId={() => "stable-flow"}
          onFeatureSelect={onFeatureSelect}
          onHoveredFeatureIdChange={onHoveredFeatureIdChange}
          onSelectedFeatureIdChange={onSelectedFeatureIdChange}
          renderFeaturePopup={(feature) => <span>{`Popup ${feature.flow.id}`}</span>}
          renderFeatureTooltip={(feature) => <span>{`Tooltip ${feature.flow.id}`}</span>}
          showDirection
          showEndpoints
        />
      </MapView>,
    );

    const map = screen.getByLabelText("Flow Canvas Maps runtime");
    const baseCanvas = map.querySelector('canvas[data-flat-runtime="maps"]') as HTMLCanvasElement;

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
      const overlay = map.querySelector('canvas[data-map-overlay-runtime="maps"]');
      expect(overlay?.getAttribute("data-map-overlay-backend")).toBe("canvas2d");
      expect(overlay?.getAttribute("data-map-overlay-primitives")).toBe("4");
    });

    fireEvent.pointerMove(baseCanvas, {
      clientX: 400,
      clientY: 300,
      pointerId: 1,
      pointerType: "mouse",
    });

    await waitFor(() => {
      expect(onHoveredFeatureIdChange).toHaveBeenCalledWith(
        "stable-flow",
        expect.objectContaining({ featureId: "stable-flow", source: "hover" }),
      );
      expect(screen.getByText("Tooltip route-a")).toBeTruthy();
    });

    fireEvent.pointerDown(baseCanvas, {
      button: 0,
      clientX: 400,
      clientY: 300,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.click(baseCanvas, { button: 0, clientX: 400, clientY: 300 });

    await waitFor(() => {
      expect(onFeatureSelect).toHaveBeenCalledWith(
        expect.objectContaining({ flow: expect.objectContaining({ id: "route-a" }) }),
      );
      expect(onSelectedFeatureIdChange).toHaveBeenCalledWith(
        "stable-flow",
        expect.objectContaining({ featureId: "stable-flow", source: "click" }),
      );
      expect(screen.getByText("Popup route-a")).toBeTruthy();
    });

    expect(map.querySelector(".maplibregl-canvas")).toBeNull();
  });
});
