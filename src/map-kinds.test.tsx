import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BubbleMap,
  FlowMap,
  GeoJsonMap,
  GeoJsonLayer,
  HeatMap,
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
  type GeoJsonMapSource,
  type MapFlow,
  type MapPoint,
} from ".";
import { getGlobeRadius, getGlobeZoom, GLOBE_MAX_ZOOM } from "./map-display";

const leafletMock = vi.hoisted(() => {
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
    getLayerGroups: () => layerGroups,
    getMaps: () => maps,
    imageOverlay: (_url: string, _bounds: unknown, options: Record<string, unknown>) =>
      createLayer("imageOverlay", undefined, options),
    layerGroup: () => new MockLayerGroup(),
    map: () => new MockMap(),
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

    expect(leafletMock.getLayerGroups()[0]?.layers.map((layer) => layer.type)).toEqual([
      "circleMarker",
      "polyline",
      "polygon",
    ]);
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

    expect(leafletMock.getLayerGroups()[0]?.layers.map((layer) => layer.type)).toEqual([
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

    expect(leafletMock.getLayerGroups()[0]?.layers).toMatchObject([
      {
        options: {
          className: "mb-maps__geojson-feature",
        },
        type: "polygon",
      },
    ]);
    expect(leafletMock.getLayerGroups()[1]?.layers).toMatchObject([
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

    expect(leafletMock.getLayerGroups()[0]?.layers[0]).toMatchObject({
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

    expect(leafletMock.getLayerGroups()[0]?.layers[0]).toMatchObject({
      options: {
        className: "mb-maps__geojson-feature",
      },
      type: "polyline",
    });
    expect(leafletMock.getLayerGroups()[1]?.layers[0]).toMatchObject({
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

    expect(leafletMock.getLayerGroups()[0]?.layers.map((layer) => layer.type)).toEqual([
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

    const marker = leafletMock.getLayerGroups()[0]?.layers[0];
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

    const map = leafletMock.getMaps()[0];
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

    const map = leafletMock.getMaps()[0];
    const marker = leafletMock.getLayerGroups()[0]?.layers[0];
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
