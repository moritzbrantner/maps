import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ClusterLayer } from "./cluster-layer";
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
    | "programmatic"
    | "pan"
    | "zoom";
  type Controller = {
    fitBounds: (bounds: [number, number, number, number]) => void;
    getViewportAggregationQuery: () => {
      bounds: [number, number, number, number];
      zoom: number;
    };
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
        fitBounds() {},
        getViewportAggregationQuery() {
          return { bounds: [-180, -85, 180, 85], zoom: 2 };
        },
        project([longitude, latitude]) {
          return { x: 400 + longitude * 10, y: 300 - latitude * 5 };
        },
        setViewState(next, reason = "programmatic") {
          props.onViewStateChange(next, reason);
        },
        unproject(x, y) {
          return [(x - 400) / 10, (300 - y) / 5];
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

describe("Maps-owned ClusterLayer", () => {
  test("keeps the aggregation index live through Strict Mode and expands clusters through map state", async () => {
    const onSelectedFeatureIdChange = vi.fn();
    const onViewportAggregationChange = vi.fn();
    const onViewStateChange = vi.fn();

    render(
      <StrictMode>
        <MapView
          flatRuntime="maps"
          fitToData={false}
          initialViewState={{ center: [13.405, 52.52], zoom: 2 }}
          mapLabel="Cluster Maps runtime"
          mapStyle={{ tiles: false }}
          onViewStateChange={onViewStateChange}
        >
          <ClusterLayer
            getFeatureId={(feature) =>
              feature.kind === "cluster" ? "cluster-live" : feature.point.id
            }
            onSelectedFeatureIdChange={onSelectedFeatureIdChange}
            onViewportAggregationChange={onViewportAggregationChange}
            points={[
              { id: "berlin-a", latitude: 52.52, longitude: 13.405 },
              { id: "berlin-b", latitude: 52.521, longitude: 13.407 },
              { id: "berlin-c", latitude: 52.519, longitude: 13.403 },
            ]}
            renderFeaturePopup={(feature) => (
              <span>Cluster popup {feature.kind === "cluster" ? feature.pointCount : 1}</span>
            )}
            renderFeatureTooltip={(feature) => (
              <span>Cluster tooltip {feature.kind === "cluster" ? feature.pointCount : 1}</span>
            )}
          />
        </MapView>
      </StrictMode>,
    );

    const map = screen.getByLabelText("Cluster Maps runtime");
    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
      expect(
        map.querySelector('canvas[data-map-overlay-runtime="maps"]')?.getAttribute(
          "data-map-overlay-primitives",
        ),
      ).toBe("1");
      expect(onViewportAggregationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          visibleClusterCount: 1,
          visiblePointCount: 3,
          visibleUnclusteredCount: 0,
          zoom: 2,
        }),
      );
    });

    const canvas = map.querySelector('canvas[data-flat-runtime="maps"]') as HTMLCanvasElement;
    fireEvent.pointerMove(canvas, {
      clientX: 534.05,
      clientY: 37.4,
      pointerId: 1,
      pointerType: "mouse",
    });
    await waitFor(() => {
      expect(screen.getByText("Cluster tooltip 3")).toBeTruthy();
    });

    clickSurface(canvas, 534.05, 37.4);
    await waitFor(() => {
      expect(onSelectedFeatureIdChange).toHaveBeenCalledWith(
        "cluster-live",
        expect.objectContaining({ featureId: "cluster-live", source: "click" }),
      );
      expect(screen.getByText("Cluster popup 3")).toBeTruthy();
      expect(onViewStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ center: expect.any(Array), zoom: expect.any(Number) }),
        expect.objectContaining({ display: "flat", reason: "cluster-expand" }),
      );
    });
  });
});

function clickSurface(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  fireEvent.pointerDown(canvas, {
    button: 0,
    clientX,
    clientY,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.click(canvas, { button: 0, clientX, clientY });
}
