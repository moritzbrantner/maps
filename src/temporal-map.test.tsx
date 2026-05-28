import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ClusteredMap,
  TemporalClusteredMap,
  TemporalHeatMap,
  type MapSurfaceController,
  type TemporalMapTrack,
} from ".";

const leafletMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    latLng?: [number, number];
    latLngs?: unknown;
    options?: Record<string, unknown>;
    type: string;
  };

  const maps: MockMap[] = [];
  const layerGroups: MockLayerGroup[] = [];

  class MockLayerGroup {
    layers: Layer[] = [];

    constructor() {
      layerGroups.push(this);
    }

    addLayer(layer: Layer) {
      this.layers.push(layer);
    }

    addTo() {
      return this;
    }

    clearLayers() {
      this.layers = [];
    }
  }

  class MockMap {
    fitBoundsCalls = 0;
    handlers = new Map<string, Handler[]>();
    removed = false;
    zoom = 6;

    constructor() {
      maps.push(this);
    }

    container = {
      clientHeight: 640,
      clientWidth: 960,
      style: {
        cursor: "",
      },
    };

    containerPointToLatLng([x, y]: [number, number]) {
      return {
        lat: 90 - y / 2,
        lng: x / 2 - 180,
      };
    }

    fitBounds() {
      this.fitBoundsCalls += 1;
    }

    getBounds() {
      return {
        getEast: () => 180,
        getNorth: () => 90,
        getSouth: () => -90,
        getWest: () => -180,
      };
    }

    getContainer() {
      return this.container;
    }

    getZoom() {
      return this.zoom;
    }

    latLngToContainerPoint([lat, lng]: [number, number]) {
      return {
        x: (lng + 180) * 2,
        y: (90 - lat) * 2,
      };
    }

    off() {}

    on(event: string, handler: Handler) {
      const handlers = this.handlers.get(event) ?? [];

      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    remove() {
      this.removed = true;
    }

    setView(_latLng: [number, number], zoom: number) {
      this.zoom = zoom;
    }
  }

  function createLayer(
    type: string,
    latLng?: [number, number],
    options?: Record<string, unknown>,
    latLngs?: unknown,
  ) {
    const layer: Layer & {
      addTo: (group: MockLayerGroup) => typeof layer;
      on: () => typeof layer;
    } = {
      latLng,
      latLngs,
      options,
      type,
      addTo(group: MockLayerGroup) {
        group.addLayer(this);
        return this;
      },
      on() {
        return this;
      },
    };

    return layer;
  }

  return {
    circleMarker: (latLng: [number, number], options: Record<string, unknown>) =>
      createLayer("circleMarker", latLng, options),
    divIcon: (options: Record<string, unknown>) => options,
    getLayerGroups: () => layerGroups,
    getMaps: () => maps,
    getFitBoundsCallCount: () =>
      maps.reduce((total, map) => total + map.fitBoundsCalls, 0),
    imageOverlay: (_url: string, latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("imageOverlay", undefined, options, latLngs),
    layerGroup: () => new MockLayerGroup(),
    map: () => new MockMap(),
    marker: (latLng: [number, number], options: Record<string, unknown>) =>
      createLayer("marker", latLng, options),
    polygon: (latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("polygon", undefined, options, latLngs),
    polyline: (latLngs: unknown, options: Record<string, unknown>) =>
      createLayer("polyline", undefined, options, latLngs),
    reset: () => {
      maps.length = 0;
      layerGroups.length = 0;
    },
    tileLayer: () => ({
      addTo() {
        return this;
      },
    }),
  };
});

vi.mock("leaflet", () => leafletMock);

afterEach(() => {
  leafletMock.reset();
});

function getRenderedLayersByType(type: string) {
  return leafletMock
    .getLayerGroups()
    .flatMap((group) => group.layers)
    .filter((layer) => layer.type === type);
}

function getRenderedGeoJsonLayersByType(type: string) {
  return getRenderedLayersByType(type).filter(
    (layer) => layer.options?.className === "mb-maps__geojson-feature",
  );
}

describe("@moritzbrantner/maps TemporalClusteredMap", () => {
  test("renders clustered points on the globe display", () => {
    render(
      <ClusteredMap
        initialViewState={{ center: [13, 52], zoom: 2 }}
        mapDisplay="globe"
        mapLabel="Warehouse globe"
        points={[
          {
            id: "berlin",
            label: "Berlin",
            latitude: 52,
            longitude: 13,
          },
        ]}
      />,
    );

    const map = screen.getByLabelText("Warehouse globe");

    expect(map.getAttribute("data-map-ready")).toBe("true");
    expect(map.querySelector(".mb-maps__globe")).toBeTruthy();
    expect(map.querySelector(".mb-maps__globe-point")).toBeTruthy();
    expect(leafletMock.getMaps()).toHaveLength(0);
  });

  test("renders timeline controls and slices track points into the map overlay", async () => {
    const tracks: TemporalMapTrack<{ status: string }>[] = [
      {
        id: "courier-1",
        label: "Courier 1",
        frames: [
          {
            latitude: 10,
            longitude: 20,
            metrics: {
              load: 2,
            },
            properties: {
              status: "dispatching",
            },
            time: 0,
          },
          {
            latitude: 20,
            longitude: 40,
            metrics: {
              load: 6,
            },
            properties: {
              status: "en-route",
            },
            time: 10,
          },
        ],
      },
    ];

    render(
      <TemporalClusteredMap
        defaultTime={5}
        formatTimeLabel={(time) => `T${time}`}
        mapLabel="Courier timeline"
        showAttributionControl={false}
        timeStep={5}
        tracks={tracks}
      />,
    );

    expect(screen.getByLabelText("Courier timeline").getAttribute("data-map-ready")).toBe("false");
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText("T5")).toBeTruthy();
    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("5");

    await waitFor(() => {
      expect(screen.getByLabelText("Courier timeline").getAttribute("data-map-ready")).toBe("true");
    });

    const pointMarker = leafletMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__point-marker");

    expect(pointMarker).toMatchObject({
      latLng: [15, 30],
      type: "circleMarker",
    });
  });

  test("keeps a fixed viewport during timeline seeking when fit to data is disabled", async () => {
    const onViewStateChange = vi.fn();
    let controller: MapSurfaceController | null = null;
    const tracks: TemporalMapTrack[] = [
      {
        id: "courier-viewport",
        label: "Courier viewport",
        frames: [
          {
            latitude: 51,
            longitude: -0.1,
            time: 0,
          },
          {
            latitude: 60,
            longitude: 24,
            time: 120,
          },
        ],
      },
    ];

    render(
      <TemporalClusteredMap
        defaultTime={0}
        fitToData={false}
        initialViewState={{ center: [8.8, 51], zoom: 4.2 }}
        mapLabel="Stable timeline"
        onMapControllerReady={(nextController) => {
          controller = nextController;
        }}
        onViewStateChange={onViewStateChange}
        showAttributionControl={false}
        timeStep={1}
        tracks={tracks}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Stable timeline").getAttribute("data-map-ready")).toBe("true");
    });
    await waitFor(() => {
      expect(controller).not.toBeNull();
    });

    expect(leafletMock.getFitBoundsCallCount()).toBe(0);

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "70",
      },
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe(
      "70",
    );
    await waitFor(() => {
      const pointMarker = leafletMock
        .getLayerGroups()[0]
        ?.layers.find((layer) => layer.options?.className === "mb-maps__point-marker");

      expect(pointMarker?.latLng?.[0]).toBeCloseTo(56.25, 6);
      expect(pointMarker?.latLng?.[1]).toBeCloseTo(13.958333, 6);
    });
    expect(leafletMock.getFitBoundsCallCount()).toBe(0);

    act(() => {
      controller!.setViewState({ center: [9, 52], zoom: 5 }, "programmatic");
    });

    expect(onViewStateChange).toHaveBeenLastCalledWith(
      { center: [9, 52], zoom: 5 },
      { display: "flat", reason: "programmatic" },
    );
  });

  test("derives temporal points from GeoJSON and renders synchronized geometry overlays", async () => {
    render(
      <TemporalClusteredMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [20, 10],
                type: "Point",
              },
              id: "courier-geojson",
              properties: {
                time: 0,
                trackId: "courier-geojson",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [18, 8],
                    [22, 8],
                    [22, 12],
                    [18, 8],
                  ],
                ],
                type: "Polygon",
              },
              id: "service-zone",
              properties: {
                time: 0,
                trackId: "service-zone",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        mapLabel="GeoJSON timeline"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("GeoJSON timeline").getAttribute("data-map-ready")).toBe("true");
    });

    expect(
      leafletMock
        .getLayerGroups()
        .flatMap((group) => group.layers)
        .map((layer) => layer.type),
    ).toEqual(expect.arrayContaining(["polygon", "circleMarker"]));
  });

  test("extends clustered playback range with temporal GeoJSON overlay frames", async () => {
    render(
      <TemporalClusteredMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [20, 20],
                  [30, 30],
                ],
                type: "LineString",
              },
              properties: {
                time: 20,
                trackId: "late-corridor",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [25, 25],
                  [35, 35],
                ],
                type: "LineString",
              },
              properties: {
                time: 30,
                trackId: "late-corridor",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
        tracks={[
          {
            id: "courier-short",
            frames: [
              { latitude: 0, longitude: 0, time: 0 },
              { latitude: 10, longitude: 10, time: 10 },
            ],
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).max).toBe("30");
  });

  test("plays temporal GeoJSON overlays without point tracks", async () => {
    render(
      <TemporalClusteredMap
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [
                    [0, 0],
                    [4, 0],
                    [4, 4],
                    [0, 4],
                    [0, 0],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 20,
                trackId: "overlay-only",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [2, 2],
                    [6, 2],
                    [6, 6],
                    [2, 6],
                    [2, 2],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 30,
                trackId: "overlay-only",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const slider = screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement;

    expect(slider.min).toBe("20");
    expect(slider.max).toBe("30");
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(getRenderedGeoJsonLayersByType("polygon")).toHaveLength(1);
  });

  test("hides, interpolates, and removes temporal GeoJSON overlays while seeking", async () => {
    render(
      <TemporalClusteredMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [
                    [0, 0],
                    [4, 0],
                    [4, 4],
                    [0, 4],
                    [0, 0],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 20,
                trackId: "changing-zone",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [10, 10],
                    [14, 10],
                    [14, 14],
                    [10, 14],
                    [10, 10],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 30,
                trackId: "changing-zone",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [10, 10],
                    [14, 10],
                    [14, 14],
                    [10, 14],
                    [10, 10],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 40,
                trackId: "changing-zone",
                visible: false,
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
        tracks={[
          {
            id: "courier-window",
            frames: [
              { latitude: 0, longitude: 0, time: 0 },
              { latitude: 10, longitude: 10, time: 40 },
            ],
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    expect(getRenderedGeoJsonLayersByType("polygon")).toHaveLength(0);

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "25",
      },
    });

    await waitFor(() => {
      const interpolatedRing = getRenderedGeoJsonLayersByType("polygon")[0]?.latLngs as
        | Array<Array<[number, number]>>
        | undefined;

      expect(interpolatedRing?.[0]?.[0]).toEqual([5, 5]);
      expect(interpolatedRing?.[0]?.[1]).toEqual([5, 9]);
    });

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "40",
      },
    });

    await waitFor(() => {
      expect(getRenderedGeoJsonLayersByType("polygon")).toHaveLength(0);
    });
  });

  test("extends heat map playback range with temporal GeoJSON overlay frames", async () => {
    render(
      <TemporalHeatMap
        defaultTime={0}
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [
                    [20, 20],
                    [30, 20],
                    [30, 30],
                    [20, 30],
                    [20, 20],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 20,
                trackId: "heat-zone",
              },
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [25, 25],
                    [35, 25],
                    [35, 35],
                    [25, 35],
                    [25, 25],
                  ],
                ],
                type: "Polygon",
              },
              properties: {
                time: 30,
                trackId: "heat-zone",
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        showAttributionControl={false}
        tracks={[
          {
            id: "heat-point-short",
            frames: [
              { latitude: 0, longitude: 0, time: 0 },
              { latitude: 10, longitude: 10, time: 10 },
            ],
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Interactive temporal heat map").getAttribute("data-map-ready"),
      ).toBe("true");
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).max).toBe("30");
  });

  test("snaps slider changes and reports the active time", async () => {
    const onTimeChange = vi.fn();
    const tracks: TemporalMapTrack[] = [
      {
        id: "courier-2",
        frames: [
          {
            latitude: 0,
            longitude: 0,
            time: 0,
          },
          {
            latitude: 10,
            longitude: 10,
            time: 20,
          },
        ],
      },
    ];

    render(
      <TemporalClusteredMap
        defaultTime={0}
        formatTimeLabel={(time) => `Minute ${time}`}
        onTimeChange={onTimeChange}
        timeStep={10}
        tracks={tracks}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive timeline map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), {
      target: {
        value: "17",
      },
    });

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("10");
    expect(screen.getByText("Minute 10")).toBeTruthy();
    await waitFor(() => {
      expect(onTimeChange).toHaveBeenLastCalledWith(10);
    });

    fireEvent.click(screen.getByRole("button", { name: "Next time step" }));

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("20");
    expect(screen.getAllByText("Minute 20").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(onTimeChange).toHaveBeenLastCalledWith(20);
    });

    fireEvent.click(screen.getByRole("button", { name: "Jump to start" }));

    expect((screen.getByRole("slider", { name: "Timeline" }) as HTMLInputElement).value).toBe("0");
    expect(screen.getAllByText("Minute 0").length).toBeGreaterThan(0);
  });
});
