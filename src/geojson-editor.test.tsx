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
  validateGeoJsonEditableGeometry,
  type GeoJsonEditOperation,
  type TemporalGeoJsonGeometryFeatureCollection,
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
