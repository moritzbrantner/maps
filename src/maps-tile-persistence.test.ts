import { describe, expect, it } from "vitest";

import type { MapsRasterTileId } from "./flat-runtime-wasm";
import {
  createMapsTileStore,
  createPersistentMapsTilesetTileReader,
  mapsTileStorageKey,
  mapsTileStoragePolicy,
  type MapsTileCacheStorage,
} from "./maps-tile-persistence";
import type { MapsTileHttpMetadata, MapsTilesetTileReader } from "./maps-tileset-transport";
import { createFixtureTileset } from "./tileset-fixtures";

const tile = (z: number, x: number, y: number): MapsRasterTileId => ({ key: `${z}/${x}/${y}`, z, x, y });
const http = (headers: Partial<MapsTileHttpMetadata> = {}): MapsTileHttpMetadata => ({
  cacheControl: null,
  etag: null,
  lastModified: null,
  expires: null,
  age: null,
  vary: null,
  ...headers,
});
const pinned = { ...createFixtureTileset("a"), dataRevision: "sha256:abc" };
const live = new AbortController().signal;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Origin storage that outlives a store instance, as Cache Storage outlives a page. */
function createStorage(options: { failPut?: (url: string) => unknown } = {}) {
  const entries = new Map<string, Uint8Array>();
  const storage: MapsTileCacheStorage = {
    async open() {
      return {
        async match(request) {
          const body = entries.get(String(request));
          return body ? new Response(body.slice()) : undefined;
        },
        async put(request, response) {
          const failure = options.failPut?.(String(request));
          if (failure) throw failure;
          entries.set(String(request), new Uint8Array(await response.arrayBuffer()));
        },
        async delete(request) {
          return entries.delete(String(request));
        },
        async keys() {
          return [...entries.keys()].map((url) => ({ url }) as Request);
        },
      };
    },
    async delete() {
      entries.clear();
      return true;
    },
  };
  return { entries, storage };
}

/** A transport that serves `bytes` and records what it was asked. */
function createNetwork(
  bytes: () => Uint8Array,
  headers: () => MapsTileHttpMetadata = () => http(),
  notModified = () => false,
) {
  const reads: Array<{ key: string; etag: string | null }> = [];
  const reader: MapsTilesetTileReader = {
    async readTile(requested, signal, validator) {
      signal.throwIfAborted();
      reads.push({ key: requested.key, etag: validator?.etag ?? null });
      if (validator?.etag && notModified()) return { bytes: null, http: headers() };
      return { bytes: bytes(), http: headers() };
    },
    async fetchTile(requested, signal) {
      return (await reader.readTile(requested, signal)).bytes!;
    },
    dispose() {},
  };
  return { reader, reads };
}

async function load(reader: MapsTilesetTileReader, requested: MapsRasterTileId, accept = true) {
  const bytes = await reader.fetchTile(requested, live);
  reader.settleTile?.(bytes, accept);
  await settle();
  return bytes;
}

describe("mapsTileStoragePolicy", () => {
  const source = createFixtureTileset("a");

  it("never stores no-store, private or Vary: * responses, pinned or not", () => {
    for (const headers of [
      http({ cacheControl: "no-store" }),
      http({ cacheControl: "private, max-age=600" }),
      http({ cacheControl: "max-age=600", vary: "*" }),
    ]) {
      expect(mapsTileStoragePolicy(source, headers, 0)).toBeNull();
      expect(mapsTileStoragePolicy(pinned, headers, 0)).toBeNull();
    }
  });

  it("keeps a content-pinned revision without expiry", () => {
    expect(mapsTileStoragePolicy(pinned, http(), 0)).toEqual({ expires: null });
  });

  it("requires an explicit lifetime or a validator for unpinned revisions", () => {
    expect(mapsTileStoragePolicy(source, http(), 1000)).toBeNull();
    expect(mapsTileStoragePolicy(source, http({ cacheControl: "max-age=60", age: "10" }), 1000)).toEqual(
      { expires: 51_000 },
    );
    expect(mapsTileStoragePolicy(source, http({ etag: '"v1"' }), 1000)).toEqual({
      expires: 1000,
      etag: '"v1"',
    });
    expect(
      mapsTileStoragePolicy(source, http({ cacheControl: "no-cache, max-age=60", etag: '"v1"' }), 1000),
    ).toEqual({ expires: 1000, etag: '"v1"' });
    expect(mapsTileStoragePolicy(source, http({ cacheControl: "no-cache" }), 1000)).toBeNull();
  });
});

describe("mapsTileStorageKey", () => {
  it("names the source identity and canonical z/x/y only", () => {
    expect(mapsTileStorageKey("fixture-a@1", tile(2, 3, 1))).toBe(
      "https://maps-tiles.invalid/v1/tile/fixture-a%401/2/3/1",
    );
    expect(mapsTileStorageKey("fixture-a@1", tile(1, 2, 0))).toBeNull(); // A world copy, not a tile.
    expect(mapsTileStorageKey("fixture-a@1", tile(1, -1, 0))).toBeNull();
    expect(mapsTileStorageKey("", tile(0, 0, 0))).toBeNull();
  });
});

describe("persistent Tileset tile reader", () => {
  const bytes = new Uint8Array([26, 3, 1, 2, 3]);

  it("fetches a tile once, then answers a later session from storage with identical bytes", async () => {
    const { storage, entries } = createStorage();
    const network = createNetwork(() => bytes.slice());
    const first = createMapsTileStore(() => storage);
    const cold = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, first);
    expect(await load(cold, tile(0, 0, 0))).toEqual(bytes);
    expect(first.status()).toMatchObject({ state: "active", misses: 1, writes: 1, storedBytes: 5 });
    await first.flush();

    const second = createMapsTileStore(() => storage);
    const warm = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, second);
    expect(await load(warm, tile(0, 0, 0))).toEqual(bytes);
    expect(network.reads).toHaveLength(1);
    expect(second.status()).toMatchObject({ hits: 1, misses: 0, storedTiles: 1, storedBytes: 5 });
    expect(entries.get(mapsTileStorageKey("id-1", tile(0, 0, 0))!)).toEqual(bytes);
  });

  it("keeps source revisions apart", async () => {
    const { storage } = createStorage();
    const store = createMapsTileStore(() => storage);
    const network = createNetwork(() => bytes.slice());
    await load(createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store), tile(0, 0, 0));
    await load(createPersistentMapsTilesetTileReader(pinned, "id-2", network.reader, store), tile(0, 0, 0));
    expect(network.reads).toHaveLength(2);
    expect(store.status()).toMatchObject({ misses: 2, hits: 0, storedTiles: 2 });
  });

  it("stores nothing for cancelled, unsettled or rejected bytes", async () => {
    const { storage, entries } = createStorage();
    const store = createMapsTileStore(() => storage);
    const network = createNetwork(() => bytes.slice());
    const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
    await reader.fetchTile(tile(0, 0, 0), live); // Superseded before the Map View accepted it.
    await load(reader, tile(0, 0, 0), false); // Undecodable network bytes.
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(reader.fetchTile(tile(0, 0, 0), cancelled.signal)).rejects.toThrow();
    await store.flush();
    expect([...entries.keys()].filter((key) => key.includes("/tile/"))).toEqual([]);
    expect(store.status().storedBytes).toBe(0);
  });

  it("never stores a response its server marked no-store", async () => {
    const { storage } = createStorage();
    const store = createMapsTileStore(() => storage);
    const network = createNetwork(
      () => bytes.slice(),
      () => http({ cacheControl: "no-store" }),
    );
    const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
    await load(reader, tile(0, 0, 0));
    await load(reader, tile(0, 0, 0));
    expect(network.reads).toHaveLength(2);
    expect(store.status()).toMatchObject({ writes: 0, storedTiles: 0 });
  });

  it("revalidates an expired tile and reuses it only on a 304", async () => {
    const { storage } = createStorage();
    let time = 1_000;
    const store = createMapsTileStore(() => storage, () => time);
    let unchanged = true;
    let payload = bytes.slice();
    const network = createNetwork(
      () => payload,
      () => http({ cacheControl: "max-age=60", etag: '"v1"' }),
      () => unchanged,
    );
    const source = createFixtureTileset("a");
    const reader = createPersistentMapsTilesetTileReader(
      source,
      "id-1",
      network.reader,
      store,
      () => time,
    );
    await load(reader, tile(0, 0, 0));
    time += 30_000;
    await load(reader, tile(0, 0, 0));
    expect(network.reads).toHaveLength(1); // Still within max-age.
    time += 31_000;
    expect(await load(reader, tile(0, 0, 0))).toEqual(bytes);
    expect(network.reads[1]).toEqual({ key: "0/0/0", etag: '"v1"' });
    expect(store.status()).toMatchObject({ hits: 1, revalidations: 1, misses: 1 });
    await load(reader, tile(0, 0, 0));
    expect(network.reads).toHaveLength(2); // The 304 renewed the lifetime.

    time += 61_000;
    unchanged = false;
    payload = new Uint8Array([26, 1, 9]);
    expect(await load(reader, tile(0, 0, 0))).toEqual(payload);
    expect(store.status()).toMatchObject({ misses: 2, storedBytes: 3, storedTiles: 1 });
  });

  it("does not present an expired tile as current when its server is unreachable", async () => {
    const { storage } = createStorage();
    let time = 0;
    const store = createMapsTileStore(() => storage, () => time);
    let offline = false;
    const network = createNetwork(
      () => {
        if (offline) throw new TypeError("Failed to fetch");
        return bytes.slice();
      },
      () => http({ cacheControl: "max-age=60" }),
    );
    const source = createFixtureTileset("a");
    const reader = createPersistentMapsTilesetTileReader(source, "id-1", network.reader, store, () => time);
    await load(reader, tile(0, 0, 0));
    offline = true;
    expect(await load(reader, tile(0, 0, 0))).toEqual(bytes); // Fresh: no request needed.
    time = 61_000;
    await expect(reader.fetchTile(tile(0, 0, 0), live)).rejects.toThrow("Failed to fetch");
    await expect(reader.fetchTile(tile(0, 1, 0), live)).rejects.toThrow(); // Not a tile: uncached.
  });

  it("evicts least recently used tiles beyond the budget", async () => {
    const { storage, entries } = createStorage();
    let time = 0;
    const store = createMapsTileStore(() => storage, () => ++time);
    store.configure({ budgetBytes: 12 });
    const network = createNetwork(() => bytes.slice());
    const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
    await load(reader, tile(1, 0, 0));
    await load(reader, tile(1, 1, 0));
    await load(reader, tile(1, 0, 0)); // Touch: 1/1/0 is now the oldest.
    await load(reader, tile(1, 0, 1));
    expect(store.status()).toMatchObject({ evictions: 1, storedBytes: 10, storedTiles: 2, budgetBytes: 12 });
    expect(entries.has(mapsTileStorageKey("id-1", tile(1, 1, 0))!)).toBe(false);
    expect(entries.has(mapsTileStorageKey("id-1", tile(1, 0, 0))!)).toBe(true);
    await load(reader, tile(1, 1, 0));
    expect(network.reads).toHaveLength(4);
  });

  it("falls back to the network when storage is unavailable or denied", async () => {
    for (const storage of [
      () => undefined,
      () =>
        ({
          open: () => Promise.reject(new DOMException("denied", "SecurityError")),
          delete: () => Promise.reject(new DOMException("denied", "SecurityError")),
        }) satisfies MapsTileCacheStorage,
    ]) {
      const store = createMapsTileStore(storage);
      const network = createNetwork(() => bytes.slice());
      const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
      expect(await load(reader, tile(0, 0, 0))).toEqual(bytes);
      expect(await load(reader, tile(0, 0, 0))).toEqual(bytes);
      expect(network.reads).toHaveLength(2);
      expect(store.status()).toMatchObject({ state: "unavailable", storedBytes: 0 });
      await expect(store.clear()).resolves.toBeUndefined();
    }
  });

  it("keeps serving tiles when the browser refuses a write for quota", async () => {
    const { storage } = createStorage({
      failPut: (url) =>
        url.endsWith("/1/1/0") ? new DOMException("full", "QuotaExceededError") : null,
    });
    const store = createMapsTileStore(() => storage);
    const network = createNetwork(() => bytes.slice());
    const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
    await load(reader, tile(1, 0, 0));
    expect(await load(reader, tile(1, 1, 0))).toEqual(bytes);
    expect(store.status()).toMatchObject({ writeFailures: 1, storedTiles: 1, budgetBytes: 5 });
    expect(await load(reader, tile(1, 0, 0))).toEqual(bytes);
    expect(store.status().hits).toBe(1);
  });

  it("discards truncated or undecodable stored bytes and reads the network instead", async () => {
    const { storage, entries } = createStorage();
    const store = createMapsTileStore(() => storage);
    const network = createNetwork(() => bytes.slice());
    const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
    const key = mapsTileStorageKey("id-1", tile(0, 0, 0))!;
    await load(reader, tile(0, 0, 0));
    entries.set(key, bytes.slice(0, 2)); // Partial write.
    expect(await load(reader, tile(0, 0, 0))).toEqual(bytes);
    expect(network.reads).toHaveLength(2);
    expect(store.status()).toMatchObject({ discarded: 1, storedTiles: 1 });

    const stored = await reader.fetchTile(tile(0, 0, 0), live);
    expect(reader.settleTile?.(stored, false)).toBe(true); // The decoder rejected stored bytes.
    expect(await load(reader, tile(0, 0, 0))).toEqual(bytes);
    expect(network.reads).toHaveLength(3);
    expect(store.status().discarded).toBe(2);
  });

  it("accounts concurrent reads of one tile once", async () => {
    const { storage } = createStorage();
    const store = createMapsTileStore(() => storage);
    const network = createNetwork(() => bytes.slice());
    const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
    await Promise.all([load(reader, tile(0, 0, 0)), load(reader, tile(0, 0, 0))]);
    await settle();
    expect(store.status()).toMatchObject({ storedTiles: 1, storedBytes: 5 });
  });

  it("clears downloaded tiles and removes bytes a lost index cannot account for", async () => {
    const { storage, entries } = createStorage();
    const store = createMapsTileStore(() => storage);
    const network = createNetwork(() => bytes.slice());
    const reader = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, store);
    await load(reader, tile(0, 0, 0));
    await store.clear();
    expect(entries.size).toBe(0);
    expect(store.status()).toMatchObject({ state: "active", storedBytes: 0, storedTiles: 0 });
    await load(reader, tile(0, 0, 0));
    expect(network.reads).toHaveLength(2);

    // The page closed before the index was written: the tile is an orphan.
    const reopened = createMapsTileStore(() => storage);
    const again = createPersistentMapsTilesetTileReader(pinned, "id-1", network.reader, reopened);
    await load(again, tile(0, 0, 0));
    expect(network.reads).toHaveLength(3);
    expect(reopened.status()).toMatchObject({ storedTiles: 1, storedBytes: 5 });
    expect([...entries.keys()].filter((key) => key.includes("/tile/"))).toHaveLength(1);
  });
});
