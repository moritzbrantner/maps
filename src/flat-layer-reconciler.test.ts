import { describe, expect, test, vi } from "vitest";

import {
  beginFlatLayerResourceRequest,
  clearFlatLayerEntries,
  createFlatLayerResourceState,
  isCurrentFlatLayerResourceRequest,
  reconcileFlatLayerEntries,
  resetFlatLayerResourceState,
  type FlatLayerEntry,
} from "./flat-layer-reconciler";

describe("flat layer reconciler", () => {
  test("keeps matching signature entries without rendering again", () => {
    const layer = createTestLayerParent();
    const entry = createEntry("existing", "same");
    const cache = new Map([["a", entry]]);
    const render = vi.fn(() => createEntry("next", "same"));

    reconcileFlatLayerEntries({
      cache,
      layer,
      plans: [{ key: "a", render, signature: "same" }],
    });

    expect(render).not.toHaveBeenCalled();
    expect(cache.get("a")).toBe(entry);
    expect(layer.removed).toEqual([]);
  });

  test("removes and recreates when signature changes", () => {
    const layer = createTestLayerParent();
    const cache = new Map([["a", createEntry("old", "old")]]);
    const next = createEntry("new", "new");

    reconcileFlatLayerEntries({
      cache,
      layer,
      plans: [{ key: "a", render: () => next, signature: "new" }],
    });

    expect(layer.removed.map((item) => item.id)).toEqual(["old"]);
    expect(cache.get("a")).toBe(next);
  });

  test("calls update and keeps the entry when update returns true", () => {
    const layer = createTestLayerParent();
    const entry = createEntry("existing", "same");
    const cache = new Map([["a", entry]]);
    const update = vi.fn(() => true);
    const render = vi.fn(() => createEntry("next", "same"));

    reconcileFlatLayerEntries({
      cache,
      layer,
      plans: [{ key: "a", render, signature: "same", update }],
    });

    expect(update).toHaveBeenCalledWith(entry);
    expect(render).not.toHaveBeenCalled();
    expect(cache.get("a")).toBe(entry);
    expect(layer.removed).toEqual([]);
  });

  test("removes and recreates when update returns false", () => {
    const layer = createTestLayerParent();
    const cache = new Map([["a", createEntry("old", "same")]]);
    const next = createEntry("new", "same");

    reconcileFlatLayerEntries({
      cache,
      layer,
      plans: [{ key: "a", render: () => next, signature: "same", update: () => false }],
    });

    expect(layer.removed.map((item) => item.id)).toEqual(["old"]);
    expect(cache.get("a")).toBe(next);
  });

  test("removes stale entries absent from the next plan set", () => {
    const layer = createTestLayerParent();
    const keep = createEntry("keep", "same");
    const stale = createEntry("stale", "same");
    const cache = new Map([
      ["keep", keep],
      ["stale", stale],
    ]);

    reconcileFlatLayerEntries({
      cache,
      layer,
      plans: [{ key: "keep", render: () => createEntry("ignored", "same"), signature: "same" }],
    });

    expect(cache.has("stale")).toBe(false);
    expect(cache.get("keep")).toBe(keep);
    expect(layer.removed.map((item) => item.id)).toEqual(["stale"]);
  });

  test("removes previous entry when render returns null", () => {
    const layer = createTestLayerParent();
    const cache = new Map([["a", createEntry("old", "old")]]);

    reconcileFlatLayerEntries({
      cache,
      layer,
      plans: [{ key: "a", render: () => null, signature: "new" }],
    });

    expect(cache.has("a")).toBe(false);
    expect(layer.removed.map((item) => item.id)).toEqual(["old"]);
  });

  test("clears all cached entries", () => {
    const layer = createTestLayerParent();
    const cache = new Map([
      ["a", createEntry("a", "same")],
      ["b", createEntry("b", "same")],
    ]);

    clearFlatLayerEntries({ cache, layer });

    expect(cache.size).toBe(0);
    expect(layer.removed.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("resource reset removes current resource and invalidates request id", () => {
    const state = createFlatLayerResourceState<TestResource, TestMetadata>();
    const remove = vi.fn();
    const revokeMetadata = vi.fn();

    state.resource = { id: "surface" };
    state.metadata = { url: "blob:test" };
    state.signature = "surface";
    const requestId = beginFlatLayerResourceRequest(state);

    resetFlatLayerResourceState({ remove, revokeMetadata, state });

    expect(remove).toHaveBeenCalledWith({ id: "surface" });
    expect(revokeMetadata).toHaveBeenCalledWith({ url: "blob:test" });
    expect(state.resource).toBeNull();
    expect(state.metadata).toBeNull();
    expect(state.signature).toBeNull();
    expect(isCurrentFlatLayerResourceRequest(state, requestId)).toBe(false);
  });

  test("async request guard accepts the latest request and rejects stale requests", () => {
    const state = createFlatLayerResourceState<TestResource>();
    const first = beginFlatLayerResourceRequest(state);
    const second = beginFlatLayerResourceRequest(state);

    expect(isCurrentFlatLayerResourceRequest(state, first)).toBe(false);
    expect(isCurrentFlatLayerResourceRequest(state, second)).toBe(true);
  });

  test("duplicate keys deterministically use the last plan", () => {
    const layer = createTestLayerParent();
    const cache = new Map([["a", createEntry("old", "old")]]);
    const first = createEntry("first", "first");
    const second = createEntry("second", "second");

    reconcileFlatLayerEntries({
      cache,
      layer,
      plans: [
        { key: "a", render: () => first, signature: "first" },
        { key: "a", render: () => second, signature: "second" },
      ],
    });

    expect(cache.get("a")).toBe(second);
    expect(layer.removed.map((item) => item.id)).toEqual(["old"]);
  });

  test("does not swallow update errors", () => {
    const layer = createTestLayerParent();
    const cache = new Map([["a", createEntry("old", "same")]]);
    const error = new Error("update failed");

    expect(() =>
      reconcileFlatLayerEntries({
        cache,
        layer,
        plans: [
          {
            key: "a",
            render: () => createEntry("new", "same"),
            signature: "same",
            update: () => {
              throw error;
            },
          },
        ],
      }),
    ).toThrow(error);
  });
});

type TestLayer = {
  id: string;
};

type TestEntry = FlatLayerEntry<TestLayer>;

type TestResource = {
  id: string;
};

type TestMetadata = {
  url: string;
};

function createEntry(id: string, signature: string): TestEntry {
  return {
    layers: [{ id }],
    signature,
  };
}

function createTestLayerParent() {
  const removed: TestLayer[] = [];

  return {
    removed,
    removeLayer(layer: TestLayer) {
      removed.push(layer);
    },
  };
}
