import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  HeatMap,
  TemporalHeatMap,
  createHeatFieldContourFeatureCollection,
  createHeatMapDensityIndex,
  createHeatMapFeatureCollection,
  createScalarFieldGrid,
  getTemporalHeatMapMaxWeight,
  type MapPoint,
  type TemporalMapTrack,
} from ".";

const flatMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    bounds?: [[number, number], [number, number]];
    latLng?: [number, number];
    latLngs?: unknown;
    options?: Record<string, unknown>;
    tooltip?: {
      content: string;
      options?: Record<string, unknown>;
    };
    type: string;
    url?: string;
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
    centerLatitude = 0;
    centerLongitude = 0;
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
      const northWest = this.containerPointToLatLng([0, 0]);
      const southEast = this.containerPointToLatLng([
        this.container.clientWidth,
        this.container.clientHeight,
      ]);

      return {
        getEast: () => southEast.lng,
        getNorth: () => northWest.lat,
        getSouth: () => southEast.lat,
        getWest: () => northWest.lng,
      };
    }

    getContainer() {
      return this.container;
    }

    getZoom() {
      return this.zoom;
    }

    latLngToContainerPoint([latitude, longitude]: [number, number]) {
      const scale = 2 ** (this.zoom - 2);

      return {
        x:
          this.container.clientWidth / 2 +
          ((longitude - this.centerLongitude) / 360) * this.container.clientWidth * scale,
        y:
          this.container.clientHeight / 2 -
          ((latitude - this.centerLatitude) / 170) * this.container.clientHeight * scale,
      };
    }

    containerPointToLatLng([x, y]: [number, number]) {
      const scale = 2 ** (this.zoom - 2);

      return {
        lat:
          this.centerLatitude -
          ((y - this.container.clientHeight / 2) / (this.container.clientHeight * scale)) * 170,
        lng:
          this.centerLongitude +
          ((x - this.container.clientWidth / 2) / (this.container.clientWidth * scale)) * 360,
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
  }

  function createLayer(type: string, latLng?: [number, number], options?: Record<string, unknown>) {
    const layer: Layer & {
      addTo: (group: MockLayerGroup) => typeof layer;
      bindTooltip: (content: string, options?: Record<string, unknown>) => typeof layer;
    } = {
      latLng,
      options,
      type,
      addTo(group: MockLayerGroup) {
        group.addLayer(this);
        return this;
      },
      bindTooltip(content: string, options?: Record<string, unknown>) {
        this.tooltip = {
          content,
          options,
        };
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
    imageOverlay: (
      url: string,
      bounds: [[number, number], [number, number]],
      options: Record<string, unknown>,
    ) => ({
      ...createLayer("imageOverlay", undefined, options),
      bounds,
      url,
    }),
    layerGroup: () => new MockLayerGroup(),
    map: () => new MockMap(),
    polyline: (latLngs: unknown, options: Record<string, unknown>) => ({
      ...createLayer("polyline", undefined, options),
      latLngs,
    }),
    rectangle: (
      bounds: [[number, number], [number, number]],
      options: Record<string, unknown>,
    ) => ({
      ...createLayer("rectangle", undefined, options),
      bounds,
    }),
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

vi.mock("flat", () => flatMock);

afterEach(() => {
  flatMock.reset();
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

  test("renders weighted Flat heat as a smooth interpolated surface by default", async () => {
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

    const surface = flatMock
      .getLayerGroups()[0]
      ?.layers.find(
        (layer) =>
          layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
      );

    expect(surface).toMatchObject({
      options: {
        interactive: false,
        opacity: 0.84,
      },
      type: "imageOverlay",
    });
    expect(surface?.bounds).toHaveLength(2);
    expect(surface?.url).toContain("data:image/svg+xml");
    expect(decodeURIComponent(surface?.url ?? "")).toContain("heat-soften");
    expect(
      flatMock
        .getLayerGroups()[0]
        ?.layers.some((layer) => layer.type === "circleMarker" || layer.type === "rectangle"),
    ).toBe(false);
  });

  test("fills the whole viewport while keeping source hotspots stronger", async () => {
    render(
      <HeatMap
        heatmapRadius={{ meters: 100_000 }}
        mapLabel="Normalized heat map"
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
      expect(screen.getByLabelText("Normalized heat map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const surface = flatMock
      .getLayerGroups()[0]
      ?.layers.find(
        (layer) =>
          layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
      );
    const sourcePoint = flatMock.getMaps()[0]?.latLngToContainerPoint([40, -74]);
    const sourceCell = getNearestSvgCircle(surface?.url ?? "", sourcePoint!);
    const northWestCell = getNearestSvgCircle(surface?.url ?? "", { x: 0, y: 0 });
    const southEastCell = getNearestSvgCircle(surface?.url ?? "", { x: 960, y: 640 });

    expect(northWestCell?.opacity).toBeGreaterThan(0.3);
    expect(southEastCell?.opacity).toBeGreaterThan(0.3);
    expect(sourceCell?.opacity).toBeGreaterThan(northWestCell?.opacity ?? 0);
    expect(sourceCell?.opacity).toBeGreaterThan(southEastCell?.opacity ?? 0);
  });

  test("keeps interpolated heat color independent of unrelated viewport hotspots", async () => {
    const points: MapPoint[] = [
      {
        id: "weak",
        latitude: 0,
        longitude: 0,
        metrics: {
          demand: 5,
        },
      },
      {
        id: "strong-a",
        latitude: 0,
        longitude: 100,
        metrics: {
          demand: 10,
        },
      },
      {
        id: "strong-b",
        latitude: 0,
        longitude: 100,
        metrics: {
          demand: 10,
        },
      },
    ];

    const { rerender } = render(
      <HeatMap
        heatmapRadius={{ meters: 500_000 }}
        mapLabel="Stable absolute heat map"
        maxWeight={10}
        points={points}
        showAttributionControl={false}
        weightMetric="demand"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Stable absolute heat map").getAttribute("data-map-ready"),
      ).toBe("true");
    });

    const map = flatMock.getMaps()[0]!;
    const weakPoint = map.latLngToContainerPoint([0, 0]);
    const initialSurface = flatMock
      .getLayerGroups()[0]
      ?.layers.find(
        (layer) =>
          layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
      );
    const initialWeakCell = getNearestSvgCircle(initialSurface?.url ?? "", weakPoint);

    rerender(
      <HeatMap
        heatmapRadius={{ meters: 500_000 }}
        mapLabel="Stable absolute heat map"
        maxWeight={10}
        points={points.filter((point) => point.id === "weak")}
        showAttributionControl={false}
        weightMetric="demand"
      />,
    );

    const changedSurface = flatMock
      .getLayerGroups()[0]
      ?.layers.find(
        (layer) =>
          layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
      );
    const changedWeakCell = getNearestSvgCircle(changedSurface?.url ?? "", weakPoint);

    expect(changedWeakCell?.fill).toBe(initialWeakCell?.fill);
    expect(changedWeakCell?.opacity).toBeCloseTo(initialWeakCell?.opacity ?? 0, 3);
  });

  test("supports a data-anchored heat surface mode", async () => {
    render(
      <HeatMap
        heatmapSurfaceMode="data"
        mapLabel="Data heat map"
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
      expect(screen.getByLabelText("Data heat map").getAttribute("data-map-ready")).toBe("true");
    });

    const surface = flatMock
      .getLayerGroups()[0]
      ?.layers.find(
        (layer) => layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--data",
      );

    expect(surface).toMatchObject({
      type: "imageOverlay",
    });
    expect(decodeURIComponent(surface?.url ?? "")).toContain("<circle");
  });

  test("renders field mode as a domain-anchored scalar raster", async () => {
    render(
      <HeatMap
        domainBounds={[-11, 35, 31, 62]}
        fieldColumns={12}
        fieldRows={8}
        heatmapSurfaceMode="field"
        mapLabel="Temperature field map"
        points={[
          {
            id: "berlin",
            latitude: 52.52,
            longitude: 13.405,
            metrics: {
              temperature: 21.5,
            },
          },
          {
            id: "paris",
            latitude: 48.8566,
            longitude: 2.3522,
            metrics: {
              temperature: 24.1,
            },
          },
        ]}
        showAttributionControl={false}
        valueMetric="temperature"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Temperature field map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const layerGroup = flatMock.getLayerGroups()[0];
    const surface = layerGroup?.layers.find(
      (layer) => layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--field",
    );

    expect(surface).toMatchObject({
      bounds: [
        [35, -11],
        [62, 31],
      ],
      options: {
        interactive: false,
        opacity: 0.84,
      },
      type: "imageOverlay",
    });
    expect(surface?.url).toContain("data:image/");

    const map = flatMock.getMaps()[0]!;
    const initialUrl = surface?.url;

    map.centerLongitude = 12;
    map.zoom = 5;
    await act(async () => {
      map.handlers.get("moveend")?.[0]?.();
    });

    const changedSurface = layerGroup?.layers.find(
      (layer) => layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--field",
    );

    expect(changedSurface?.url).toBe(initialUrl);
    expect(changedSurface?.bounds).toEqual(surface?.bounds);
  });

  test("creates field contours as GeoJSON MultiLineString features", () => {
    const grid = createScalarFieldGrid(
      [
        {
          id: "cold",
          latitude: 52,
          longitude: 4,
          metrics: {
            temperature: 14,
          },
        },
        {
          id: "warm",
          latitude: 42,
          longitude: 18,
          metrics: {
            temperature: 30,
          },
        },
      ],
      {
        domainBounds: [0, 40, 20, 54],
        fieldColumns: 12,
        fieldRows: 8,
        valueDomain: [10, 34],
        valueMetric: "temperature",
      },
    );
    const contours = createHeatFieldContourFeatureCollection(grid, {
      levels: [18, 24, 30],
      valueFormat: (value) => `${value.toFixed(0)} C`,
    });

    expect(contours.type).toBe("FeatureCollection");
    expect(contours.features.length).toBeGreaterThan(0);
    expect(contours.features[0]).toMatchObject({
      geometry: {
        type: "MultiLineString",
      },
      properties: {
        kind: "heat-field-contour",
        valueLabel: expect.stringContaining("C"),
      },
      type: "Feature",
    });
  });

  test("renders field mode as vector contour level lines", async () => {
    render(
      <HeatMap
        domainBounds={[-11, 35, 31, 62]}
        fieldColumns={18}
        fieldContourColor="#111827"
        fieldContourLevels={8}
        fieldContourLineWidth={0.75}
        fieldRenderMode="contours"
        fieldContourValueFormat={(value) => `${value.toFixed(1)} C`}
        fieldRows={12}
        fieldValueDomain={[12, 34]}
        heatmapSurfaceMode="field"
        mapLabel="Temperature contour map"
        points={[
          {
            id: "reykjavik",
            latitude: 64.1466,
            longitude: -21.9426,
            metrics: {
              temperature: 14.3,
            },
          },
          {
            id: "paris",
            latitude: 48.8566,
            longitude: 2.3522,
            metrics: {
              temperature: 24.1,
            },
          },
          {
            id: "madrid",
            latitude: 40.4168,
            longitude: -3.7038,
            metrics: {
              temperature: 30.4,
            },
          },
        ]}
        showAttributionControl={false}
        valueMetric="temperature"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Temperature contour map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const contourLines = flatMock
      .getLayerGroups()[0]
      ?.layers.filter((layer) => layer.options?.className === "mb-maps__heat-contour");

    expect(contourLines?.length).toBeGreaterThan(0);
    expect(contourLines?.[0]).toMatchObject({
      options: {
        color: "#111827",
        interactive: true,
        weight: 0.75,
      },
      tooltip: {
        content: expect.stringContaining("C"),
        options: {
          sticky: true,
        },
      },
      type: "polyline",
    });
    expect(
      flatMock.getLayerGroups()[0]?.layers.some((layer) => layer.type === "imageOverlay"),
    ).toBe(false);
  });

  test("renders field colors and hoverable level lines together", async () => {
    render(
      <HeatMap
        domainBounds={[-11, 35, 31, 62]}
        fieldColumns={18}
        fieldContourColor="#0f172a"
        fieldContourLevels={8}
        fieldContourLineWidth={2.25}
        fieldContourValueFormat={(value) => `${value.toFixed(1)} C`}
        fieldRenderMode="raster-contours"
        fieldRows={12}
        fieldValueDomain={[12, 34]}
        heatmapSurfaceMode="field"
        mapLabel="Temperature color contour map"
        points={[
          {
            id: "reykjavik",
            latitude: 64.1466,
            longitude: -21.9426,
            metrics: {
              temperature: 14.3,
            },
          },
          {
            id: "paris",
            latitude: 48.8566,
            longitude: 2.3522,
            metrics: {
              temperature: 24.1,
            },
          },
          {
            id: "madrid",
            latitude: 40.4168,
            longitude: -3.7038,
            metrics: {
              temperature: 30.4,
            },
          },
        ]}
        showAttributionControl={false}
        valueMetric="temperature"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Temperature color contour map").getAttribute("data-map-ready"),
      ).toBe("true");
    });

    const layerGroup = flatMock.getLayerGroups()[0];
    const surface = layerGroup?.layers.find(
      (layer) => layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--field",
    );
    const contourLines = layerGroup?.layers.filter(
      (layer) => layer.options?.className === "mb-maps__heat-contour",
    );

    expect(surface).toMatchObject({
      options: {
        interactive: false,
      },
      type: "imageOverlay",
    });
    expect(contourLines?.length).toBeGreaterThan(0);
    expect(contourLines?.[0]).toMatchObject({
      options: {
        color: "#0f172a",
        interactive: true,
        weight: 2.25,
      },
      tooltip: {
        content: expect.stringContaining("C"),
        options: {
          sticky: true,
        },
      },
      type: "polyline",
    });
  });

  test("can overlay original data points on a field heat map", async () => {
    render(
      <HeatMap
        domainBounds={[-11, 35, 31, 62]}
        fieldColumns={12}
        fieldRows={8}
        heatmapSurfaceMode="field"
        mapLabel="Temperature points map"
        points={[
          {
            id: "berlin",
            latitude: 52.52,
            longitude: 13.405,
            metrics: {
              temperature: 21.5,
            },
          },
          {
            id: "paris",
            latitude: 48.8566,
            longitude: 2.3522,
            metrics: {
              temperature: 24.1,
            },
          },
        ]}
        showAttributionControl={false}
        showDataPoints
        dataPointValueFormat={(value) => `${value.toFixed(1)} C`}
        valueMetric="temperature"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Temperature points map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const markers = flatMock
      .getLayerGroups()[0]
      ?.layers.filter((layer) => layer.options?.className === "mb-maps__heat-data-point");

    expect(markers).toHaveLength(2);
    expect(markers?.[0]).toMatchObject({
      options: {
        fillColor: "#0f172a",
        interactive: true,
      },
      tooltip: {
        content: expect.stringContaining("21.5 C"),
      },
      type: "circleMarker",
    });
  });

  test("projects a data-space heat radius when zoom changes", async () => {
    render(
      <HeatMap
        heatmapRadius={{ meters: 100_000 }}
        heatmapSurfaceMode="data"
        mapLabel="Data-radius heat map"
        points={[
          {
            id: "a",
            latitude: 0,
            longitude: 0,
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
      expect(screen.getByLabelText("Data-radius heat map").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const layerGroup = flatMock.getLayerGroups()[0];
    const map = flatMock.getMaps()[0];
    map!.zoom = 4;
    await act(async () => {
      map!.handlers.get("moveend")?.[0]?.();
    });

    const farZoomSurface = layerGroup?.layers.find(
      (layer) => layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--data",
    );
    const farZoomRadius = getFirstSvgCircleRadius(farZoomSurface?.url ?? "");

    expect(farZoomRadius).toBeGreaterThan(0);

    map!.zoom = 5;
    await act(async () => {
      map!.handlers.get("moveend")?.[0]?.();
    });

    const zoomedSurface = layerGroup?.layers.find(
      (layer) => layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--data",
    );
    const zoomedRadius = getFirstSvgCircleRadius(zoomedSurface?.url ?? "");

    expect(zoomedRadius / farZoomRadius).toBeCloseTo(2, 1);
  });

  test("keeps interpolated heat intensity absolute to data weights", async () => {
    render(
      <HeatMap
        heatmapRadius={{ meters: 500_000 }}
        mapLabel="Absolute-intensity heat map"
        points={[
          {
            id: "weak",
            latitude: 0,
            longitude: 0,
            metrics: {
              demand: 5,
            },
          },
          {
            id: "strong-a",
            latitude: 0,
            longitude: 100,
            metrics: {
              demand: 10,
            },
          },
          {
            id: "strong-b",
            latitude: 0,
            longitude: 100,
            metrics: {
              demand: 10,
            },
          },
        ]}
        showAttributionControl={false}
        weightMetric="demand"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Absolute-intensity heat map").getAttribute("data-map-ready"),
      ).toBe("true");
    });

    const surface = flatMock
      .getLayerGroups()[0]
      ?.layers.find(
        (layer) =>
          layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
      );
    const weakPoint = flatMock.getMaps()[0]?.latLngToContainerPoint([0, 0]);
    const weakCell = getNearestSvgCircle(surface?.url ?? "", weakPoint!);

    expect(weakCell?.opacity).toBeGreaterThan(0.55);
  });

  test("keeps interpolated heat color stable across pan and zoom", async () => {
    render(
      <HeatMap
        heatmapRadius={{ meters: 300_000 }}
        mapLabel="Viewport-independent heat map"
        points={[
          {
            id: "a",
            latitude: 0,
            longitude: 0,
            metrics: {
              demand: 5,
            },
          },
        ]}
        showAttributionControl={false}
        weightMetric="demand"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Viewport-independent heat map").getAttribute("data-map-ready"),
      ).toBe("true");
    });

    const layerGroup = flatMock.getLayerGroups()[0];
    const map = flatMock.getMaps()[0]!;
    const initialSurface = layerGroup?.layers.find(
      (layer) =>
        layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
    );
    const initialPoint = map.latLngToContainerPoint([0, 0]);
    const initialCell = getNearestSvgCircle(initialSurface?.url ?? "", initialPoint);

    map.centerLongitude = 12;
    map.zoom = 3;
    await act(async () => {
      map.handlers.get("moveend")?.[0]?.();
    });

    const changedSurface = layerGroup?.layers.find(
      (layer) =>
        layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
    );
    const changedPoint = map.latLngToContainerPoint([0, 0]);
    const changedCell = getNearestSvgCircle(changedSurface?.url ?? "", changedPoint);

    expect(changedCell?.fill).toBe(initialCell?.fill);
    expect(changedCell?.opacity).toBeCloseTo(initialCell?.opacity ?? 0, 3);
  });

  test("renders heat markers on the globe display", () => {
    render(
      <HeatMap
        initialViewState={{ center: [-74, 40], zoom: 2 }}
        mapDisplay="globe"
        mapLabel="Demand globe heat map"
        points={[
          {
            id: "a",
            label: "New York",
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

    const map = screen.getByLabelText("Demand globe heat map");

    expect(map.getAttribute("data-map-ready")).toBe("true");
    expect(map.querySelector(".mb-maps__globe")).toBeTruthy();
    expect(map.querySelector(".mb-maps__globe-heat-marker")).toBeTruthy();
    expect(flatMock.getMaps()).toHaveLength(0);
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

    const surface = flatMock
      .getLayerGroups()[0]
      ?.layers.find(
        (layer) =>
          layer.options?.className === "mb-maps__heat-surface mb-maps__heat-surface--interpolated",
      );

    expect(surface).toMatchObject({
      type: "imageOverlay",
    });
  });
});

function getFirstSvgCircleRadius(url: string) {
  const radiusMatch = /<circle[^>]*\sr="([^"]+)"/.exec(decodeURIComponent(url));

  return radiusMatch ? Number(radiusMatch[1]) : 0;
}

function getNearestSvgCircle(
  url: string,
  point: {
    x: number;
    y: number;
  },
) {
  const circles = [...decodeURIComponent(url).matchAll(/<circle\s+([^>]+)>/g)].map((match) => {
    const attributes = match[1] ?? "";

    return {
      cx: Number(getSvgAttribute(attributes, "cx")),
      cy: Number(getSvgAttribute(attributes, "cy")),
      fill: getSvgAttribute(attributes, "fill"),
      opacity: Number(getSvgAttribute(attributes, "opacity")),
    };
  });

  return circles
    .filter((circle) => Number.isFinite(circle.cx) && Number.isFinite(circle.cy))
    .sort(
      (left, right) =>
        Math.hypot(left.cx - point.x, left.cy - point.y) -
        Math.hypot(right.cx - point.x, right.cy - point.y),
    )[0];
}

function getSvgAttribute(attributes: string, name: string) {
  return new RegExp(`${name}="([^"]+)"`).exec(attributes)?.[1] ?? "";
}
