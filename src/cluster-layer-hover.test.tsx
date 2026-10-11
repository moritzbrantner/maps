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

  test("clears the hover a per-feature entry delivered when that entry leaves the frame", async () => {
    setMapsAggregationWasmRuntimeForTests(createGridAggregationRuntimeForTests());
    const harness = createSurfaceHarness();
    const view = render(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer points={POINTS} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    act(() => harness.map.fireOnPointLayer(0, "mouseenter"));
    expect(harness.hoverCalls).toEqual(["a"]);

    view.rerender(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer points={POINTS.slice(1)} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    expect(harness.hoverCalls).toEqual(["a", null]);
    expect(harness.map.container.style.cursor).toBe("");
  });

  test("leaves a controlled highlight alone when its entry leaves the frame", async () => {
    setMapsAggregationWasmRuntimeForTests(createGridAggregationRuntimeForTests());
    // `a` is highlighted through `hoveredFeatureId`; this layer never delivered a hover for it.
    const harness = createSurfaceHarness({ hoveredId: "a" });
    const view = render(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer hoveredFeatureId="a" points={POINTS} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    view.rerender(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer hoveredFeatureId="a" points={POINTS.slice(1)} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    expect(harness.hoverCalls).toEqual([]);
  });

  // #221: reconciliation can replace the hovered entry under the same key when its signature
  // changes. The dropped layer owned the delivered hover and never fires its leave, so the hover
  // must be cleared, or re-delivered for the live replacement, instead of staying stuck.
  test("clears or re-delivers the hover when `selectedFeatureId` replaces the hovered entry", async () => {
    setMapsAggregationWasmRuntimeForTests(createGridAggregationRuntimeForTests());
    const harness = createSurfaceHarness();
    const view = render(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer points={POINTS} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    act(() => harness.map.fireOnPointLayer(0, "mouseenter"));
    expect(harness.hoverCalls).toEqual(["a"]);
    expect(harness.map.container.style.cursor).toBe("pointer");
    const layersBefore = new Set(harness.map.layers.keys());

    view.rerender(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer points={POINTS} selectedFeatureId="a" />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    // Precondition: the hovered entry really was replaced (a new MapLibre layer was drawn).
    expect([...harness.map.layers.keys()].some((id) => !layersBefore.has(id))).toBe(true);
    expectHoverClearedOrRedelivered(harness, { callsBefore: 1, id: "a", longitude: 0 });
  });

  test("clears or re-delivers the hover when a cluster's count replaces the hovered entry", async () => {
    setMapsAggregationWasmRuntimeForTests(createGridAggregationRuntimeForTests());
    const harness = createSurfaceHarness();
    const view = render(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer getFeatureId={stableClusterId} points={CLUSTER_POINTS.slice(0, 2)} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    act(() => harness.map.fireOnPointLayer(0, "mouseenter"));
    expect(harness.hoverCalls).toEqual([STABLE_CLUSTER_ID]);
    expect(harness.map.container.style.cursor).toBe("pointer");
    const layersBefore = new Set(harness.map.layers.keys());

    // A third point joins the cluster: same key, new count, label, radius and colour.
    view.rerender(
      <MapSurfaceContext.Provider value={harness.surface}>
        <ClusterLayer getFeatureId={stableClusterId} points={CLUSTER_POINTS} />
      </MapSurfaceContext.Provider>,
    );
    await act(async () => {});

    expect([...harness.map.layers.keys()].some((id) => !layersBefore.has(id))).toBe(true);
    expectHoverClearedOrRedelivered(harness, {
      callsBefore: 1,
      id: STABLE_CLUSTER_ID,
      longitude: 0,
    });
  });
});

const STABLE_CLUSTER_ID = "cluster-at-origin";

// Points stacked at the origin always cluster together.
const CLUSTER_POINTS = [
  { id: "c1", label: "C1", latitude: 0, longitude: 0 },
  { id: "c2", label: "C2", latitude: 0, longitude: 0 },
  { id: "c3", label: "C3", latitude: 0, longitude: 0 },
];

/** Keys the origin cluster stably across count changes; points fall back to the default id. */
const stableClusterId = (feature: { kind: string }) =>
  feature.kind === "cluster" ? STABLE_CLUSTER_ID : "";

/**
 * The replacement must not leave a stale hover: after it, the layer either cleared the hover
 * (hovered feature null, cursor reset) or delivered it again for the live replacement entry,
 * whose own leave then clears it. Leaving the earlier delivery untouched is the #221 bug.
 */
function expectHoverClearedOrRedelivered(
  harness: ReturnType<typeof createSurfaceHarness>,
  { callsBefore, id, longitude }: { callsBefore: number; id: string; longitude: number },
) {
  const afterReplacement = harness.hoverCalls.slice(callsBefore);

  expect(
    afterReplacement,
    "the replaced entry's hover was neither cleared nor re-delivered",
  ).not.toEqual([]);

  if (afterReplacement.at(-1) === null) {
    expect(harness.map.container.style.cursor).toBe("");
    return;
  }

  expect(afterReplacement.at(-1)).toBe(id);
  expect(harness.map.container.style.cursor).toBe("pointer");
  act(() => harness.map.fireOnPointLayer(longitude, "mouseleave"));
  expect(harness.hoverCalls.at(-1)).toBeNull();
  expect(harness.map.container.style.cursor).toBe("");
}

function createSurfaceHarness({ hoveredId = null }: { hoveredId?: string | null } = {}) {
  const map = createTestMap();
  const flat = createMapLibreFlatLayerFactory(
    { Marker: TestMarker } as unknown as typeof import("maplibre-gl"),
    map as unknown as import("maplibre-gl").Map,
  );
  const groups = new Map<string, FlatLayerGroup>();
  const hoverCalls: Array<string | null> = [];
  const featureId = (feature: unknown) => {
    const candidate = feature as { kind?: string; point?: { id?: string } };

    if (candidate.kind === "cluster") return STABLE_CLUSTER_ID;
    return candidate.point?.id ?? null;
  };

  const surface = {
    display: "flat",
    handleFeatureHover: vi.fn((feature: unknown) => {
      hoverCalls.push(feature ? featureId(feature) : null);
    }),
    isFeatureHovered: (feature: unknown) => hoveredId !== null && featureId(feature) === hoveredId,
    isFeatureSelected: (feature: unknown, selectedId?: string | null) =>
      selectedId != null && featureId(feature) === selectedId,
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
    /** Fires a layer-scoped event on the single-point layer drawn at `longitude`. */
    fireOnPointLayer(longitude: number, event: string) {
      for (const [layerId, layer] of layers) {
        const data = sources.get(layer.source)?.data as {
          geometry?: { coordinates: [number, number] };
        };

        if (data.geometry?.coordinates[0] === longitude) {
          for (const handler of handlers.get(`${event}@${layerId}`) ?? []) {
            handler({ point: project(data.geometry.coordinates) });
          }
        }
      }
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
      const key = args.length > 1 ? `${event}@${String(args[0])}` : event;
      handlers.get(key)?.delete(args.at(-1) as (event: unknown) => void);
    },
    on(event: string, ...args: unknown[]) {
      const key = args.length > 1 ? `${event}@${String(args[0])}` : event;
      if (!handlers.has(key)) handlers.set(key, new Set());
      handlers.get(key)!.add(args.at(-1) as (event: unknown) => void);
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
