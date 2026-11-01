import { describe, expect, test } from "vitest";

import {
  createMapLibreFlatLayerFactory,
  type FlatCircleCollectionFeature,
  type FlatPointerEvent,
  removeMapLibreLayerIfExists,
  removeMapLibreSourceIfExists,
  resolveMapLibreMarkerOffset,
} from "./maplibre-compat";

describe("@moritzbrantner/maps maplibre compatibility", () => {
  test("centers Leaflet-style div icons when the anchor is in the middle", () => {
    expect(resolveMapLibreMarkerOffset({ iconAnchor: [18, 18], iconSize: [36, 36] })).toEqual([
      0,
      0,
    ]);
  });

  test("converts Leaflet-style div icon anchors to MapLibre center offsets", () => {
    expect(resolveMapLibreMarkerOffset({ iconAnchor: [10, 16], iconSize: [24, 32] })).toEqual([
      2,
      0,
    ]);
  });

  test("creates empty DOM markers by default", () => {
    const markers: TestMarker[] = [];
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre(markers),
      createTestMap() as unknown as import("maplibre-gl").Map,
    );
    const group = createTestLayerGroup();

    factory.marker([52.52, 13.405]).addTo(group as never);

    expect(markers).toHaveLength(1);
    expect(markers[0]?.element.className).toBe("mb-maps__marker");
    expect(markers[0]?.element.childElementCount).toBe(0);
    expect(markers[0]?.element.textContent).toBe("");
  });

  test("keeps marker icon HTML on the documented trusted-markup path", () => {
    const markers: TestMarker[] = [];
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre(markers),
      createTestMap() as unknown as import("maplibre-gl").Map,
    );
    const group = createTestLayerGroup();

    factory
      .marker([52.52, 13.405], {
        icon: {
          className: "custom-marker",
          html: "<span data-marker=\"trusted\">B</span>",
          iconAnchor: [12, 24],
          iconSize: [24, 24],
        },
        opacity: 0.5,
      })
      .addTo(group as never);

    expect(markers).toHaveLength(1);
    expect(markers[0]?.element.className).toBe("custom-marker");
    expect(markers[0]?.element.querySelector("[data-marker='trusted']")?.textContent).toBe("B");
    expect(markers[0]?.element.style.opacity).toBe("0.5");
    expect(markers[0]?.options.offset).toEqual([0, -12]);
  });

  test("draws a circle collection as one GeoJSON source and one circle layer", () => {
    const map = createCollectionTestMap();
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre([]),
      map as unknown as import("maplibre-gl").Map,
    );
    const features = createCollectionFeatures(1_000);
    const collection = factory.circleCollection(features);

    collection.addTo(createTestLayerGroup() as never);

    expect(map.sources.size).toBe(1);
    expect(map.layers.size).toBe(1);
    const [source] = map.sources.values();
    expect(source?.promoteId).toBe("key");
    expect(source?.data.features).toHaveLength(1_000);
    expect(source?.data.features[3]?.properties.key).toBe("p-3");

    // Unchanged circles do not re-send the source data; changed ones do, once.
    collection.setFeatures(createCollectionFeatures(1_000));
    expect(source?.setDataCalls).toBe(0);
    collection.setFeatures(createCollectionFeatures(10));
    expect(source?.setDataCalls).toBe(1);
    expect(source?.data.features).toHaveLength(10);
    expect(map.layers.size).toBe(1);

    collection.remove?.();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.handlerCount()).toBe(0);
  });

  test("hit-tests circle collection pointer events per circle", () => {
    const map = createCollectionTestMap();
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre([]),
      map as unknown as import("maplibre-gl").Map,
    );
    const collection = factory.circleCollection(createCollectionFeatures(3));
    const events: string[] = [];
    const record = (name: string) => (event?: FlatPointerEvent) =>
      events.push(`${name}:${event?.featureKey}`);

    collection
      .on("click", record("click"))
      .on("contextmenu", record("contextmenu"))
      .on("mouseover", record("over"))
      .on("mouseout", record("out"));
    collection.addTo(createTestLayerGroup() as never);

    // Circles sit at x = 10 * index (projected); the nearest hit wins.
    map.fire("click", { point: { x: 11, y: 0 } });
    map.fire("contextmenu", { point: { x: 19, y: 0 } });
    map.fire("click", { point: { x: 200, y: 0 } });
    map.fire("mousemove", { point: { x: 0, y: 0 } });
    map.fire("mousemove", { point: { x: 1, y: 0 } });
    map.fire("mousemove", { point: { x: 20, y: 0 } });
    map.fire("mousemove", { point: { x: 200, y: 0 } });
    map.fire("mousemove", { point: { x: 10, y: 0 } });
    map.fire("mouseout", { point: { x: -1, y: -1 } });

    expect(events).toEqual([
      "click:p-1",
      "contextmenu:p-2",
      "over:p-0",
      "out:p-0",
      "over:p-2",
      "out:p-2",
      "over:p-1",
      "out:p-1",
    ]);

    // Hover is feature state on the shared source, cleared when it moves.
    collection.setHoveredKey("p-1");
    collection.setHoveredKey("p-2");
    expect(map.featureStates).toEqual([
      ["p-1", true],
      ["p-1", false],
      ["p-2", true],
    ]);
  });

  test("leaves a circle under a resting pointer when it is removed from the collection", () => {
    const map = createCollectionTestMap();
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre([]),
      map as unknown as import("maplibre-gl").Map,
    );
    const collection = factory.circleCollection(createCollectionFeatures(3));
    const events: string[] = [];
    const record = (name: string) => (event?: FlatPointerEvent) =>
      events.push(`${name}:${event?.featureKey}`);

    collection.on("mouseover", record("over")).on("mouseout", record("out"));
    collection.addTo(createTestLayerGroup() as never);

    map.fire("mousemove", { point: { x: 20, y: 0 } });
    // p-2 disappears while the pointer rests on it.
    collection.setFeatures(createCollectionFeatures(2));
    // The pointer moves within the now empty spot: nothing to leave again.
    map.fire("mousemove", { point: { x: 21, y: 0 } });
    // Hovering p-1, then the whole collection goes away.
    map.fire("mousemove", { point: { x: 10, y: 0 } });
    collection.remove?.();

    expect(events).toEqual(["over:p-2", "out:p-2", "over:p-1", "out:p-1"]);
  });

  test("draws a group's lines and polygons as one source per kind with data-driven paint", async () => {
    const map = createShapeTestMap();
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre([]),
      map as unknown as import("maplibre-gl").Map,
    );
    const group = createTestLayerGroup();
    const lines = Array.from({ length: 300 }, (_, index) =>
      factory
        .polyline(
          [
            [0, index],
            [1, index],
          ],
          { color: index % 2 ? "#ff0000" : "#0000ff", weight: index },
        )
        .addTo(group as never),
    );
    const polygon = factory
      .polygon([
        [0, 0],
        [1, 0],
        [1, 1],
      ])
      .addTo(group as never);

    await Promise.resolve();

    expect([...map.layers.values()].map((layer) => layer.type)).toEqual(["line", "fill", "line"]);
    expect(map.sources.size).toBe(2);
    const [lineSource, polygonSource] = map.sources.values();
    expect(lineSource?.setDataCalls).toBe(1);
    expect(lineSource?.data.features).toHaveLength(300);
    expect(lineSource?.data.features[3]?.properties).toMatchObject({ color: "#ff0000", weight: 3 });
    expect(polygonSource?.data.features[0]?.geometry.type).toBe("Polygon");

    // Restyling is feature-state: no source data is re-sent.
    const key = String(lineSource?.data.features[5]?.properties.key);
    lines[5]?.setStyle?.({ color: "#00ff00", weight: 9 });
    await Promise.resolve();
    expect(lineSource?.setDataCalls).toBe(1);
    expect(map.featureStates.at(-1)).toEqual([key, expect.objectContaining({ color: "#00ff00", weight: 9 })]);

    for (const line of lines) line.remove?.();
    polygon.remove?.();
    await Promise.resolve();
    expect(map.layers.size).toBe(0);
    expect(map.sources.size).toBe(0);
    expect(map.handlerCount()).toBe(0);
  });

  test("draws dashed lines in a batch per dash array and cap with constant layout (#322)", async () => {
    const map = createShapeTestMap();
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre([]),
      map as unknown as import("maplibre-gl").Map,
    );
    const group = createTestLayerGroup();
    const latLngs: [number, number][] = [
      [0, 0],
      [1, 1],
    ];
    factory.polyline(latLngs, { lineCap: "square", lineJoin: "bevel" }).addTo(group as never);
    const dashed = factory
      .polyline(latLngs, { lineCap: "round", lineDasharray: [0.5, 2] })
      .addTo(group as never);
    factory.polyline(latLngs, { lineCap: "round", lineDasharray: [0.5, 2] }).addTo(group as never);
    await Promise.resolve();

    const layers = [...map.layers.values()] as Array<{
      layout?: Record<string, unknown>;
      paint?: Record<string, unknown>;
    }>;
    expect(layers).toHaveLength(2);
    expect(layers[0]?.paint?.["line-dasharray"]).toBeUndefined();
    expect(layers[1]?.layout?.["line-cap"]).toBe("round");
    expect(layers[1]?.paint?.["line-dasharray"]).toEqual([0.5, 2]);
    const [solidSource, dashedSource] = map.sources.values();
    expect(solidSource?.data.features[0]?.properties).toMatchObject({ lineCap: "square", lineJoin: "bevel" });
    expect(dashedSource?.data.features).toHaveLength(2);

    // A line whose dashes change moves to the batch of its new dash array.
    dashed.setStyle?.({ lineDasharray: [] });
    await Promise.resolve();
    expect(solidSource?.data.features).toHaveLength(2);
    expect(dashedSource?.data.features).toHaveLength(1);
  });

  test("dispatches batched shape pointer events to the topmost feature that listens", async () => {
    const map = createShapeTestMap();
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre([]),
      map as unknown as import("maplibre-gl").Map,
    );
    const group = createTestLayerGroup();
    const events: string[] = [];
    const record = (name: string) => () => events.push(name);
    const latLngs: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];

    factory
      .polyline(latLngs)
      .on("click", record("a:click"))
      .on("mouseover", record("a:over"))
      .on("mouseout", record("a:out"))
      .addTo(group as never);
    factory.polyline(latLngs, { interactive: false }).addTo(group as never);
    factory.polyline(latLngs).on("click", record("c:click")).addTo(group as never);
    await Promise.resolve();

    const [layerId] = map.layers.keys();
    const [a, b, c] = [...map.sources.values()][0]!.data.features.map((feature) => ({
      properties: { key: feature.properties.key },
    }));

    // Topmost first, as `queryRenderedFeatures` reports them; `b` does not listen.
    map.fireLayer("click", layerId!, { features: [b, a] });
    map.fireLayer("click", layerId!, { features: [c, b, a] });
    map.fireLayer("mouseenter", layerId!, { features: [b, a] });
    map.fireLayer("mousemove", layerId!, { features: [a] });
    map.fireLayer("mouseleave", layerId!, {});

    expect(events).toEqual(["a:click", "c:click", "a:over", "a:out"]);
  });

  test("ignores cleanup when MapLibre internals are already disposed", () => {
    const disposedMap = {
      getLayer() {
        throw new TypeError("Cannot read properties of undefined (reading 'getLayer')");
      },
      getSource() {
        throw new TypeError("Cannot read properties of undefined (reading 'getSource')");
      },
      removeLayer() {
        throw new Error("removeLayer should not be called");
      },
      removeSource() {
        throw new Error("removeSource should not be called");
      },
    } as unknown as import("maplibre-gl").Map;

    expect(() => removeMapLibreLayerIfExists(disposedMap, "heat-layer:surface")).not.toThrow();
    expect(() => removeMapLibreSourceIfExists(disposedMap, "heat-layer:surface")).not.toThrow();
  });
});

type TestMap = {
  __mbAddFlatMarker: (coordinates: [number, number], options: unknown) => void;
};

type TestLayerGroup = {
  addLayer: () => TestLayerGroup;
  addTo: () => TestLayerGroup;
  clearLayers: () => TestLayerGroup;
  layers: unknown[];
  remove: () => void;
  removeLayer: () => TestLayerGroup;
};

type TestMarkerOptions = {
  element: HTMLElement;
  offset?: [number, number];
};

class TestMarker {
  element: HTMLElement;
  options: TestMarkerOptions;

  constructor(options: TestMarkerOptions) {
    this.element = options.element;
    this.options = options;
  }

  setLngLat() {
    return this;
  }

  addTo() {
    return this;
  }

  remove() {}
}

function createTestMap(): TestMap {
  return {
    __mbAddFlatMarker() {},
  };
}

function createTestMapLibre(markers: TestMarker[]) {
  return {
    Marker: class extends TestMarker {
      constructor(options: TestMarkerOptions) {
        super(options);
        markers.push(this);
      }
    },
  } as unknown as typeof import("maplibre-gl");
}

function createTestLayerGroup(): TestLayerGroup {
  const group: TestLayerGroup = {
    addLayer: () => group,
    addTo: () => group,
    clearLayers: () => group,
    layers: [],
    remove() {},
    removeLayer: () => group,
  };

  return group;
}

function createCollectionFeatures(count: number): FlatCircleCollectionFeature[] {
  return Array.from({ length: count }, (_, index) => ({
    fillColor: "#0f172a",
    key: `p-${index}`,
    latLng: [0, index],
    radius: 6,
    weight: 2,
  }));
}

type CollectionTestSource = {
  data: { features: Array<{ geometry: { coordinates: [number, number] }; properties: { key: string } }> };
  promoteId?: string;
  setData: (data: CollectionTestSource["data"]) => void;
  setDataCalls: number;
};

type ShapeTestSource = {
  data: {
    features: Array<{ geometry: { type: string }; properties: Record<string, unknown> & { key: string } }>;
  };
  setData: (data: ShapeTestSource["data"]) => void;
  setDataCalls: number;
};

/** A map double recording sources, layers, feature-state and layer-scoped handlers. */
function createShapeTestMap() {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const sources = new Map<string, ShapeTestSource>();
  const layers = new Map<string, { source: string; type: string }>();
  const featureStates: Array<[string, Record<string, unknown>]> = [];
  const handlerKey = (event: string, layerId?: string) => (layerId ? `${event}@${layerId}` : event);
  const split = (args: unknown[]) =>
    [args.length === 2 ? (args[0] as string) : undefined, args.at(-1) as (event: unknown) => void] as const;

  return {
    featureStates,
    layers,
    sources,
    addLayer(layer: { id: string; source: string; type: string }) {
      layers.set(layer.id, layer);
    },
    addSource(id: string, spec: { data: ShapeTestSource["data"] }) {
      const source: ShapeTestSource = {
        data: spec.data,
        setData(data) {
          source.data = data;
          source.setDataCalls += 1;
        },
        setDataCalls: 0,
      };
      sources.set(id, source);
    },
    fireLayer(event: string, layerId: string, payload: unknown) {
      for (const handler of handlers.get(handlerKey(event, layerId)) ?? []) handler(payload);
    },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => sources.get(id),
    handlerCount: () => [...handlers.values()].reduce((total, set) => total + set.size, 0),
    off(event: string, ...args: unknown[]) {
      const [layerId, handler] = split(args);
      handlers.get(handlerKey(event, layerId))?.delete(handler);
    },
    on(event: string, ...args: unknown[]) {
      const [layerId, handler] = split(args);
      const key = handlerKey(event, layerId);
      if (!handlers.has(key)) handlers.set(key, new Set());
      handlers.get(key)!.add(handler);
    },
    queryRenderedFeatures: () => [],
    removeLayer(id: string) {
      layers.delete(id);
    },
    removeSource(id: string) {
      sources.delete(id);
    },
    setFeatureState(target: { id: string }, state: Record<string, unknown>) {
      featureStates.push([target.id, state]);
    },
  };
}

/** A map double that projects longitude `n` to x = 10n and hit-tests circles of radius 6. */
function createCollectionTestMap() {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const sources = new Map<string, CollectionTestSource>();
  const layers = new Map<string, { source: string }>();
  const featureStates: Array<[string, boolean]> = [];
  const project = ([longitude]: [number, number]) => ({ x: longitude * 10, y: 0 });

  return {
    featureStates,
    layers,
    sources,
    addLayer(layer: { id: string; source: string }) {
      layers.set(layer.id, layer);
    },
    addSource(id: string, spec: { data: CollectionTestSource["data"]; promoteId?: string }) {
      const source: CollectionTestSource = {
        data: spec.data,
        promoteId: spec.promoteId,
        setData(data) {
          source.data = data;
          source.setDataCalls += 1;
        },
        setDataCalls: 0,
      };
      sources.set(id, source);
    },
    fire(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => sources.get(id),
    handlerCount: () => [...handlers.values()].reduce((total, set) => total + set.size, 0),
    off(event: string, handler: (event: unknown) => void) {
      handlers.get(event)?.delete(handler);
    },
    on(event: string, handler: (event: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    project,
    queryRenderedFeatures(
      geometry: [number, number] | [[number, number], [number, number]],
      options: { layers: string[] },
    ) {
      const [min, max] =
        typeof geometry[0] === "number"
          ? [geometry as [number, number], geometry as [number, number]]
          : (geometry as [[number, number], [number, number]]);
      return options.layers.flatMap((layerId) => {
        const source = sources.get(layers.get(layerId)?.source ?? "");
        return (source?.data.features ?? []).filter((feature) => {
          const point = project(feature.geometry.coordinates);
          // A circle of radius 6 intersects the query box.
          const dx = Math.max(min[0] - point.x, 0, point.x - max[0]);
          const dy = Math.max(min[1] - point.y, 0, point.y - max[1]);
          return Math.hypot(dx, dy) <= 6;
        });
      });
    },
    removeLayer(id: string) {
      layers.delete(id);
    },
    removeSource(id: string) {
      sources.delete(id);
    },
    setFeatureState(target: { id: string }, state: { hovered: boolean }) {
      featureStates.push([target.id, state.hovered]);
    },
  };
}
