import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("Maps-owned ClusterLayer Canvas runtime", () => {
  test("uses viewport aggregation, shared picking, and cluster expansion without renderer authority", async () => {
    const onFeatureSelect = vi.fn();
    const onSelectedFeatureIdChange = vi.fn();
    const onViewStateChange = vi.fn();
    const onViewportAggregationChange = vi.fn();
    const points = [
      { id: "a", label: "A", latitude: 0, longitude: 0 },
      { id: "b", label: "B", latitude: 0.01, longitude: 0.01 },
      { id: "c", label: "C", latitude: 0, longitude: 0.02 },
    ];

    render(
      <MapView
        flatRuntime="maps"
        fitToData={false}
        initialViewState={{ center: [0, 0], zoom: 2 }}
        mapLabel="Cluster Canvas Maps runtime"
        mapStyle={{ tiles: false }}
        onViewStateChange={onViewStateChange}
      >
        <ClusterLayer
          getFeatureId={(feature) =>
            feature.kind === "cluster" ? "stable-cluster" : `stable-point:${feature.point.id}`
          }
          onFeatureSelect={onFeatureSelect}
          onSelectedFeatureIdChange={onSelectedFeatureIdChange}
          onViewportAggregationChange={onViewportAggregationChange}
          points={points}
        />
      </MapView>,
    );

    const map = screen.getByLabelText("Cluster Canvas Maps runtime");
    const baseCanvas = map.querySelector('canvas[data-flat-runtime="maps"]') as HTMLCanvasElement;

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
      expect(
        map
          .querySelector('canvas[data-map-overlay-runtime="maps"]')
          ?.getAttribute("data-map-overlay-primitives"),
      ).toBe("1");
      expect(onViewportAggregationChange).toHaveBeenCalledWith(
        expect.objectContaining({ visibleClusterCount: 1, visiblePointCount: 3, zoom: 2 }),
      );
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
        expect.objectContaining({ kind: "cluster", pointCount: 3 }),
      );
      expect(onSelectedFeatureIdChange).toHaveBeenCalledWith(
        "stable-cluster",
        expect.objectContaining({ featureId: "stable-cluster", source: "click" }),
      );
      expect(onViewStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ zoom: expect.any(Number) }),
        { display: "flat", reason: "cluster-expand" },
      );
    });

    const expanded = onViewStateChange.mock.calls.find(
      ([, context]) => context.reason === "cluster-expand",
    )?.[0];
    expect(expanded?.zoom).toBeGreaterThan(2);
    expect(map.querySelector(".maplibregl-canvas")).toBeNull();
  });
});
