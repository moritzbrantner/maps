import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BubbleMap,
  ClusteredMap,
  FlowLayer,
  FlowMap,
  GeoJsonMap,
  GeoJsonLayer,
  HeatMap,
  MapControls,
  MapCategoryLegend,
  MapColorRampLegend,
  MapFlowLegend,
  MapLayers,
  MapLegend,
  MapSizeLegend,
  MapView,
  PointLayer,
  PointMap,
  createBubbleMapFeatures,
  createFlowMapFeatures,
  createGeoJsonOverlayFeatureCollection,
  createGeoJsonLayerFeatures,
  createMapFlowsFromGeoJson,
  createMapPointsFromGeoJson,
  createPointMapFeatures,
  getBoundsFromGeoJson,
  getGlobeViewStateForBounds,
  getMapBoundsCenter,
  mergeMapBounds,
  padMapBounds,
  type GeoJsonMapSource,
  type MapFlow,
  type MapPoint,
} from ".";
import {
  getGlobeRadius,
  getGlobeSphereRotation,
  getGlobeZoom,
  GLOBE_MAX_ZOOM,
  projectGlobeCoordinate,
} from "./map-display";
import {
  buildGlobeTileUrl,
  createGlobeBasemapPaths,
  createGlobeRenderScheduler,
  getVisibleGlobeTiles,
  projectGlobeBasemapCoordinate,
  resolveGlobeTileSource,
} from "./globe-base";
import {
  buildWebGlFlatTileUrl,
  coordinateToWebGlFlatWorldPoint,
  getVisibleWebGlFlatTiles,
  getWebGlFlatBoundsMinZoom,
  getWebGlFlatViewport,
  getWebGlFlatZoom,
  panWebGlFlatViewState,
  resolveWebGlFlatTileSource,
  webGlFlatWorldPointToCoordinate,
} from "./webgl-flat-runtime";
import { createFlowPathCoordinates } from "./flow-layer";
import type { FlowLayerFeature } from "./flow-layer";

const flatMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    bringToFront?: () => Layer;
    handlers: Map<string, Handler[]>;
    latLng?: [number, number];
    latLngs?: unknown;
    options?: Record<string, unknown>;
    setLatLng?: (latLng: [number, number]) => Layer;
    type: string;
  };

  const maps: MockMap[] = [];
  const layerGroups: MockLayerGroup[] = [];

  class MockLayerGroup {
    clearCount = 0;
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
      this.clearCount += 1;
      this.layers = [];
    }

    removeLayer(layer: Layer) {
      this.layers = this.layers.filter((candidate) => candidate !== layer);
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

    dragging = {
      disable() {},
      enable() {},
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

    latLngToContainerPoint([latitude, longitude]: [number, number]) {
      return {
        x: ((longitude + 180) / 360) * this.container.clientWidth,
        y: ((90 - latitude) / 180) * this.container.clientHeight,
      };
    }

    containerPointToLatLng([x, y]: [number, number]) {
      return {
        lat: 90 - (y / this.container.clientHeight) * 180,
        lng: -180 + (x / this.container.clientWidth) * 360,
      };
    }

    off(event: string, handler: Handler) {
      const handlers = this.handlers.get(event) ?? [];

      this.handlers.set(
        event,
        handlers.filter((item) => item !== handler),
      );
    }

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
      on: (event: string, handler: Handler) => typeof layer;
    } = {
      handlers: new Map(),
      latLng,
      latLngs,
      options,
      type,
      addTo(group: MockLayerGroup) {
        group.addLayer(this);
        return this;
      },
      bringToFront() {
        return this;
      },
      on(event: string, handler: Handler) {
        const handlers = this.handlers.get(event) ?? [];

        handlers.push(handler);
        this.handlers.set(event, handlers);

        return this;
      },
      setLatLng(nextLatLng: [number, number]) {
        this.latLng = nextLatLng;
        return this;
      },
    };

    return layer;
  }

  return {
    circleMarker: (latLng: [number, number], options: Record<string, unknown>) =>
      createLayer("circleMarker", latLng, options),
    divIcon: (options: Record<string, unknown>) => ({
      options,
      type: "divIcon",
    }),
    getLayerGroups: () => layerGroups,
    getMaps: () => maps,
    imageOverlay: (_url: string, _bounds: unknown, options: Record<string, unknown>) =>
      createLayer("imageOverlay", undefined, options),
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

vi.mock("flat", () => flatMock);

afterEach(() => {
  flatMock.reset();
  vi.unstubAllGlobals();
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

  test("creates configurable flow path curves", () => {
    const feature: FlowLayerFeature = {
      flow: {
        from: [-74, 40],
        id: "nyc-boston",
        label: "NYC to Boston",
        metrics: {},
        properties: {},
        to: [-71, 42],
      },
      rawValue: 9,
      value: 1,
      width: 8,
    };
    const path = createFlowPathCoordinates(feature, {
      bend: 0.34,
      direction: "clockwise",
      segments: 12,
      type: "s-curve",
    });

    expect(path).toHaveLength(12);
    expect(path[0]).toEqual([-74, 40]);
    expect(path.at(-1)).toEqual([-71, 42]);
    expect(path[3]?.[0]).not.toBeCloseTo(-74 + (3 / 11) * 3);
  });

  test("creates renderable GeoJSON layer features from supported geometries", () => {
    const features = createGeoJsonLayerFeatures({
      features: [
        {
          geometry: {
            coordinates: [-74, 40],
            type: "Point",
          },
          id: "point-a",
          properties: {
            label: "Point A",
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [-74, 40],
              [-71, 42],
            ],
            type: "LineString",
          },
          id: "line-a",
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [
                [-74, 40],
                [-71, 40],
                [-71, 42],
                [-74, 40],
              ],
            ],
            type: "Polygon",
          },
          id: "polygon-a",
          type: "Feature",
        },
      ],
      type: "FeatureCollection",
    });

    expect(features.map((feature) => feature.geometry.type)).toEqual(["Point", "LineString", "Polygon"]);
  });

  test("creates map points, flows, bounds, and overlays from GeoJSON", () => {
    const collection: GeoJsonMapSource = {
      features: [
        {
          geometry: {
            coordinates: [
              [-74, 40],
              [-71, 42],
            ],
            type: "MultiPoint" as const,
          },
          id: "stores",
          properties: {
            demand: 8,
            label: "Stores",
          },
          type: "Feature" as const,
        },
        {
          geometry: {
            coordinates: [
              [-74, 40],
              [-73, 41],
              [-71, 42],
            ],
            type: "LineString" as const,
          },
          id: "route",
          properties: {
            trips: 12,
          },
          type: "Feature" as const,
        },
        {
          geometry: {
            coordinates: [
              [
                [-75, 39],
                [-70, 39],
                [-70, 43],
                [-75, 39],
              ],
            ],
            type: "Polygon" as const,
          },
          id: "zone",
          type: "Feature" as const,
        },
      ],
      type: "FeatureCollection" as const,
    };

    expect(createMapPointsFromGeoJson(collection, { metricKeys: ["demand"] })).toMatchObject([
      {
        id: "stores:part-0",
        latitude: 40,
        longitude: -74,
        metrics: {
          demand: 8,
        },
      },
      {
        id: "stores:part-1",
        latitude: 42,
        longitude: -71,
      },
    ]);
    expect(createMapFlowsFromGeoJson(collection, { metricKeys: ["trips"] })).toMatchObject([
      {
        from: [-74, 40],
        id: "route",
        metrics: {
          trips: 12,
        },
        to: [-71, 42],
      },
    ]);
    expect(getBoundsFromGeoJson(collection)).toEqual([-75, 39, -70, 43]);
    expect(
      createGeoJsonOverlayFeatureCollection(collection, {
        target: "point",
      }).features.map((feature) => feature.geometry?.type),
    ).toEqual(["LineString", "Polygon"]);
    expect(
      createGeoJsonOverlayFeatureCollection(collection, {
        target: "flow",
      }).features.map((feature) => feature.id),
    ).toEqual(["stores", "route", "zone"]);
  });

  test("renders flat point markers with Flat", async () => {
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

    expect(flatMock.getLayerGroups()[0]?.layers).toMatchObject([
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

  test("keeps flat point markers mounted while hovering", async () => {
    render(
      <PointMap
        mapLabel="Hoverable store points"
        points={[
          {
            id: "store-1",
            label: "Store 1",
            latitude: 40,
            longitude: -74,
          },
        ]}
        renderFeatureTooltip={(feature) => feature.point.label}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Hoverable store points").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const group = flatMock.getLayerGroups()[0];
    const marker = group?.layers[0];

    await act(async () => {
      marker?.handlers.get("mouseover")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(screen.getByText("Store 1")).toBeTruthy();
    expect(group?.layers[0]).toBe(marker);
  });

  test("keeps flat cluster markers mounted while hovering", async () => {
    render(
      <ClusteredMap
        mapLabel="Hoverable store clusters"
        points={[
          {
            id: "store-1",
            latitude: 40,
            longitude: -74,
          },
          {
            id: "store-2",
            latitude: 40.01,
            longitude: -74.01,
          },
        ]}
        renderFeatureTooltip={(feature) =>
          feature.kind === "cluster" ? feature.pointCountAbbreviated : feature.point.label
        }
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Hoverable store clusters").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const group = flatMock.getLayerGroups()[0];
    const marker = group?.layers.find(
      (layer) => layer.options?.className === "mb-maps__cluster-marker",
    );

    await act(async () => {
      marker?.handlers.get("mouseover")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(screen.getByText("2")).toBeTruthy();
    expect(
      group?.layers.find((layer) => layer.options?.className === "mb-maps__cluster-marker"),
    ).toBe(marker);
  });

  test("clears flat cluster hover tooltip on click", async () => {
    render(
      <ClusteredMap
        mapLabel="Clickable store clusters"
        points={[
          {
            id: "store-1",
            latitude: 40,
            longitude: -74,
          },
          {
            id: "store-2",
            latitude: 40.01,
            longitude: -74.01,
          },
        ]}
        renderFeatureTooltip={(feature) =>
          feature.kind === "cluster" ? `${feature.pointCountAbbreviated} stores` : feature.point.label
        }
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Clickable store clusters").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const marker = flatMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__cluster-marker");

    await act(async () => {
      marker?.handlers.get("mouseover")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(screen.getByText("2 stores")).toBeTruthy();

    await act(async () => {
      marker?.handlers.get("click")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(screen.queryByText("2 stores")).toBeNull();

    await act(async () => {
      marker?.handlers.get("mouseover")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(screen.queryByText("2 stores")).toBeNull();
  });

  test("clears flat cluster hover tooltip when the map moves", async () => {
    render(
      <ClusteredMap
        mapLabel="Moving store clusters"
        points={[
          {
            id: "store-1",
            latitude: 40,
            longitude: -74,
          },
          {
            id: "store-2",
            latitude: 40.01,
            longitude: -74.01,
          },
        ]}
        renderFeatureTooltip={(feature) =>
          feature.kind === "cluster" ? `${feature.pointCountAbbreviated} stores` : feature.point.label
        }
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Moving store clusters").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const map = flatMock.getMaps()[0];
    const marker = flatMock
      .getLayerGroups()[0]
      ?.layers.find((layer) => layer.options?.className === "mb-maps__cluster-marker");

    await act(async () => {
      marker?.handlers.get("mouseover")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(screen.getByText("2 stores")).toBeTruthy();

    await act(async () => {
      map?.handlers.get("movestart")?.[0]?.();
    });

    expect(screen.queryByText("2 stores")).toBeNull();
  });

  test("keeps unchanged flat point markers mounted after zoom end", async () => {
    render(
      <PointMap
        fitToData={false}
        mapLabel="Zoomable store points"
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
      expect(screen.getByLabelText("Zoomable store points").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const map = flatMock.getMaps()[0];
    const group = flatMock.getLayerGroups()[0];
    const marker = group?.layers[0];
    const initialClearCount = group?.clearCount ?? 0;

    await act(async () => {
      if (map) {
        map.zoom = 6;
      }
      map?.handlers.get("moveend")?.[0]?.();
    });

    expect(group?.clearCount).toBe(initialClearCount);
    expect(group?.layers[0]).toBe(marker);
  });

  test("keeps flat GeoJSON layers mounted after zoom end", async () => {
    render(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        fitToData={false}
        mapLabel="Zoomable GeoJSON"
        showAttributionControl={false}
      >
        <GeoJsonLayer
          featureCollection={{
            type: "FeatureCollection",
            features: [
              {
                id: "zone-1",
                type: "Feature",
                properties: {},
                geometry: {
                  type: "Polygon",
                  coordinates: [[[-75, 39], [-73, 39], [-73, 41], [-75, 41], [-75, 39]]],
                },
              },
            ],
          }}
        />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Zoomable GeoJSON").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const map = flatMock.getMaps()[0];
    const group = flatMock.getLayerGroups()[0];
    const layer = group?.layers[0];
    const initialClearCount = group?.clearCount ?? 0;

    await act(async () => {
      if (map) {
        map.zoom = 6;
      }
      map?.handlers.get("moveend")?.[0]?.();
    });

    expect(group?.clearCount).toBe(initialClearCount);
    expect(group?.layers[0]).toBe(layer);
  });

  test("keeps flat flow layers mounted after zoom end", async () => {
    render(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        fitToData={false}
        mapLabel="Zoomable flows"
        showAttributionControl={false}
      >
        <FlowLayer
          flows={[
            {
              from: [-74, 40],
              id: "route-1",
              metrics: { trips: 10 },
              to: [-73, 41],
            },
          ]}
          showEndpoints={false}
          weightMetric="trips"
        />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Zoomable flows").getAttribute("data-map-ready")).toBe("true");
    });
    await act(async () => {
      await Promise.resolve();
    });

    const map = flatMock.getMaps()[0];
    const group = flatMock.getLayerGroups()[0];
    const layer = group?.layers[0];
    const initialClearCount = group?.clearCount ?? 0;

    await act(async () => {
      if (map) {
        map.zoom = 6;
      }
      map?.handlers.get("moveend")?.[0]?.();
    });

    expect(group?.clearCount).toBe(initialClearCount);
    expect(group?.layers[0]).toBe(layer);
  });

  test("keeps equivalent flat point marker rerenders mounted once", async () => {
    const { rerender } = render(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        fitToData={false}
        mapLabel="Stable point rerender"
        showAttributionControl={false}
      >
        <PointLayer points={[{ id: "store-1", latitude: 40, longitude: -74 }]} />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Stable point rerender").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const group = flatMock.getLayerGroups()[0];
    const marker = group?.layers[0];
    const initialClearCount = group?.clearCount ?? 0;

    rerender(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        fitToData={false}
        mapLabel="Stable point rerender"
        showAttributionControl={false}
      >
        <PointLayer points={[{ id: "store-1", latitude: 40, longitude: -74 }]} />
      </MapView>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(group?.clearCount).toBe(initialClearCount);
    expect(group?.layers).toHaveLength(1);
    expect(group?.layers[0]).toBe(marker);
  });

  test("updates flat point marker coordinates in place", async () => {
    const { rerender } = render(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        fitToData={false}
        mapLabel="Moving point rerender"
        showAttributionControl={false}
      >
        <PointLayer points={[{ id: "store-1", latitude: 40, longitude: -74 }]} />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Moving point rerender").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const group = flatMock.getLayerGroups()[0];
    const marker = group?.layers[0];

    rerender(
      <MapView
        defaultViewState={{ center: [-74, 40], zoom: 5 }}
        fitToData={false}
        mapLabel="Moving point rerender"
        showAttributionControl={false}
      >
        <PointLayer points={[{ id: "store-1", latitude: 41, longitude: -73 }]} />
      </MapView>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(group?.layers).toHaveLength(1);
    expect(group?.layers[0]).toBe(marker);
    expect(group?.layers[0]?.latLng).toEqual([41, -73]);
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

    expect(flatMock.getLayerGroups()[0]?.layers[0]).toMatchObject({
      options: {
        fillColor: "#dc2626",
      },
    });
    expect(flatMock.getLayerGroups()[1]?.layers[0]).toMatchObject({
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
      const layers = flatMock.getLayerGroups().flatMap((group) => group.layers);

      expect(layers).toEqual([
        expect.objectContaining({
          options: expect.objectContaining({
            fillColor: "#16a34a",
          }),
        }),
      ]);
    });
  });

  test("renders layer and overlay slots across map displays", () => {
    render(
      <MapView
        initialViewState={{ center: [-74, 40], zoom: 2 }}
        mapDisplay="globe"
        mapLabel="Modular map"
      >
        <MapLayers>
          <PointLayer points={[{ id: "store-1", latitude: 40, longitude: -74 }]} />
        </MapLayers>
        <MapControls aria-label="Map controls">
          <button type="button">Reset</button>
        </MapControls>
        <MapLegend aria-label="Demand legend">
          <span>Demand</span>
        </MapLegend>
      </MapView>,
    );

    const map = screen.getByLabelText("Modular map");

    expect(map.querySelector(".mb-maps__globe-point")).toBeTruthy();
    expect(screen.getByLabelText("Map controls")).toBeTruthy();
    expect(screen.getByLabelText("Demand legend")).toBeTruthy();
    expect(map.querySelector(".mb-maps__globe-features")?.textContent).not.toContain("Reset");
  });

  test("renders overlay components inside convenience maps", () => {
    render(
      <PointMap
        initialViewState={{ center: [-74, 40], zoom: 2 }}
        mapDisplay="globe"
        mapLabel="Point map with legend"
        points={[{ id: "store-1", latitude: 40, longitude: -74 }]}
      >
        <MapLegend aria-label="Store legend">Stores</MapLegend>
      </PointMap>,
    );

    const map = screen.getByLabelText("Point map with legend");

    expect(map.querySelector(".mb-maps__globe-point")).toBeTruthy();
    expect(screen.getByLabelText("Store legend")).toBeTruthy();
  });

  test("renders built-in legend components", () => {
    render(
      <MapView mapDisplay="globe" mapLabel="Legend map">
        <MapColorRampLegend
          aria-label="Temperature legend"
          stops={[
            [0, "#2563eb"],
            [10, "#22c55e"],
          ]}
          title="Temperature"
        />
        <MapSizeLegend
          aria-label="Demand size legend"
          getRadius={(value) => value}
          title="Demand"
          values={[4, 8]}
        />
        <MapCategoryLegend
          aria-label="Category legend"
          items={[{ color: "#dc2626", label: "Delayed" }]}
          title="Status"
        />
        <MapFlowLegend
          aria-label="Flow legend"
          getWidth={(value) => value}
          title="Trips"
          values={[2, 6]}
        />
      </MapView>,
    );

    expect(screen.getByText("Temperature")).toBeTruthy();
    expect(screen.getByLabelText("Temperature legend").querySelector(".mb-maps__legend-ramp")).toBeTruthy();
    expect(screen.getByText("Delayed")).toBeTruthy();
    expect(screen.getByText("Trips")).toBeTruthy();
  });

  test("applies controlled hovered feature id to flat point layers", async () => {
    render(
      <MapView fitToData={false} mapLabel="Controlled hover map" showAttributionControl={false}>
        <PointLayer
          hoveredFeatureId="store-1"
          points={[{ id: "store-1", latitude: 40, longitude: -74 }]}
        />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Controlled hover map").getAttribute("data-map-ready")).toBe("true");
    });

    expect(flatMock.getLayerGroups()[0]?.layers[0]?.options?.className).toContain("mb-maps__feature--hovered");
  });

  test("reports controlled hover and selection id changes", async () => {
    const onFeatureHover = vi.fn();
    const onFeatureSelect = vi.fn();
    const onHoveredFeatureIdChange = vi.fn();
    const onSelectedFeatureIdChange = vi.fn();

    render(
      <MapView fitToData={false} mapLabel="Interactive id map" showAttributionControl={false}>
        <PointLayer
          onFeatureHover={onFeatureHover}
          onFeatureSelect={onFeatureSelect}
          onHoveredFeatureIdChange={onHoveredFeatureIdChange}
          onSelectedFeatureIdChange={onSelectedFeatureIdChange}
          points={[{ id: "store-1", latitude: 40, longitude: -74 }]}
        />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive id map").getAttribute("data-map-ready")).toBe("true");
    });

    const marker = flatMock.getLayerGroups()[0]?.layers[0];

    await act(async () => {
      marker?.handlers.get("mouseover")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
      marker?.handlers.get("click")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(onFeatureHover).toHaveBeenCalledWith(expect.objectContaining({
      point: expect.objectContaining({ id: "store-1" }),
    }));
    expect(onHoveredFeatureIdChange).toHaveBeenCalledWith("store-1", expect.objectContaining({
      featureId: "store-1",
      source: "hover",
    }));
    expect(onFeatureSelect).toHaveBeenCalledWith(expect.objectContaining({
      point: expect.objectContaining({ id: "store-1" }),
    }));
    expect(onSelectedFeatureIdChange).toHaveBeenCalledWith("store-1", expect.objectContaining({
      featureId: "store-1",
      source: "click",
    }));
  });

  test("computes viewport helper bounds and globe view states", () => {
    expect(getMapBoundsCenter([-10, 40, 10, 50])).toEqual([0, 45]);
    expect(padMapBounds([0, 10, 1, 11], 1)).toEqual([-1, 9, 2, 12]);
    expect(mergeMapBounds([0, 0, 1, 1], [-2, 3, 4, 5])).toEqual([-2, 0, 4, 5]);

    const globeViewState = getGlobeViewStateForBounds([-10, 40, 10, 50]);

    expect(globeViewState.center).toEqual([0, 45]);
    expect(globeViewState.zoom).toBeGreaterThan(1);
  });

  test("controller fits bounds, points, GeoJSON, and flies to view state", async () => {
    let controller: import("./map-display").MapSurfaceController | null = null;

    render(
      <MapView
        fitToData={false}
        mapLabel="Controller helper map"
        onMapControllerReady={(nextController) => {
          controller = nextController;
        }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Controller helper map").getAttribute("data-map-ready")).toBe("true");
      expect(controller).toBeTruthy();
    });

    act(() => {
      controller?.fitBounds([-10, 40, 10, 50], { maxZoom: 7 });
    });
    await waitFor(() => {
      expect(controller?.getViewState().center).toEqual([0, 45]);
    });

    act(() => {
      controller?.fitPoints([{ id: "store-1", latitude: 52, longitude: 13 }]);
    });
    await waitFor(() => {
      expect(controller?.getViewState().center).toEqual([13, 52]);
    });

    act(() => {
      controller?.fitGeoJson({
        type: "FeatureCollection",
        features: [
          {
            geometry: { coordinates: [8, 48], type: "Point" },
            properties: {},
            type: "Feature",
          },
        ],
      });
    });
    await waitFor(() => {
      expect(controller?.getViewState().center).toEqual([8, 48]);
    });

    act(() => {
      controller?.flyTo({ center: [2, 3], zoom: 4 }, { animate: false });
    });
    await waitFor(() => {
      expect(controller?.getViewState()).toEqual({ center: [2, 3], zoom: 4 });
    });
  });

  test("renders GeoJSON points, lines, and polygons as flat map layers", async () => {
    render(
      <MapView
        defaultViewState={{ center: [-73, 41], zoom: 5 }}
        mapLabel="GeoJSON layers"
        showAttributionControl={false}
      >
        <GeoJsonLayer
          featureCollection={{
            features: [
              {
                geometry: {
                  coordinates: [-74, 40],
                  type: "Point",
                },
                id: "point-a",
                type: "Feature",
              },
              {
                geometry: {
                  coordinates: [
                    [-74, 40],
                    [-71, 42],
                  ],
                  type: "LineString",
                },
                id: "line-a",
                type: "Feature",
              },
              {
                geometry: {
                  coordinates: [
                    [
                      [-74, 40],
                      [-71, 40],
                      [-71, 42],
                      [-74, 40],
                    ],
                  ],
                  type: "Polygon",
                },
                id: "polygon-a",
                type: "Feature",
              },
            ],
            type: "FeatureCollection",
          }}
        />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("GeoJSON layers").getAttribute("data-map-ready")).toBe("true");
    });

    expect(flatMock.getLayerGroups()[0]?.layers.map((layer) => layer.type)).toEqual([
      "circleMarker",
      "polyline",
      "polygon",
    ]);
    expect(
      flatMock.getLayerGroups()[0]?.layers.map((layer) => layer.options?.bubblingMouseEvents),
    ).toEqual([false, false, false]);
  });

  test("renders MultiPoint and GeometryCollection GeoJSON layers", async () => {
    render(
      <MapView
        defaultViewState={{ center: [-73, 41], zoom: 5 }}
        mapLabel="Collected GeoJSON layers"
        showAttributionControl={false}
      >
        <GeoJsonLayer
          featureCollection={{
            features: [
              {
                geometry: {
                  coordinates: [
                    [-74, 40],
                    [-71, 42],
                  ],
                  type: "MultiPoint",
                },
                id: "points-a",
                type: "Feature",
              },
              {
                geometry: {
                  geometries: [
                    {
                      coordinates: [
                        [-74, 40],
                        [-71, 42],
                      ],
                      type: "LineString",
                    },
                    {
                      coordinates: [
                        [
                          [-75, 39],
                          [-70, 39],
                          [-70, 43],
                          [-75, 39],
                        ],
                      ],
                      type: "Polygon",
                    },
                  ],
                  type: "GeometryCollection",
                },
                id: "collection-a",
                type: "Feature",
              },
            ],
            type: "FeatureCollection",
          }}
        />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Collected GeoJSON layers").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    expect(flatMock.getLayerGroups()[0]?.layers.map((layer) => layer.type)).toEqual([
      "circleMarker",
      "circleMarker",
      "polyline",
      "polygon",
    ]);
  });

  test("renders PointMap from GeoJSON points with incompatible geometry overlays", async () => {
    render(
      <PointMap
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [-74, 40],
                type: "Point",
              },
              id: "store-a",
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [
                    [-75, 39],
                    [-70, 39],
                    [-70, 43],
                    [-75, 39],
                  ],
                ],
                type: "Polygon",
              },
              id: "zone-a",
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        mapLabel="GeoJSON point map"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("GeoJSON point map").getAttribute("data-map-ready")).toBe("true");
    });

    expect(flatMock.getLayerGroups()[0]?.layers).toMatchObject([
      {
        options: {
          className: "mb-maps__geojson-feature",
        },
        type: "polygon",
      },
    ]);
    expect(flatMock.getLayerGroups()[1]?.layers).toMatchObject([
      {
        options: {
          className: "mb-maps__point-marker",
        },
        type: "circleMarker",
      },
    ]);
  });

  test("renders HeatMap from GeoJSON point weights", async () => {
    render(
      <HeatMap
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [-74, 40],
                type: "Point",
              },
              id: "demand-a",
              properties: {
                demand: 6,
              },
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        geoJsonOptions={{ metricKeys: ["demand"] }}
        heatmapSurfaceMode="data"
        mapLabel="GeoJSON heat map"
        showAttributionControl={false}
        weightMetric="demand"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("GeoJSON heat map").getAttribute("data-map-ready")).toBe("true");
    });

    expect(flatMock.getLayerGroups()[0]?.layers[0]).toMatchObject({
      options: {
        className: "mb-maps__heat-surface mb-maps__heat-surface--data",
      },
      type: "imageOverlay",
    });
  });

  test("renders FlowMap from GeoJSON routes and preserves multi-vertex route overlays", async () => {
    render(
      <FlowMap
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [
                  [-74, 40],
                  [-73, 41],
                  [-71, 42],
                ],
                type: "LineString",
              },
              id: "route-a",
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        mapLabel="GeoJSON flow map"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("GeoJSON flow map").getAttribute("data-map-ready")).toBe("true");
    });

    expect(flatMock.getLayerGroups()[0]?.layers[0]).toMatchObject({
      options: {
        className: "mb-maps__geojson-feature",
      },
      type: "polyline",
    });
    expect(flatMock.getLayerGroups()[1]?.layers[0]).toMatchObject({
      options: {
        className: "mb-maps__flow-line",
      },
      type: "polyline",
    });
  });

  test("renders GeoJsonMap as a pure GeoJSON convenience map", async () => {
    render(
      <GeoJsonMap
        geoJson={{
          features: [
            {
              geometry: {
                coordinates: [-74, 40],
                type: "Point",
              },
              id: "point-a",
              type: "Feature",
            },
            {
              geometry: {
                coordinates: [
                  [-74, 40],
                  [-71, 42],
                ],
                type: "LineString",
              },
              id: "line-a",
              type: "Feature",
            },
          ],
          type: "FeatureCollection",
        }}
        mapLabel="Pure GeoJSON map"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Pure GeoJSON map").getAttribute("data-map-ready")).toBe("true");
    });

    expect(flatMock.getLayerGroups()[0]?.layers.map((layer) => layer.type)).toEqual([
      "circleMarker",
      "polyline",
    ]);
  });

  test("handles right-click feature interactions on flat point markers", async () => {
    const onFeatureContextMenu = vi.fn();
    const preventDefault = vi.fn();

    render(
      <PointMap
        mapLabel="Interactive store points"
        onFeatureContextMenu={onFeatureContextMenu}
        points={[
          {
            id: "store-1",
            label: "Store 1",
            latitude: 40,
            longitude: -74,
          },
        ]}
        renderFeaturePopup={(feature) => <strong>{feature.point.label}</strong>}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Interactive store points").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const marker = flatMock.getLayerGroups()[0]?.layers[0];
    const [handleContextMenu] = marker?.handlers.get("contextmenu") ?? [];

    act(() => {
      handleContextMenu?.({
        containerPoint: { x: 120, y: 80 },
        originalEvent: { preventDefault },
      });
    });

    await waitFor(() => {
      expect(onFeatureContextMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          point: expect.objectContaining({
            id: "store-1",
          }),
        }),
      );
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(screen.getByText("Store 1")).toBeTruthy();
  });

  test("renders map context menus with clicked coordinates", async () => {
    const onMapContextMenu = vi.fn();

    render(
      <MapView
        mapLabel="Editable map"
        onMapContextMenu={onMapContextMenu}
        renderMapContextMenu={(context) => (
          <button type="button">
            Create {context.coordinates[0].toFixed(1)}, {context.coordinates[1].toFixed(1)}
          </button>
        )}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Editable map").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];
    const [handleContextMenu] = map?.handlers.get("contextmenu") ?? [];

    act(() => {
      handleContextMenu?.({
        containerPoint: { x: 480, y: 320 },
        latlng: { lat: 50, lng: 8 },
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
    });

    expect(onMapContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        coordinates: [8, 50],
      }),
    );
    expect(screen.getByText("Create 8.0, 50.0")).toBeTruthy();
  });

  test("drags flat point markers and emits updated coordinates", async () => {
    const onFeatureDragEnd = vi.fn();

    render(
      <PointMap
        draggable
        fitToData={false}
        mapLabel="Draggable store points"
        onFeatureDragEnd={onFeatureDragEnd}
        points={[
          {
            id: "store-1",
            label: "Store 1",
            latitude: 40,
            longitude: -74,
          },
        ]}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Draggable store points").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const map = flatMock.getMaps()[0];
    const marker = flatMock.getLayerGroups()[0]?.layers[0];
    const [handleMouseDown] = marker?.handlers.get("mousedown") ?? [];

    act(() => {
      handleMouseDown?.({
        latlng: { lat: 40, lng: -74 },
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
      map?.handlers.get("mousemove")?.[0]?.({
        latlng: { lat: 41, lng: -73 },
      });
      map?.handlers.get("mouseup")?.[0]?.({
        latlng: { lat: 42, lng: -72 },
      });
    });

    expect(marker?.latLng).toEqual([42, -72]);
    expect(onFeatureDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        point: expect.objectContaining({
          id: "store-1",
        }),
      }),
      [-72, 42],
    );
  });

  test("drags flat point markers without snapping to an off-center pointer", async () => {
    const onFeatureDragEnd = vi.fn();

    render(
      <PointMap
        draggable
        fitToData={false}
        mapLabel="Offset draggable store points"
        onFeatureDragEnd={onFeatureDragEnd}
        points={[
          {
            id: "store-1",
            label: "Store 1",
            latitude: 40,
            longitude: -74,
          },
        ]}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Offset draggable store points").getAttribute("data-map-ready")).toBe(
        "true",
      );
    });

    const map = flatMock.getMaps()[0];
    const marker = flatMock.getLayerGroups()[0]?.layers[0];
    const [handleMouseDown] = marker?.handlers.get("mousedown") ?? [];

    act(() => {
      handleMouseDown?.({
        latlng: { lat: 40.1, lng: -73.9 },
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
      map?.handlers.get("mousemove")?.[0]?.({
        latlng: { lat: 41, lng: -73 },
      });
      map?.handlers.get("mouseup")?.[0]?.({
        latlng: { lat: 42, lng: -72 },
      });
    });

    expect(marker?.latLng).toEqual([41.9, -72.1]);
    expect(onFeatureDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        point: expect.objectContaining({
          id: "store-1",
        }),
      }),
      [-72.1, 41.9],
    );
  });

  test("renders globe bubble markers without Flat", () => {
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
    expect(map.querySelector(".mb-maps__globe-land path")?.getAttribute("d")).not.toBe("");
    expect(map.querySelector(".mb-maps__globe-country-borders")?.getAttribute("d")).not.toBe("");
    expect(map.querySelector(".mb-maps__globe-rim")).toBeTruthy();
    expect(map.querySelector(".mb-maps__globe-point")).toBeTruthy();
    expect(flatMock.getMaps()).toHaveLength(0);
  });

  test("keeps vector globe basemap non-empty at close zoom", () => {
    const paths = createGlobeBasemapPaths({
      center: [13.405, 52.52],
      zoom: 18,
    });

    expect(paths.landPath).not.toBe("");
    expect(paths.countryBorderPath).not.toBe("");
  });

  test("coalesces globe WebGL rendering into scheduled one-shot frames", () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);

      return callbacks.length;
    });
    const cancelAnimationFrameMock = vi.fn((id: number) => {
      callbacks[id - 1] = () => undefined;
    });
    const renderGlobe = vi.fn();

    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);

    const scheduler = createGlobeRenderScheduler(renderGlobe);

    scheduler.scheduleRender();
    scheduler.scheduleRender();

    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);
    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(1);
    callbacks[1]?.(0);
    expect(renderGlobe).toHaveBeenCalledTimes(1);

    scheduler.scheduleRender();
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(3);
    scheduler.cancel();
    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(3);
  });

  test("selects capped visible globe tiles from a raster map style", () => {
    const source = resolveGlobeTileSource({
      maxZoom: 12,
      tiles: "https://tiles.example.test/{z}/{x}/{y}.png",
    });

    expect(source).toBeTruthy();

    const tiles = getVisibleGlobeTiles(
      {
        center: [13.405, 52.52],
        zoom: 6,
      },
      source!,
    );

    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(48);
    expect(buildGlobeTileUrl(source!, tiles[0]!)).toMatch(
      /^https:\/\/tiles\.example\.test\/\d+\/\d+\/\d+\.png$/,
    );
  });

  test("uses tile globe basemap mode without rendering vector land above it", () => {
    render(
      <BubbleMap
        globeBasemapMode="tiles"
        initialViewState={{ center: [-74, 40], zoom: 5 }}
        mapDisplay="globe"
        mapLabel="Tiled demand globe"
        mapStyle={{ tiles: "https://tiles.example.test/{z}/{x}/{y}.png" }}
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

    const map = screen.getByLabelText("Tiled demand globe");

    expect(map.getAttribute("data-map-ready")).toBe("true");
    expect(map.querySelector(".mb-maps__globe-renderer")).toBeTruthy();
    expect(map.querySelector(".mb-maps__globe-land")).toBeFalsy();
    expect(map.querySelector(".mb-maps__globe-point")).toBeTruthy();
    expect(flatMock.getMaps()).toHaveLength(0);
  });

  test("allows a closer globe zoom", () => {
    expect(getGlobeZoom(GLOBE_MAX_ZOOM - 0.1, -1000)).toBe(GLOBE_MAX_ZOOM);
    expect(getGlobeRadius(18) / getGlobeRadius(17)).toBeCloseTo(2, 5);
  });

  test("aligns globe sphere rotation with projected point coordinates", () => {
    const center: [number, number] = [13.405, 52.52];
    const rotation = getGlobeSphereRotation({ center, zoom: 1.8 });
    const projected = projectGlobeCoordinate(center, { center, zoom: 1.8 });

    expect(rotation.x).toBeCloseTo((center[1] * Math.PI) / 180);
    expect(rotation.y).toBeCloseTo(-((center[0] + 90) * Math.PI) / 180);
    expect(projected.x).toBeCloseTo(480);
    expect(projected.y).toBeCloseTo(240);
  });

  test("aligns vector globe projection with projected point coordinates", () => {
    const center: [number, number] = [13.405, 52.52];
    const viewState = { center, zoom: 1.8 };
    const projected = projectGlobeCoordinate(center, viewState);
    const basemapProjected = projectGlobeBasemapCoordinate(center, viewState);

    expect(basemapProjected?.[0]).toBeCloseTo(projected.x);
    expect(basemapProjected?.[1]).toBeCloseTo(projected.y);
  });

  test("roundtrips WebGL flat Mercator projection", () => {
    const coordinate: [number, number] = [13.405, 52.52];
    const worldPoint = coordinateToWebGlFlatWorldPoint(coordinate, 8);
    const roundtrip = webGlFlatWorldPointToCoordinate(worldPoint, 8);

    expect(roundtrip[0]).toBeCloseTo(coordinate[0], 6);
    expect(roundtrip[1]).toBeCloseTo(coordinate[1], 6);
  });

  test("selects visible WebGL flat raster tiles", () => {
    const source = resolveWebGlFlatTileSource({
      maxZoom: 12,
      tiles: "https://tiles.example.test/{z}/{x}/{y}.png",
    });

    expect(source).toBeTruthy();

    const viewport = getWebGlFlatViewport(
      {
        center: [13.405, 52.52],
        zoom: 6,
      },
      {
        height: 720,
        width: 1280,
      },
    );
    const tiles = getVisibleWebGlFlatTiles(viewport, source!);

    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(256);
    expect(buildWebGlFlatTileUrl(source!, tiles[0]!)).toMatch(
      /^https:\/\/tiles\.example\.test\/\d+\/\d+\/\d+\.png$/,
    );
    expect(viewport.bounds[0]).toBeLessThan(viewport.bounds[2]);
    expect(viewport.bounds[1]).toBeLessThan(viewport.bounds[3]);
  });

  test("pans and zooms WebGL flat view state", () => {
    const initial = { center: [13.405, 52.52] as [number, number], zoom: 6 };
    const panned = panWebGlFlatViewState(initial.center, initial.zoom, 80, -40);

    expect(panned.center[0]).toBeLessThan(initial.center[0]);
    expect(panned.center[1]).toBeLessThan(initial.center[1]);
    expect(getWebGlFlatZoom(4, -1000)).toBeGreaterThan(4);
    expect(getWebGlFlatZoom(4, -1000, 5)).toBe(5);
    expect(
      getWebGlFlatBoundsMinZoom([-25, 34, 35, 66], {
        height: 620,
        width: 960,
      }),
    ).toBeGreaterThan(3);
  });

  test("clamps MapView view state to maxZoom", async () => {
    let controller: import("./map-display").MapSurfaceController | null = null;

    render(
      <MapView
        defaultViewState={{ center: [13.405, 52.52], zoom: 8 }}
        fitToData={false}
        mapLabel="Capped map"
        mapStyle={{ tiles: false }}
        maxZoom={6}
        onMapControllerReady={(nextController) => {
          controller = nextController;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Capped map").getAttribute("data-map-ready")).toBe("true");
      expect(controller?.getViewState().zoom).toBe(6);
    });
  });

  test("constrains MapView to maxBounds and derives a minimum zoom", async () => {
    let controller: import("./map-display").MapSurfaceController | null = null;
    let map:
      | (import("maplibre-gl").Map & {
          getMaxBounds?: () => [[number, number], [number, number]] | null;
          getMinZoom?: () => number;
        })
      | null = null;

    render(
      <MapView
        defaultViewState={{ center: [120, 80], zoom: 1 }}
        fitToData={false}
        mapLabel="Bounded map"
        mapStyle={{ tiles: false }}
        maxBounds={[-25, 34, 35, 66]}
        onMapControllerReady={(nextController) => {
          controller = nextController;
        }}
        onMapReady={(nextMap) => {
          map = nextMap as NonNullable<typeof map>;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Bounded map").getAttribute("data-map-ready")).toBe("true");
      expect(map?.getMaxBounds?.()).toEqual([
        [-25, 34],
        [35, 66],
      ]);
      expect(map?.getMinZoom?.()).toBeGreaterThan(0);
      expect(controller?.getViewState().center).toEqual([35, 66]);
      expect(controller?.getViewState().zoom).toBeGreaterThan(1);
    });
  });

  test("mounts WebGL flat MapView without creating a Flat map", async () => {
    const onViewStateChange = vi.fn();

    render(
      <MapView
        flatRuntime="webgl"
        initialViewState={{ center: [13.405, 52.52], zoom: 6 }}
        mapLabel="WebGL flat map"
        mapStyle={{ tiles: false }}
        onViewStateChange={onViewStateChange}
      />,
    );

    const map = screen.getByLabelText("WebGL flat map");

    await waitFor(() => {
      expect(map.getAttribute("data-map-ready")).toBe("true");
    });

    expect(map.querySelector('[data-flat-runtime="webgl"]')).toBeTruthy();
    expect(flatMock.getMaps()).toHaveLength(0);

    fireEvent.wheel(map.querySelector('[data-flat-runtime="webgl"]')!, {
      deltaY: -120,
    });

    expect(onViewStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        zoom: expect.any(Number),
      }),
      expect.objectContaining({
        display: "flat",
        reason: "zoom",
      }),
    );
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

    const layers = flatMock.getLayerGroups()[0]?.layers ?? [];

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

  test("renders arc flow paths when requested", async () => {
    render(
      <FlowMap
        flowShape="arc"
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
        mapLabel="Curved route flows"
        showAttributionControl={false}
        weightMetric="trips"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Curved route flows").getAttribute("data-map-ready")).toBe("true");
    });

    const polyline = flatMock.getLayerGroups()[0]?.layers.find((layer) => layer.type === "polyline");
    const latLngs = polyline?.latLngs as Array<[number, number]>;

    expect(latLngs).toHaveLength(24);
    expect(latLngs[0]).toEqual([40, -74]);
    expect(latLngs.at(-1)).toEqual([42, -71]);
  });

  test("renders direction arrow markers for flat flows", async () => {
    render(
      <FlowMap
        flowShape="arc"
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
        mapLabel="Directional route flows"
        showAttributionControl={false}
        showDirection
        weightMetric="trips"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Directional route flows").getAttribute("data-map-ready")).toBe("true");
    });

    const marker = flatMock.getLayerGroups()[0]?.layers.find((layer) => layer.type === "marker");

    expect(marker?.options?.icon).toMatchObject({
      options: {
        className: "mb-maps__flow-arrow",
      },
    });
  });

  test("selects flow features from flat flow clicks", async () => {
    const handleFeatureSelect = vi.fn();

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
        mapLabel="Selectable route flows"
        onFeatureSelect={handleFeatureSelect}
        showAttributionControl={false}
        weightMetric="trips"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Selectable route flows").getAttribute("data-map-ready")).toBe("true");
    });

    const polyline = flatMock.getLayerGroups()[0]?.layers.find((layer) => layer.type === "polyline");

    await act(async () => {
      polyline?.handlers.get("click")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(handleFeatureSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: expect.objectContaining({
          id: "nyc-boston",
        }),
      }),
    );
  });

  test("renders flow tooltips on hover", async () => {
    render(
      <FlowMap
        flows={[
          {
            id: "nyc-boston",
            label: "NYC to Boston",
            from: [-74, 40],
            to: [-71, 42],
            metrics: {
              trips: 9,
            },
          },
        ]}
        mapLabel="Tooltip route flows"
        renderFeatureTooltip={(feature) => `${feature.flow.label}: ${feature.rawValue} trips`}
        showAttributionControl={false}
        weightMetric="trips"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Tooltip route flows").getAttribute("data-map-ready")).toBe("true");
    });

    const polyline = flatMock.getLayerGroups()[0]?.layers.find((layer) => layer.type === "polyline");

    await act(async () => {
      polyline?.handlers.get("mouseover")?.[0]?.({ containerPoint: { x: 120, y: 160 } });
    });

    expect(screen.getByText("NYC to Boston: 9 trips")).toBeTruthy();
  });
});
