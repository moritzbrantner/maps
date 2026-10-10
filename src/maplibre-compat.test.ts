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
