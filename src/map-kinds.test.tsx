import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BubbleMap,
  FlowMap,
  MapView,
  PointLayer,
  PointMap,
  createBubbleMapFeatures,
  createFlowMapFeatures,
  createPointMapFeatures,
  type MapFlow,
  type MapPoint,
} from ".";
import { getGlobeRadius, getGlobeZoom, GLOBE_MAX_ZOOM } from "./map-display";

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
    handlers = new Map<string, Handler[]>();
    removed = false;
    zoom = 5;

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

    fitBounds() {}

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

    off() {}

    on(event: string, handler: Handler) {
      const handlers = this.handlers.get(event) ?? [];

      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    remove() {
      this.removed = true;
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
    getLayerGroups: () => layerGroups,
    getMaps: () => maps,
    layerGroup: () => new MockLayerGroup(),
    map: () => new MockMap(),
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

describe("@moritzbrantner/maps additional map kinds", () => {
  test("creates point-map features from valid points", () => {
    const features = createPointMapFeatures([
      {
        id: "berlin",
        label: "Berlin",
        latitude: 52.52,
        longitude: 13.405,
      },
      {
        id: "invalid",
        latitude: Number.NaN,
        longitude: 0,
      },
    ]);

    expect(features).toMatchObject([
      {
        coordinates: [13.405, 52.52],
        point: {
          id: "berlin",
          label: "Berlin",
        },
      },
    ]);
  });

  test("creates scaled bubble-map features from metrics", () => {
    const points: MapPoint[] = [
      {
        id: "small",
        latitude: 10,
        longitude: 20,
        metrics: {
          demand: 25,
        },
      },
      {
        id: "large",
        latitude: 20,
        longitude: 40,
        metrics: {
          demand: 100,
        },
      },
    ];
    const features = createBubbleMapFeatures(points, {
      maxRadius: 30,
      minRadius: 6,
      weightMetric: "demand",
    });

    expect(features).toMatchObject([
      {
        rawValue: 25,
        value: 0.25,
      },
      {
        rawValue: 100,
        radius: 30,
        value: 1,
      },
    ]);
    expect(features[0]?.radius).toBe(18);
  });

  test("creates scaled flow-map features from metrics", () => {
    const flows: MapFlow[] = [
      {
        id: "berlin-paris",
        from: [13.405, 52.52],
        to: [2.3522, 48.8566],
        metrics: {
          trips: 16,
        },
      },
    ];

    expect(
      createFlowMapFeatures(flows, {
        maxWidth: 10,
        minWidth: 2,
        weightMetric: "trips",
      }),
    ).toMatchObject([
      {
        flow: {
          id: "berlin-paris",
        },
        rawValue: 16,
        value: 1,
        width: 10,
      },
    ]);
  });

  test("renders flat point markers with Leaflet", async () => {
    render(
      <PointMap
        mapLabel="Store points"
        pointColor="#dc2626"
        points={[
          {
            id: "store-1",
            latitude: 40,
            longitude: -74,
          },
        ]}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Store points").getAttribute("data-map-ready")).toBe("true");
    });

    expect(leafletMock.getLayerGroups()[0]?.layers).toMatchObject([
      {
        latLng: [40, -74],
        options: {
          className: "mb-maps__point-marker",
          fillColor: "#dc2626",
        },
        type: "circleMarker",
      },
    ]);
  });

  test("renders multiple flat layers of the same kind independently", async () => {
    const { rerender } = render(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        mapLabel="Composed layers"
        showAttributionControl={false}
      >
        <PointLayer
          layerId="stores"
          pointColor="#dc2626"
          points={[{ id: "store-1", latitude: 40, longitude: -74 }]}
        />
        <PointLayer
          layerId="warehouses"
          pointColor="#2563eb"
          points={[{ id: "warehouse-1", latitude: 42, longitude: -71 }]}
        />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Composed layers").getAttribute("data-map-ready")).toBe("true");
    });

    expect(leafletMock.getLayerGroups()[0]?.layers[0]).toMatchObject({
      options: {
        fillColor: "#dc2626",
      },
    });
    expect(leafletMock.getLayerGroups()[1]?.layers[0]).toMatchObject({
      options: {
        fillColor: "#2563eb",
      },
    });

    rerender(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        mapLabel="Composed layers"
        showAttributionControl={false}
      >
        <PointLayer
          layerId="stores"
          pointColor="#16a34a"
          points={[{ id: "store-1", latitude: 40, longitude: -74 }]}
        />
      </MapView>,
    );

    await waitFor(() => {
      const layers = leafletMock.getLayerGroups().flatMap((group) => group.layers);

      expect(layers).toEqual([
        expect.objectContaining({
          options: expect.objectContaining({
            fillColor: "#16a34a",
          }),
        }),
      ]);
    });
  });

  test("renders globe bubble markers without Leaflet", () => {
    render(
      <BubbleMap
        initialViewState={{ center: [-74, 40], zoom: 2 }}
        mapDisplay="globe"
        mapLabel="Demand bubbles"
        points={[
          {
            id: "a",
            latitude: 40,
            longitude: -74,
            metrics: {
              demand: 6,
            },
          },
        ]}
        weightMetric="demand"
      />,
    );

    const map = screen.getByLabelText("Demand bubbles");

    expect(map.getAttribute("data-map-ready")).toBe("true");
    expect(map.querySelector(".mb-maps__globe-renderer")).toBeTruthy();
    expect(map.querySelector(".mb-maps__globe-rim")).toBeTruthy();
    expect(map.querySelector(".mb-maps__globe-point")).toBeTruthy();
    expect(leafletMock.getMaps()).toHaveLength(0);
  });

  test("allows a closer globe zoom", () => {
    expect(getGlobeZoom(GLOBE_MAX_ZOOM - 0.1, -1000)).toBe(GLOBE_MAX_ZOOM);
    expect(getGlobeRadius(18) / getGlobeRadius(17)).toBeCloseTo(2, 5);
  });

  test("renders weighted flat flow lines with endpoints", async () => {
    render(
      <FlowMap
        flows={[
          {
            id: "nyc-boston",
            from: [-74, 40],
            to: [-71, 42],
            metrics: {
              trips: 9,
            },
          },
        ]}
        mapLabel="Route flows"
        showAttributionControl={false}
        weightMetric="trips"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Route flows").getAttribute("data-map-ready")).toBe("true");
    });

    const layers = leafletMock.getLayerGroups()[0]?.layers ?? [];

    expect(layers[0]).toMatchObject({
      latLngs: [
        [40, -74],
        [42, -71],
      ],
      options: {
        className: "mb-maps__flow-line",
      },
      type: "polyline",
    });
    expect(layers.filter((layer) => layer.type === "circleMarker")).toHaveLength(2);
  });
});
