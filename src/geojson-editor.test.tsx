import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  EditableGeoJsonMap,
  GeoJsonEditorLayer,
  GeoJsonLayer,
  MapView,
  applyGeoJsonEditOperation,
  createGeoJsonEditFeature,
  moveGeoJsonGeometry,
  validateGeoJsonEditableGeometry,
  type GeoJsonEditOperation,
  type GeoJsonPosition,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonSupportedGeometry,
} from ".";

const flatMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Layer = {
    handlers: Map<string, Handler[]>;
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

    remove() {}
  }

  class MockMap {
    handlers = new Map<string, Handler[]>();
    zoom = 5;

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

    remove() {}
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
      on(event: string, handler: Handler) {
        const handlers = this.handlers.get(event) ?? [];

        handlers.push(handler);
        this.handlers.set(event, handlers);

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
    map: () => {
      const map = new MockMap();

      maps.push(map);

      return map;
    },
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
});

const emptyCollection: TemporalGeoJsonGeometryFeatureCollection = {
  features: [],
  type: "FeatureCollection",
};

const lineCollection: TemporalGeoJsonGeometryFeatureCollection = {
  features: [
    {
      geometry: {
        coordinates: [
          [0, 0],
          [10, 0],
        ],
        type: "LineString",
      },
      id: "line-1",
      properties: {},
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
};

const twoLineCollection: TemporalGeoJsonGeometryFeatureCollection = {
  features: [
    {
      geometry: {
        coordinates: [
          [0, 0],
          [10, 0],
        ],
        type: "LineString",
      },
      id: "line-1",
      properties: {},
      type: "Feature",
    },
    {
      geometry: {
        coordinates: [
          [20, 1],
          [30, 1],
        ],
        type: "LineString",
      },
      id: "line-2",
      properties: {},
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
};

const groupedLineCollection: TemporalGeoJsonGeometryFeatureCollection = {
  ...twoLineCollection,
  features: twoLineCollection.features.map((feature) => ({
    ...feature,
    properties: {
      groupId: "group-1",
    },
  })),
};

describe("@moritzbrantner/maps GeoJSON editor", () => {
  test("creates a point from a flat map click", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-point"
        fitToData={false}
        geoJson={emptyCollection}
        mapLabel="Point editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Point editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    await waitFor(() => {
      expect(map?.handlers.get("click")?.length).toBeGreaterThan(1);
    });

    act(() => {
      map?.handlers.get("click")?.at(-1)?.({
        latlng: { lat: 52, lng: 13 },
      });
    });

    expect(onFeatureCollectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        features: [
          expect.objectContaining({
            geometry: {
              coordinates: [13, 52],
              type: "Point",
            },
          }),
        ],
      }),
      expect.objectContaining({
        type: "create",
      }),
    );
  });

  test("snaps drawn points to existing vertices", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-point"
        fitToData={false}
        geoJson={lineCollection}
        mapLabel="Snapping point editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        showAttributionControl={false}
        snapOptions={{ enabled: true, modes: ["vertex"] }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Snapping point editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    await waitFor(() => {
      expect(map?.handlers.get("click")?.length).toBeGreaterThan(1);
    });

    act(() => {
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 0.05, lng: 0.05 } });
    });

    await waitFor(() => {
      expect(onFeatureCollectionChange.mock.calls[0]?.[0].features.at(-1)?.geometry).toEqual({
        coordinates: [0, 0],
        type: "Point",
      });
    });
  });

  test("shows a snap indicator for midpoint draft previews and clears it on mouseout", async () => {
    const onSnapTargetChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-line"
        fitToData={false}
        geoJson={lineCollection}
        mapLabel="Snapping draft editor"
        onSnapTargetChange={onSnapTargetChange}
        showAttributionControl={false}
        snapOptions={{ enabled: true, modes: ["midpoint"] }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Snapping draft editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    act(() => {
      map?.handlers.get("mousemove")?.at(-1)?.({ latlng: { lat: 0.02, lng: 5.03 } });
    });

    await waitFor(() => {
      const indicator = flatMock.getLayerGroups()[0]?.layers.find(
        (layer) => layer.options?.className === "mb-maps__editor-snap-indicator",
      );

      expect(indicator?.latLng).toEqual([0, 5]);
      expect(onSnapTargetChange).toHaveBeenCalledWith(expect.objectContaining({
        coordinates: [5, 0],
        mode: "midpoint",
      }));
    });

    act(() => {
      map?.handlers.get("mouseout")?.at(-1)?.({});
    });

    expect(onSnapTargetChange).toHaveBeenLastCalledWith(null);
  });

  test("draws and completes a line with Enter", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-line"
        fitToData={false}
        geoJson={emptyCollection}
        mapLabel="Line editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Line editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    act(() => {
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 1, lng: 2 } });
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 3, lng: 4 } });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    expect(onFeatureCollectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        features: [
          expect.objectContaining({
            geometry: {
              coordinates: [
                [2, 1],
                [4, 3],
              ],
              type: "LineString",
            },
          }),
        ],
      }),
      expect.objectContaining({
        type: "create",
      }),
    );
  });

  test("draws and completes a closed polygon", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-polygon"
        fitToData={false}
        geoJson={emptyCollection}
        mapLabel="Polygon editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Polygon editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    act(() => {
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 0, lng: 0 } });
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 0, lng: 10 } });
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 10, lng: 10 } });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[0].geometry).toEqual({
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 0],
        ],
      ],
      type: "Polygon",
    });
  });

  test("clips moved polygons to a polygon constraint", () => {
    const moved = moveGeoJsonGeometry(
      {
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
      1,
      0,
      {
        polygonConstraint: {
          coordinates: [
            [
              [2, -1],
              [6, -1],
              [6, 5],
              [2, 5],
              [2, -1],
            ],
          ],
          type: "Polygon",
        },
      },
    );

    expect(getGeometryBounds(moved)).toEqual({
      east: 5,
      north: 4,
      south: 0,
      west: 2,
    });
  });

  test("cancels drafts with Escape", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-line"
        fitToData={false}
        geoJson={emptyCollection}
        mapLabel="Cancelable editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Cancelable editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    act(() => {
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 1, lng: 2 } });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    expect(onFeatureCollectionChange).not.toHaveBeenCalled();
  });

  test("previews a point before creating it", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-point"
        fitToData={false}
        geoJson={emptyCollection}
        mapLabel="Point preview editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Point preview editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    act(() => {
      map?.handlers.get("mousemove")?.at(-1)?.({ latlng: { lat: 52, lng: 13 } });
    });

    await waitFor(() => {
      expect(
        flatMock.getLayerGroups()[0]?.layers.some(
          (layer) => layer.options?.className === "mb-maps__editor-draft mb-maps__editor-draft-point",
        ),
      ).toBe(true);
    });
    expect(onFeatureCollectionChange).not.toHaveBeenCalled();
  });

  test("previews the next line segment while drawing", async () => {
    render(
      <EditableGeoJsonMap
        editMode="draw-line"
        fitToData={false}
        geoJson={emptyCollection}
        mapLabel="Line preview editor"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Line preview editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    act(() => {
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 1, lng: 2 } });
      map?.handlers.get("mousemove")?.at(-1)?.({ latlng: { lat: 3, lng: 4 } });
    });

    await waitFor(() => {
      const draftLine = flatMock.getLayerGroups()[0]?.layers.find(
        (layer) => layer.options?.className === "mb-maps__editor-draft",
      );

      expect(draftLine?.latLngs).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });
  });

  test("selects and deletes a feature", async () => {
    const onSelectionChange = vi.fn();
    const onFeatureCollectionChange = vi.fn();

    const { rerender } = render(
      <EditableGeoJsonMap
        editMode="select"
        fitToData={false}
        geoJson={lineCollection}
        mapLabel="Selection editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        onSelectionChange={onSelectionChange}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Selection editor").getAttribute("data-map-ready")).toBe("true");
    });

    const featureLayer = flatMock.getLayerGroups()[0]?.layers[0];

    act(() => {
      featureLayer?.handlers.get("click")?.[0]?.({
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
    });

    expect(onSelectionChange).toHaveBeenCalledWith("line-1");
    expect(featureLayer?.options?.bubblingMouseEvents).toBe(false);

    rerender(
      <EditableGeoJsonMap
        editMode="delete"
        fitToData={false}
        geoJson={lineCollection}
        mapLabel="Selection editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        onSelectionChange={onSelectionChange}
        selectedFeatureId="line-1"
        showAttributionControl={false}
      />,
    );

    const deleteLayer = flatMock.getLayerGroups()[0]?.layers[0];

    act(() => {
      deleteLayer?.handlers.get("click")?.[0]?.({
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
    });

    expect(onFeatureCollectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        features: [],
      }),
      expect.objectContaining({
        type: "delete",
      }),
    );
  });

  test("supports shift-click multi-selection and plain-click reset", async () => {
    const onEditorSelectionChange = vi.fn();

    function SelectionHarness() {
      const [selection, setSelection] = useState({
        featureIds: [] as string[],
        primaryFeatureId: null as string | null,
      });

      return (
        <EditableGeoJsonMap
          editMode="select"
          fitToData={false}
          geoJson={twoLineCollection}
          mapLabel="Multi-selection editor"
          onEditorSelectionChange={(next) => {
            onEditorSelectionChange(next);
            setSelection(next);
          }}
          selection={selection}
          showAttributionControl={false}
        />
      );
    }

    render(<SelectionHarness />);

    await waitFor(() => {
      expect(screen.getByLabelText("Multi-selection editor").getAttribute("data-map-ready")).toBe("true");
    });

    const [firstLayer, secondLayer] = flatMock.getLayerGroups()[0]?.layers ?? [];

    act(() => {
      firstLayer?.handlers.get("click")?.[0]?.({
        originalEvent: { preventDefault() {}, shiftKey: true, stopPropagation() {} },
      });
    });

    await waitFor(() => {
      expect(onEditorSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          featureIds: ["line-1"],
          primaryFeatureId: "line-1",
        }),
      );
    });

    act(() => {
      secondLayer?.handlers.get("click")?.[0]?.({
        originalEvent: { preventDefault() {}, shiftKey: true, stopPropagation() {} },
      });
    });

    expect(onEditorSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        featureIds: ["line-1", "line-2"],
        primaryFeatureId: "line-1",
      }),
    );

    onEditorSelectionChange.mockClear();

    act(() => {
      secondLayer?.handlers.get("click")?.[0]?.({
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
    });

    expect(onEditorSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        featureIds: ["line-2"],
        primaryFeatureId: "line-2",
      }),
    );
  });

  test("groups and ungroups selected features with keyboard commands", async () => {
    const onFeatureCollectionChange = vi.fn();

    const { rerender } = render(
      <EditableGeoJsonMap
        editMode="select"
        fitToData={false}
        geoJson={twoLineCollection}
        mapLabel="Group editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selection={{ featureIds: ["line-1", "line-2"], primaryFeatureId: "line-1" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Group editor").getAttribute("data-map-ready")).toBe("true");
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "g" }));
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        reason: "group-selection",
        type: "batch",
      }),
    );
    expect(
      onFeatureCollectionChange.mock.calls[0]?.[0].features.map(
        (feature: TemporalGeoJsonGeometryFeatureCollection["features"][number]) =>
          feature.properties?.groupId,
      ),
    ).toEqual([expect.stringMatching(/^geojson-group-/), expect.stringMatching(/^geojson-group-/)]);

    onFeatureCollectionChange.mockClear();

    rerender(
      <EditableGeoJsonMap
        editMode="select"
        fitToData={false}
        geoJson={groupedLineCollection}
        mapLabel="Group editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selection={{ featureIds: ["line-1"], primaryFeatureId: "line-1" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Group editor").getAttribute("data-map-ready")).toBe("true");
    });

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { ctrlKey: true, key: "g", shiftKey: true }),
      );
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        reason: "ungroup-selection",
        type: "batch",
      }),
    );
    expect(
      onFeatureCollectionChange.mock.calls[0]?.[0].features.map(
        (feature: TemporalGeoJsonGeometryFeatureCollection["features"][number]) =>
          feature.properties?.groupId,
      ),
    ).toEqual([undefined, undefined]);
  });

  test("delete hotkey deletes all selected features and ignores text inputs", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <>
        <input aria-label="Editor text input" />
        <EditableGeoJsonMap
          editMode="select"
          fitToData={false}
          geoJson={twoLineCollection}
          mapLabel="Delete selection editor"
          onFeatureCollectionChange={onFeatureCollectionChange}
          selection={{ featureIds: ["line-1", "line-2"], primaryFeatureId: "line-1" }}
          showAttributionControl={false}
        />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Delete selection editor").getAttribute("data-map-ready")).toBe("true");
    });

    act(() => {
      screen.getByLabelText("Editor text input").dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }),
      );
    });

    expect(onFeatureCollectionChange).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    });

    expect(onFeatureCollectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        features: [],
      }),
      expect.objectContaining({
        reason: "delete-selection",
        type: "batch",
      }),
    );
  });

  test("moves a selected feature on mouseup", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="move"
        fitToData={false}
        geoJson={lineCollection}
        mapLabel="Move editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selectedFeatureId="line-1"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Move editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];
    const featureLayer = flatMock.getLayerGroups()[0]?.layers[0];

    act(() => {
      featureLayer?.handlers.get("mousedown")?.[0]?.({
        latlng: { lat: 0, lng: 0 },
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
      map?.handlers.get("mouseup")?.[0]?.({
        latlng: { lat: 2, lng: 3 },
      });
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[0].geometry.coordinates).toEqual([
      [3, 2],
      [13, 2],
    ]);
  });

  test("moves all selected features together", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="move"
        fitToData={false}
        geoJson={twoLineCollection}
        mapLabel="Move selection editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selection={{ featureIds: ["line-1", "line-2"], primaryFeatureId: "line-1" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Move selection editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];
    const featureLayer = flatMock.getLayerGroups()[0]?.layers[0];

    act(() => {
      featureLayer?.handlers.get("mousedown")?.[0]?.({
        latlng: { lat: 0, lng: 0 },
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
      map?.handlers.get("mouseup")?.[0]?.({
        latlng: { lat: 2, lng: 3 },
      });
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        reason: "move-selection",
        type: "batch",
      }),
    );
    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[0].geometry.coordinates).toEqual([
      [3, 2],
      [13, 2],
    ]);
    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[1].geometry.coordinates).toEqual([
      [23, 3],
      [33, 3],
    ]);
  });

  test("renders reshape handles only for the primary selected feature", async () => {
    render(
      <EditableGeoJsonMap
        editMode="reshape"
        fitToData={false}
        geoJson={twoLineCollection}
        mapLabel="Primary reshape editor"
        selection={{ featureIds: ["line-1", "line-2"], primaryFeatureId: "line-2" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Primary reshape editor").getAttribute("data-map-ready")).toBe("true");
    });

    expect(
      flatMock
        .getLayerGroups()[0]
        ?.layers.filter((layer) =>
          String(layer.options?.className ?? "").includes("mb-maps__editor-handle"),
        ),
    ).toHaveLength(3);
  });

  test("inserts a midpoint vertex and prevents invalid vertex removal", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="reshape"
        fitToData={false}
        geoJson={lineCollection}
        mapLabel="Reshape editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selectedFeatureId="line-1"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Reshape editor").getAttribute("data-map-ready")).toBe("true");
    });

    const midpointHandle = flatMock.getLayerGroups()[0]?.layers.find(
      (layer) => layer.options?.className === "mb-maps__editor-handle mb-maps__editor-handle--midpoint",
    );

    act(() => {
      midpointHandle?.handlers.get("click")?.[0]?.({
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[0].geometry.coordinates).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);

    const vertexHandle = flatMock.getLayerGroups()[0]?.layers.find(
      (layer) => layer.options?.className === "mb-maps__editor-handle",
    );

    act(() => {
      vertexHandle?.handlers.get("click")?.[0]?.({
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
    });

    expect(onFeatureCollectionChange).toHaveBeenCalledTimes(1);
  });

  test("moves a line vertex in reshape mode", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="reshape"
        fitToData={false}
        geoJson={lineCollection}
        mapLabel="Vertex move editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selectedFeatureId="line-1"
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Vertex move editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];
    const vertexHandle = flatMock.getLayerGroups()[0]?.layers.find(
      (layer) => layer.options?.className === "mb-maps__editor-handle",
    );

    act(() => {
      vertexHandle?.handlers.get("mousedown")?.[0]?.({
        latlng: { lat: 0, lng: 0 },
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
      map?.handlers.get("mouseup")?.[0]?.({
        latlng: { lat: 5, lng: 6 },
      });
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[0].geometry.coordinates).toEqual([
      [6, 5],
      [10, 0],
    ]);
    expect(onFeatureCollectionChange.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        reason: "move-vertex",
        type: "update",
      }),
    );
  });

  test("snaps moved vertices to nearby vertices", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="reshape"
        fitToData={false}
        geoJson={twoLineCollection}
        mapLabel="Snapping vertex editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selectedFeatureId="line-1"
        showAttributionControl={false}
        snapOptions={{ enabled: true, includeSelectedFeature: false, modes: ["vertex"] }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Snapping vertex editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];
    const vertexHandle = flatMock.getLayerGroups()[0]?.layers.find(
      (layer) => layer.options?.className === "mb-maps__editor-handle",
    );

    act(() => {
      vertexHandle?.handlers.get("mousedown")?.[0]?.({
        latlng: { lat: 0, lng: 0 },
        originalEvent: { preventDefault() {}, stopPropagation() {} },
      });
      map?.handlers.get("mouseup")?.[0]?.({
        latlng: { lat: 1.02, lng: 20.03 },
      });
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[0].geometry.coordinates).toEqual([
      [20, 1],
      [10, 0],
    ]);
  });

  test("snaps drawn points to a degree grid when enabled", async () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-point"
        fitToData={false}
        geoJson={emptyCollection}
        mapLabel="Grid snapping editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        showAttributionControl={false}
        snapOptions={{ enabled: true, gridSizeDegrees: 1, modes: ["grid"] }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Grid snapping editor").getAttribute("data-map-ready")).toBe("true");
    });

    const map = flatMock.getMaps()[0];

    act(() => {
      map?.handlers.get("click")?.at(-1)?.({ latlng: { lat: 0.4, lng: 0.6 } });
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features[0].geometry).toEqual({
      coordinates: [1, 0],
      type: "Point",
    });
  });

  test("union mode replaces selected polygons with one result and emits a batch operation", async () => {
    const onFeatureCollectionChange = vi.fn();
    const source = polygonCollection([
      ["a", squareRing(0, 0, 1, 1)],
      ["b", squareRing(1, 0, 2, 1)],
    ]);

    render(
      <EditableGeoJsonMap
        editMode="boolean-union"
        fitToData={false}
        geoJson={source}
        mapLabel="Boolean union editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selection={{ featureIds: ["a", "b"], primaryFeatureId: "a" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Boolean union editor").getAttribute("data-map-ready")).toBe("true");
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    expect(onFeatureCollectionChange.mock.calls[0]?.[0].features).toHaveLength(1);
    expect(onFeatureCollectionChange.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        reason: "boolean-union",
        type: "batch",
      }),
    );
  });

  test("intersection mode produces geometry through an undo-compatible batch operation", async () => {
    const onFeatureCollectionChange = vi.fn();
    const source = polygonCollection([
      ["a", squareRing(0, 0, 2, 2)],
      ["b", squareRing(1, 1, 3, 3)],
    ]);

    render(
      <EditableGeoJsonMap
        editMode="boolean-intersection"
        fitToData={false}
        geoJson={source}
        mapLabel="Boolean intersection editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selection={{ featureIds: ["a", "b"], primaryFeatureId: "a" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Boolean intersection editor").getAttribute("data-map-ready")).toBe("true");
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    const [next, operation] = onFeatureCollectionChange.mock.calls[0] ?? [];

    expect(next.features[0].properties.area).toBe(1);
    expect(operation).toEqual(expect.objectContaining({ reason: "boolean-intersection", type: "batch" }));
    expect(applyGeoJsonEditOperation(source, operation)).toEqual(next);
  });

  test("difference mode subtracts masks from the subject", async () => {
    const onFeatureCollectionChange = vi.fn();
    const source = polygonCollection([
      ["subject", squareRing(0, 0, 4, 4)],
      ["mask", squareRing(1, 1, 3, 3)],
    ]);

    render(
      <EditableGeoJsonMap
        editMode="boolean-difference"
        fitToData={false}
        geoJson={source}
        mapLabel="Boolean difference editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selection={{ featureIds: ["subject", "mask"], primaryFeatureId: "subject" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Boolean difference editor").getAttribute("data-map-ready")).toBe("true");
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    const next = onFeatureCollectionChange.mock.calls[0]?.[0];

    expect(next.features).toHaveLength(1);
    expect(next.features[0].id).toBe("subject");
    expect(next.features[0].properties.area).toBe(12);
    expect(onFeatureCollectionChange.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ reason: "boolean-difference", type: "batch" }),
    );
  });

  test("empty boolean results leave the collection unchanged", async () => {
    const onFeatureCollectionChange = vi.fn();
    const source = polygonCollection([
      ["a", squareRing(0, 0, 1, 1)],
      ["b", squareRing(2, 2, 3, 3)],
    ]);

    render(
      <EditableGeoJsonMap
        editMode="boolean-intersection"
        fitToData={false}
        geoJson={source}
        mapLabel="Empty boolean editor"
        onFeatureCollectionChange={onFeatureCollectionChange}
        selection={{ featureIds: ["a", "b"], primaryFeatureId: "a" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Empty boolean editor").getAttribute("data-map-ready")).toBe("true");
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });

    expect(onFeatureCollectionChange).not.toHaveBeenCalled();
  });

  test("boolean preview callback receives a result and clears when invalid", async () => {
    const onBooleanOperationPreviewChange = vi.fn();
    const source = polygonCollection([
      ["a", squareRing(0, 0, 1, 1)],
      ["b", squareRing(1, 0, 2, 1)],
    ]);

    const { rerender } = render(
      <EditableGeoJsonMap
        editMode="boolean-union"
        fitToData={false}
        geoJson={source}
        mapLabel="Boolean preview editor"
        onBooleanOperationPreviewChange={onBooleanOperationPreviewChange}
        selection={{ featureIds: ["a", "b"], primaryFeatureId: "a" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Boolean preview editor").getAttribute("data-map-ready")).toBe("true");
    });
    await waitFor(() => {
      expect(onBooleanOperationPreviewChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "FeatureCollection" }),
      );
    });

    rerender(
      <EditableGeoJsonMap
        editMode="boolean-union"
        fitToData={false}
        geoJson={source}
        mapLabel="Boolean preview editor"
        onBooleanOperationPreviewChange={onBooleanOperationPreviewChange}
        selection={{ featureIds: ["a"], primaryFeatureId: "a" }}
        showAttributionControl={false}
      />,
    );

    await waitFor(() => {
      expect(onBooleanOperationPreviewChange).toHaveBeenLastCalledWith(null);
    });
  });

  test("rejects invalid editable geometries", () => {
    expect(
      validateGeoJsonEditableGeometry({
        coordinates: [[1, 1]],
        type: "LineString",
      }),
    ).toEqual({
      reason: "Unsupported or malformed geometry.",
      valid: false,
    });
  });

  test("does not mutate source collections when applying operations", () => {
    const source = lineCollection;
    const feature = createGeoJsonEditFeature("Point", [1, 2], {});
    const operation: GeoJsonEditOperation = {
      feature: {
        ...feature,
        id: "point-1",
      },
      featureId: "point-1",
      type: "create",
    };

    const next = applyGeoJsonEditOperation(source, operation);

    expect(next.features).toHaveLength(2);
    expect(source.features).toHaveLength(1);
    expect(next.features[0]).not.toBe(source.features[0]);
  });

  test("suppresses display GeoJSON interactions while editing is active", async () => {
    render(
      <MapView fitToData={false} mapLabel="Composed editor" showAttributionControl={false}>
        <GeoJsonLayer featureCollection={lineCollection} />
        <GeoJsonEditorLayer featureCollection={lineCollection} mode="select" />
      </MapView>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Composed editor").getAttribute("data-map-ready")).toBe("true");
    });

    await waitFor(() => {
      expect(flatMock.getLayerGroups()[0]?.layers[0]?.options?.interactive).toBe(false);
    });
  });

  test("renders nothing and emits no edits on globe maps", () => {
    const onFeatureCollectionChange = vi.fn();

    render(
      <EditableGeoJsonMap
        editMode="draw-point"
        geoJson={emptyCollection}
        mapDisplay="globe"
        onFeatureCollectionChange={onFeatureCollectionChange}
      />,
    );

    expect(flatMock.getMaps()).toHaveLength(0);
    expect(onFeatureCollectionChange).not.toHaveBeenCalled();
  });
});

function polygonCollection(
  items: Array<[id: string, ring: GeoJsonPosition[]]>,
): TemporalGeoJsonGeometryFeatureCollection {
  return {
    features: items.map(([id, ring]) => ({
      geometry: {
        coordinates: [ring],
        type: "Polygon" as const,
      },
      id,
      properties: {},
      type: "Feature" as const,
    })),
    type: "FeatureCollection",
  };
}

function squareRing(minX: number, minY: number, maxX: number, maxY: number): GeoJsonPosition[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

function getGeometryBounds(geometry: TemporalGeoJsonSupportedGeometry | null) {
  expect(geometry).not.toBeNull();

  const positions =
    geometry?.type === "Polygon"
      ? geometry.coordinates.flat()
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates.flat(2)
        : [];

  return positions.reduce(
    (bounds, position) => ({
      east: Math.max(bounds.east, position[0]),
      north: Math.max(bounds.north, position[1]),
      south: Math.min(bounds.south, position[1]),
      west: Math.min(bounds.west, position[0]),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
}
