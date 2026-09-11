import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { GeoJsonLayer } from "./geojson-layer";
import { MapControls } from "./map-components";
import type { MapSurfaceController } from "./map-display";
import { MapView } from "./map-view";
import { PointLayer } from "./point-layer";

vi.mock("./canvas-flat-runtime", async () => {
  const React = await import("react");

  type ViewState = {
    center: [number, number];
    zoom: number;
  };
  type Reason = "fit-bounds" | "fit-to-data" | "fly-to" | "programmatic" | "pan" | "zoom";
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
    onContextMenu?: (context: {
      coordinates: [number, number];
      position: { x: number; y: number };
    }) => void;
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
        unproject() {
          return [8, 50];
        },
      };

      props.onControllerReady?.(controller);
      props.onReady?.();

      return () => {
        props.onControllerReady?.(null);
      };
    }, []);

    return (
      <canvas
        data-flat-runtime="maps"
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu?.({
            coordinates: [8, 50],
            position: { x: 120, y: 80 },
          });
        }}
      />
    );
  }

  return {
    MapsCanvasFlatRuntime: MockMapsCanvasFlatRuntime,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Maps-owned MapView runtime", () => {
  test("mounts the Maps runtime and routes controller view-state changes", async () => {
    let controller: MapSurfaceController | null = null;
    const onViewStateChange = vi.fn();

    render(
      <MapView
        flatRuntime="maps"
        fitToData={false}
        initialViewState={{ center: [13.405, 52.52], zoom: 6 }}
        mapLabel="Maps runtime"
        mapStyle={{ tiles: false }}
        onMapControllerReady={(nextController) => {
          controller = nextController;
        }}
        onViewStateChange={onViewStateChange}
      >
        <MapControls aria-label="Runtime controls">Controls</MapControls>
      </MapView>,
    );

    const map = screen.getByLabelText("Maps runtime");

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
      expect(controller).toBeTruthy();
    });

    expect(map.getAttribute("data-map-runtime")).toBe("maps");
    expect(map.querySelector('[data-flat-runtime="maps"]')).toBeTruthy();
    expect(screen.getByLabelText("Runtime controls")).toBeTruthy();

    act(() => {
      controller?.setViewState({ center: [2, 3], zoom: 4 }, "programmatic");
    });

    await waitFor(() => {
      expect(onViewStateChange).toHaveBeenCalledWith(
        { center: [2, 3], zoom: 4 },
        { display: "flat", reason: "programmatic" },
      );
    });

    act(() => {
      controller?.fitBounds([-10, 40, 10, 50], { maxZoom: 7 });
    });

    await waitFor(() => {
      expect(onViewStateChange).toHaveBeenCalledWith(
        { center: [0, 45], zoom: 5 },
        { display: "flat", reason: "fit-bounds" },
      );
    });
  });

  test("fits data through the Rust-runtime controller after readiness", async () => {
    const onViewStateChange = vi.fn();

    render(
      <MapView
        dataBounds={[-10, 40, 10, 50]}
        flatRuntime="maps"
        mapLabel="Fit-to-data Maps runtime"
        mapStyle={{ tiles: false }}
        onViewStateChange={onViewStateChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Fit-to-data Maps runtime").getAttribute("data-map-ready")).toBe(
        "true",
      );
      expect(onViewStateChange).toHaveBeenCalledWith(
        { center: [0, 45], zoom: 5 },
        { display: "flat", reason: "fit-to-data" },
      );
    });
  });

  test("renders PointLayer through Rust-owned screen projection", async () => {
    render(
      <MapView
        flatRuntime="maps"
        fitToData={false}
        mapLabel="Point overlay Maps runtime"
        mapStyle={{ tiles: false }}
      >
        <PointLayer
          hoveredFeatureId="berlin"
          points={[{ id: "berlin", latitude: 52.52, longitude: 13.405 }]}
          pointColor="#dc2626"
          pointRadius={8}
        />
      </MapView>,
    );

    const map = screen.getByLabelText("Point overlay Maps runtime");

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
      expect(map.querySelector('[data-map-overlay-runtime="maps"]')).toBeTruthy();
    });

    const point = map.querySelector('[data-map-feature-id="berlin"]');
    expect(Number(point?.getAttribute("cx"))).toBeCloseTo(534.05, 10);
    expect(Number(point?.getAttribute("cy"))).toBeCloseTo(37.4, 10);
    expect(point?.getAttribute("fill")).toBe("#dc2626");
    expect(point?.getAttribute("r")).toBe("8");
    expect(point?.getAttribute("class")).toContain("mb-maps__feature--hovered");
  });

  test("renders GeoJsonLayer points, lines, and polygons through Rust projection", async () => {
    render(
      <MapView
        flatRuntime="maps"
        fitToData={false}
        mapLabel="GeoJSON overlay Maps runtime"
        mapStyle={{ tiles: false }}
      >
        <GeoJsonLayer
          featureCollection={{
            features: [
              {
                geometry: { coordinates: [1, 2], type: "Point" },
                id: "point-a",
                properties: {},
                type: "Feature",
              },
              {
                geometry: {
                  coordinates: [
                    [1, 2],
                    [3, 4],
                  ],
                  type: "LineString",
                },
                id: "line-a",
                properties: {},
                type: "Feature",
              },
              {
                geometry: {
                  coordinates: [
                    [
                      [0, 0],
                      [2, 0],
                      [2, 2],
                      [0, 0],
                    ],
                  ],
                  type: "Polygon",
                },
                id: "polygon-a",
                properties: {},
                type: "Feature",
              },
            ],
            type: "FeatureCollection",
          }}
          selectedFeatureId="polygon-a"
        />
      </MapView>,
    );

    const map = screen.getByLabelText("GeoJSON overlay Maps runtime");

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
      expect(map.querySelector('[data-map-feature-id="point-a"]')).toBeTruthy();
    });

    expect(map.querySelector('[data-map-feature-id="line-a"]')?.getAttribute("d")).toBe(
      "M 410 290 L 430 280",
    );
    const polygon = map.querySelector('[data-map-feature-id="polygon-a"]');
    expect(polygon?.getAttribute("d")).toBe("M 400 300 L 420 300 L 420 290 L 400 300 Z");
    expect(polygon?.getAttribute("class")).toContain("mb-maps__feature--selected");
  });

  test("routes map context menus through the shared MapView contract", async () => {
    const onMapContextMenu = vi.fn();

    render(
      <MapView
        flatRuntime="maps"
        fitToData={false}
        mapLabel="Context Maps runtime"
        mapStyle={{ tiles: false }}
        onMapContextMenu={onMapContextMenu}
        renderMapContextMenu={(context) => (
          <button type="button">
            Create {context.coordinates[0]}, {context.coordinates[1]}
          </button>
        )}
      />,
    );

    const map = screen.getByLabelText("Context Maps runtime");

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
    });

    fireEvent.contextMenu(map.querySelector('[data-flat-runtime="maps"]')!);

    expect(onMapContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinates: [8, 50],
      }),
    );
    expect(screen.getByText("Create 8, 50")).toBeTruthy();
  });

  test("fails closed for unsupported layer types, interactions, and style URLs", () => {
    expect(() =>
      render(
        <MapView
          flatRuntime="maps"
          fitToData={false}
          mapLabel="Unsupported Maps layer"
          mapStyle={{ tiles: false }}
        >
          <div>Map layer</div>
        </MapView>,
      ),
    ).toThrow(/supports PointLayer and GeoJsonLayer only/);

    expect(() =>
      render(
        <MapView
          flatRuntime="maps"
          fitToData={false}
          mapLabel="Unsupported interactive point"
          mapStyle={{ tiles: false }}
        >
          <PointLayer
            onFeatureSelect={() => undefined}
            points={[{ id: "berlin", latitude: 52.52, longitude: 13.405 }]}
          />
        </MapView>,
      ),
    ).toThrow(/point overlays are display-only/);

    expect(() =>
      render(
        <MapView
          flatRuntime="maps"
          fitToData={false}
          mapLabel="Unsupported style URL"
          mapStyle="https://styles.example.test/style.json"
        />,
      ),
    ).toThrow(/requires an explicit raster tile style/);
  });

  test("fails closed for MapLibre-specific readiness and maxBounds contracts", () => {
    expect(() =>
      render(
        <MapView
          flatRuntime="maps"
          fitToData={false}
          mapLabel="Unsupported max bounds"
          mapStyle={{ tiles: false }}
          maxBounds={[-25, 34, 35, 66]}
        />,
      ),
    ).toThrow(/does not support maxBounds yet/);

    expect(() =>
      render(
        <MapView
          flatRuntime="maps"
          fitToData={false}
          mapLabel="Unsupported MapLibre ready callback"
          mapStyle={{ tiles: false }}
          onMapReady={() => undefined}
        />,
      ),
    ).toThrow(/onMapReady is MapLibre-specific/);
  });
});
