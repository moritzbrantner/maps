import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  HeatMap,
  TemporalHeatMap,
  createHeatMapDensityIndex,
  createHeatMapFeatureCollection,
  getTemporalHeatMapMaxWeight,
  type MapPoint,
  type TemporalMapTrack,
} from ".";

const leafletMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    latLng?: [number, number];
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
    zoom = 2;

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
        getNorth: () => 85,
        getSouth: () => -85,
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

  function createLayer(type: string, latLng?: [number, number], options?: Record<string, unknown>) {
    const layer: Layer & {
      addTo: (group: MockLayerGroup) => typeof layer;
    } = {
      latLng,
      options,
      type,
      addTo(group: MockLayerGroup) {
        group.addLayer(this);
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

describe("@moritzbrantner/maps heat maps", () => {
  test("creates weighted heat-map features from metrics", () => {
    const points: MapPoint<{ city: string }>[] = [
      {
        id: "a",
        label: "A",
        latitude: 52.52,
        longitude: 13.405,
        metrics: {
          demand: 4,
        },
        properties: {
          city: "Berlin",
        },
      },
      {
        id: "b",
        label: "B",
        latitude: 48.8566,
        longitude: 2.3522,
        metrics: {
          demand: 12,
        },
        properties: {
          city: "Paris",
        },
      },
      {
        id: "invalid",
        latitude: Number.NaN,
        longitude: 0,
        metrics: {
          demand: 20,
        },
        properties: {
          city: "Invalid",
        },
      },
      {
        id: "missing-demand",
        latitude: 50,
        longitude: 8,
        properties: {
          city: "Frankfurt",
        },
      },
    ];

    const data = createHeatMapFeatureCollection(points, {
      weightMetric: "demand",
    });

    expect(data).toMatchObject({
      features: [
        {
          geometry: {
            coordinates: [13.405, 52.52],
          },
          properties: {
            demand: 4,
            pointId: "a",
            rawWeight: 4,
            weight: 4 / 12,
          },
        },
        {
          geometry: {
            coordinates: [2.3522, 48.8566],
          },
          properties: {
            demand: 12,
            pointId: "b",
            rawWeight: 12,
            weight: 1,
          },
        },
      ],
      type: "FeatureCollection",
    });
  });

  test("keeps the normalized weight property separate from raw weight metrics", () => {
    const data = createHeatMapFeatureCollection([
      {
        id: "a",
        latitude: 52,
        longitude: 13,
        metrics: {
          weight: 8,
        },
      },
      {
        id: "b",
        latitude: 48,
        longitude: 2,
        metrics: {
          weight: 2,
        },
      },
    ]);

    expect(data.features.map((feature) => feature.properties)).toMatchObject([
      {
        pointId: "a",
        rawWeight: 8,
        weight: 1,
      },
      {
        pointId: "b",
        rawWeight: 2,
        weight: 0.25,
      },
    ]);
  });

  test("aggregates dense heat-map points into weighted viewport features", () => {
    const points = Array.from({ length: 24 }, (_, index) => ({
      id: `berlin-${index}`,
      label: `Berlin ${index}`,
      latitude: 52.52 + index * 0.0001,
      longitude: 13.405 + index * 0.0001,
      metrics: {
        demand: 2,
      },
    }));
    const index = createHeatMapDensityIndex(points, {
      radius: 128,
      weightMetric: "demand",
    });
    const data = index.getFeatureCollection({
      bounds: [13.3, 52.4, 13.6, 52.7],
      zoom: 3,
    });

    expect(index.pointCount).toBe(24);
    expect(index.maxWeight).toBe(2);
    expect(data.features).toHaveLength(1);
    expect(data.features[0]?.properties).toMatchObject({
      demand: 48,
      kind: "heat-cluster",
      pointCount: 24,
      rawWeight: 48,
      weight: 24,
    });
    expect(data.features[0]?.properties).not.toHaveProperty("__moritzbrantnerHeatMapWeight");
  });

  test("renders weighted Leaflet heat markers", async () => {
    render(
      <HeatMap
        heatmapIntensity={1.4}
        heatmapMaxZoom={12}
        mapLabel="Demand heat map"
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
        showAttributionControl={false}
        weightMetric="demand"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Demand heat map").getAttribute("data-map-ready")).toBe("true");
    });

    const marker = leafletMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__heat-marker");

    expect(marker).toMatchObject({
      latLng: [40, -74],
      options: {
        fillOpacity: 0.84,
      },
      type: "circleMarker",
    });
    expect(marker?.options?.radius).toBeGreaterThan(0);
  });

  test("slices temporal tracks into weighted heat-map frames", async () => {
    const tracks: TemporalMapTrack<{ route: string }>[] = [
      {
        id: "courier-1",
        frames: [
          {
            latitude: 10,
            longitude: 20,
            metrics: {
              demand: 4,
            },
            properties: {
              route: "West",
            },
            time: 0,
          },
          {
            latitude: 20,
            longitude: 40,
            metrics: {
              demand: 10,
            },
            properties: {
              route: "West",
            },
            time: 10,
          },
        ],
      },
    ];

    expect(getTemporalHeatMapMaxWeight(tracks, { weightMetric: "demand" })).toBe(10);

    render(
      <TemporalHeatMap
        defaultTime={5}
        formatTimeLabel={(time) => `T${time}`}
        mapLabel="Temporal demand heat map"
        showAttributionControl={false}
        timeStep={5}
        tracks={tracks}
        weightMetric="demand"
      />,
    );

    expect(screen.getByText("T5")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByLabelText("Temporal demand heat map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const marker = leafletMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__heat-marker");

    expect(marker).toMatchObject({
      latLng: [15, 30],
      type: "circleMarker",
    });
  });
});
