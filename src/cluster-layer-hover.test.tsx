import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  resetMapsAggregationRuntimeForTests,
  setMapsAggregationWasmRuntimeForTests,
} from "./aggregation-runtime";
import { ClusterLayer } from "./cluster-layer";
import { MapSurfaceContext, type MapSurfaceContextValue } from "./map-surface-context";
import { createMapLibreFlatLayerFactory, type FlatLayerGroup } from "./maplibre-compat";
import { createGridAggregationRuntimeForTests } from "./test-aggregation-runtime";

// #219 review: a removed MapLibre layer never fires a pointer leave, so ClusterLayer must clear
// the hover (cursor, tooltip, hovered feature) itself when a hovered feature's layer goes away.

afterEach(() => {
  resetMapsAggregationRuntimeForTests();
});

const POINTS = [
  { id: "a", label: "A", latitude: 0, longitude: 0 },
  { id: "b", label: "B", latitude: 0, longitude: 40 },
];

describe("ClusterLayer hover cleanup", () => {
  test("clears the fallback hover when the runtime leaves `unavailable` under a resting pointer", async () => {
    setMapsAggregationWasmRuntimeForTests(null);
    const harness = createSurfaceHarness();

    render(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer points={POINTS} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    // The unclustered fallback is one source and one circle layer.
    expect(harness.map.layers.size).toBe(1);

    act(() => harness.map.fire("mousemove", { point: { x: 0, y: 0 } }));
    expect(harness.hoverCalls.at(-1)).toBe("a");
    expect(harness.map.container.style.cursor).toBe("pointer");

    await act(async () => {
      setMapsAggregationWasmRuntimeForTests(createGridAggregationRuntimeForTests());
    });

    expect(harness.hoverCalls.at(-1)).toBeNull();
    expect(harness.map.container.style.cursor).toBe("");
  });

  test("clears the hover of a per-feature entry that leaves the frame", async () => {
    setMapsAggregationWasmRuntimeForTests(createGridAggregationRuntimeForTests());
    const harness = createSurfaceHarness({ hoveredId: "a" });
    const view = render(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer points={POINTS} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});
    expect(harness.hoverCalls).toEqual([]);

    view.rerender(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer points={POINTS.slice(1)} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    expect(harness.hoverCalls).toEqual([null]);
    expect(harness.map.container.style.cursor).toBe("");
  });
});

function createSurfaceHarness({ hoveredId = null }: { hoveredId?: string | null } = {}) {
  const map = createTestMap();
  const flat = createMapLibreFlatLayerFactory(
    { Marker: TestMarker } as unknown as typeof import("maplibre-gl"),
    map as unknown as import("maplibre-gl").Map,
  );
  const groups = new Map<string, FlatLayerGroup>();
  const hoverCalls: Array<string | null> = [];
  const featureId = (feature: unknown) =>
    (feature as { point?: { id?: string } }).point?.id ?? null;

  const surface = {
    display: "flat",
    handleFeatureHover: vi.fn((feature: unknown) => {
      hoverCalls.push(feature ? featureId(feature) : null);
    }),
    isFeatureHovered: (feature: unknown) => hoveredId !== null && featureId(feature) === hoveredId,
    isFeatureSelected: () => false,
    registerMapLibreLayer: (id: string, renderLayer: (context: unknown) => void) => {
      let group = groups.get(id);

      if (!group) {
        group = flat.layerGroup();
        groups.set(id, group);
      }

      renderLayer({
        flat,
        interactionMode: "none",
        isMeasuring: false,
        layer: group,
        map,
        maplibre: {},
        maplibreMap: map,
      });

      return () => {};
    },
  } as unknown as MapSurfaceContextValue;

  return { hoverCalls, map, surface };
}

class TestMarker {
  setLngLat() {
    return this;
  }

  addTo() {
    return this;
  }

  remove() {}
}

/** A MapLibre map double that projects longitude `n` to x = 10n; circles have radius 6. */
function createTestMap() {
  type Source = { data: { features?: Array<{ geometry: { coordinates: [number, number] }; properties: { key: string } }> }; setData: (data: Source["data"]) => void };
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const sources = new Map<string, Source>();
  const layers = new Map<string, { source: string }>();
  const container = document.createElement("div");
  const project = ([longitude]: [number, number]) => ({ x: longitude * 10, y: 0 });

  return {
    container,
    layers,
    addLayer(layer: { id: string; source: string }) {
      layers.set(layer.id, layer);
    },
    addSource(id: string, spec: { data: Source["data"] }) {
      const source: Source = {
        data: spec.data,
        setData(data) {
          source.data = data;
        },
      };
      sources.set(id, source);
    },
    fire(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    getBounds: () => ({
      getEast: () => 180,
      getNorth: () => 85,
      getSouth: () => -85,
      getWest: () => -180,
    }),
    getContainer: () => container,
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => sources.get(id),
    getZoom: () => 4,
    off(event: string, ...args: unknown[]) {
      handlers.get(event)?.delete(args.at(-1) as (event: unknown) => void);
    },
    on(event: string, ...args: unknown[]) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(args.at(-1) as (event: unknown) => void);
    },
    project,
    queryRenderedFeatures(geometry: [number, number], options: { layers: string[] }) {
      return options.layers.flatMap((layerId) =>
        (sources.get(layers.get(layerId)?.source ?? "")?.data.features ?? []).filter((feature) => {
          const point = project(feature.geometry.coordinates);
          return Math.hypot(point.x - geometry[0], point.y - geometry[1]) <= 6;
        }),
      );
    },
    removeLayer(id: string) {
      layers.delete(id);
    },
    removeSource(id: string) {
      sources.delete(id);
    },
    setFeatureState() {},
    setPaintProperty() {},
  };
}
