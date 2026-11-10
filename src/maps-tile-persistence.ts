import type { MapsRasterTileId } from "./flat-runtime-wasm";
import type { MapsTileset } from "./maps-tileset";
import type { MapsTileHttpMetadata, MapsTilesetTileReader } from "./maps-tileset-transport";

/**
 * Opt-in browser persistence of raw MVT bytes (#264). Browser storage only: Rust keeps tile
 * identity, scheduling, source identity and decoded retention. The store never plans requests.
 */
export type MapsTilePersistenceOptions = {
  /** Target size of the origin-wide store; the browser's quota may allow less. */
  budgetBytes?: number;
};

export type MapsTilePersistenceStatus = {
  /** `unavailable`: storage is missing or denied, so tiles come from the network only. */
  state: "idle" | "active" | "unavailable";
  budgetBytes: number;
  storedBytes: number;
  storedTiles: number;
  /** Tiles answered from storage without a request. */
  hits: number;
  /** Tiles fetched because no usable stored copy existed. */
  misses: number;
  /** Expired tiles the server confirmed unchanged (HTTP 304). */
  revalidations: number;
  writes: number;
  evictions: number;
  /** Stored entries dropped because their bytes were missing, truncated or undecodable. */
  discarded: number;
  writeFailures: number;
};

export const DEFAULT_MAPS_TILE_BUDGET_BYTES = 250 * 1024 * 1024;

const CACHE_NAME = "maps-tiles-v1";
const KEY_PREFIX = "https://maps-tiles.invalid/v1/";
const INDEX_URL = `${KEY_PREFIX}index`;
const INDEX_FLUSH_MS = 1000;
/** Recency alone is cheap to lose, so reads rewrite the index far less often than writes. */
const INDEX_TOUCH_FLUSH_MS = 30_000;
/** Eviction stops here so a full store does not sort its index on every write. */
const LOW_WATER = 0.9;

/** When a stored tile may be used without asking its server again. */
export type MapsTileStoragePolicy = {
  /** Epoch milliseconds; `null` is a content-pinned revision that never expires. */
  expires: number | null;
  etag?: string;
  lastModified?: string;
};

type IndexEntry = MapsTileStoragePolicy & { bytes: number; used: number };

type CacheLike = Pick<Cache, "match" | "put" | "delete" | "keys">;
export type MapsTileCacheStorage = {
  open(name: string): Promise<CacheLike>;
  delete(name: string): Promise<boolean>;
};

function directives(cacheControl: string | null): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (cacheControl ?? "").split(",")) {
    const [name, value = ""] = part.trim().split("=");
    if (name) result.set(name.toLowerCase(), value.replaceAll('"', "").trim());
  }
  return result;
}

/**
 * Whether one response may be stored, and until when it is current. `null` means never store.
 * `no-store` and `private` always win. A `sha256:` data revision pins content, so its tiles do
 * not expire; any other tile needs an explicit lifetime or a validator from its server.
 */
export function mapsTileStoragePolicy(
  source: Pick<MapsTileset, "dataRevision">,
  http: MapsTileHttpMetadata,
  now: number,
): MapsTileStoragePolicy | null {
  const control = directives(http.cacheControl);
  if (control.has("no-store") || control.has("private") || http.vary?.trim() === "*") return null;
  if (source.dataRevision.startsWith("sha256:")) return { expires: null };
  const validators = {
    ...(http.etag ? { etag: http.etag } : {}),
    ...(http.lastModified ? { lastModified: http.lastModified } : {}),
  };
  const hasValidator = Boolean(http.etag || http.lastModified);
  const stale = hasValidator ? { expires: now, ...validators } : null;
  if (control.has("no-cache")) return stale;
  const maxAge = Number(control.get("max-age"));
  if (control.has("max-age") && Number.isFinite(maxAge) && maxAge >= 0) {
    const age = Math.max(0, Number(http.age) || 0);
    return { expires: now + Math.max(0, maxAge - age) * 1000, ...validators };
  }
  const expires = http.expires ? Date.parse(http.expires) : Number.NaN;
  if (Number.isFinite(expires)) return { expires, ...validators };
  return stale;
}

/** Canonical key: Rust source identity plus an in-range z/x/y. Never a URL, token or style. */
export function mapsTileStorageKey(sourceIdentity: string, tile: MapsRasterTileId): string | null {
  const { z, x, y } = tile;
  if (!sourceIdentity || ![z, x, y].every(Number.isInteger) || z < 0 || z > 31) return null;
  const span = 2 ** z;
  if (x < 0 || y < 0 || x >= span || y >= span) return null;
  return `${KEY_PREFIX}tile/${encodeURIComponent(sourceIdentity)}/${z}/${x}/${y}`;
}

function normalizeBudget(budgetBytes: number | undefined): number {
  return typeof budgetBytes === "number" && Number.isFinite(budgetBytes) && budgetBytes > 0
    ? Math.floor(budgetBytes)
    : DEFAULT_MAPS_TILE_BUDGET_BYTES;
}

export type MapsTileStore = ReturnType<typeof createMapsTileStore>;

/** One bounded least-recently-used byte store over Cache Storage, with a single index entry. */
export function createMapsTileStore(
  storage: () => MapsTileCacheStorage | undefined = () =>
    typeof caches === "undefined" ? undefined : caches,
  now: () => number = Date.now,
) {
  const index = new Map<string, IndexEntry>();
  const listeners = new Set<() => void>();
  const status: MapsTilePersistenceStatus = {
    state: "idle",
    budgetBytes: DEFAULT_MAPS_TILE_BUDGET_BYTES,
    storedBytes: 0,
    storedTiles: 0,
    hits: 0,
    misses: 0,
    revalidations: 0,
    writes: 0,
    evictions: 0,
    discarded: 0,
    writeFailures: 0,
  };
  let requestedBudget = DEFAULT_MAPS_TILE_BUDGET_BYTES;
  let quotaBudget = Number.POSITIVE_INFINITY;
  let opened: Promise<CacheLike | null> | null = null;
  let generation = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushDue = 0;

  function changed() {
    status.budgetBytes = Math.min(requestedBudget, quotaBudget);
    status.storedTiles = index.size;
    for (const listener of listeners) listener();
  }

  function forget(key: string) {
    const entry = index.get(key);
    if (!entry) return;
    index.delete(key);
    status.storedBytes -= entry.bytes;
  }

  async function flush(cache: CacheLike, forGeneration: number) {
    if (forGeneration !== generation) return;
    try {
      await cache.put(
        INDEX_URL,
        new Response(JSON.stringify({ version: 1, entries: [...index] }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      status.writeFailures++;
    }
  }

  /** Recency and new entries reach storage in one debounced index write, never per hit. */
  function scheduleFlush(cache: CacheLike, delay = INDEX_FLUSH_MS) {
    const due = Date.now() + delay;
    if (flushTimer !== null && flushDue <= due) return;
    if (flushTimer !== null) clearTimeout(flushTimer);
    const forGeneration = generation;
    flushDue = due;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush(cache, forGeneration);
    }, delay);
  }

  async function evict(cache: CacheLike) {
    const budget = Math.min(requestedBudget, quotaBudget);
    if (status.storedBytes <= budget) return;
    const oldestFirst = [...index].sort((a, b) => a[1].used - b[1].used);
    for (const [key] of oldestFirst) {
      if (status.storedBytes <= budget * LOW_WATER) break;
      forget(key);
      status.evictions++;
      try {
        await cache.delete(key);
      } catch {
        // The index no longer names it; the next open removes the orphan.
      }
    }
  }

  async function open(): Promise<CacheLike | null> {
    const forGeneration = generation;
    try {
      const available = storage();
      if (!available) throw new Error("Cache Storage is unavailable");
      const cache = await available.open(CACHE_NAME);
      let entries: Array<[string, IndexEntry]> = [];
      try {
        const stored = (await (await cache.match(INDEX_URL))?.json()) as
          | { version?: unknown; entries?: unknown }
          | undefined;
        if (stored?.version === 1 && Array.isArray(stored.entries)) {
          entries = stored.entries as Array<[string, IndexEntry]>;
        }
      } catch {
        entries = []; // A corrupt index only costs the stored tiles, removed below.
      }
      const present = new Set((await cache.keys()).map((request) => request.url));
      if (forGeneration !== generation) return null;
      index.clear();
      status.storedBytes = 0;
      for (const [key, entry] of entries) {
        if (
          typeof key !== "string" ||
          !present.has(key) ||
          !entry ||
          !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 1 ||
          typeof entry.used !== "number" ||
          (entry.expires !== null && typeof entry.expires !== "number")
        ) {
          continue;
        }
        index.set(key, entry);
        status.storedBytes += entry.bytes;
      }
      // Bytes the index cannot account for would escape the budget.
      for (const key of present) {
        if (key !== INDEX_URL && !index.has(key)) await cache.delete(key);
      }
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (estimate?.quota) quotaBudget = Math.max(1, Math.floor(estimate.quota / 2));
      } catch {
        // No estimate: the requested budget and write failures bound the store.
      }
      status.state = "active";
      await evict(cache);
      changed();
      return cache;
    } catch {
      status.state = "unavailable";
      changed();
      return null;
    }
  }

  const ready = () => (opened ??= open());

  return {
    /** The most recent opt-in sets the origin-wide target. */
    configure(options: MapsTilePersistenceOptions) {
      requestedBudget = normalizeBudget(options.budgetBytes);
      changed();
      void ready().then((cache) => cache && evict(cache).then(changed));
    },
    status: (): MapsTilePersistenceStatus => ({ ...status }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    count(counter: "hits" | "misses" | "revalidations") {
      status[counter]++;
      changed();
    },
    async get(key: string): Promise<{ bytes: Uint8Array; policy: MapsTileStoragePolicy } | null> {
      const cache = await ready();
      const entry = index.get(key);
      if (!cache || !entry) return null;
      const forGeneration = generation;
      let bytes: Uint8Array | null = null;
      try {
        const response = await cache.match(key);
        if (response) bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        bytes = null;
      }
      if (forGeneration !== generation || index.get(key) !== entry) return null;
      if (!bytes || bytes.byteLength !== entry.bytes) {
        forget(key);
        if (bytes) status.discarded++;
        void cache.delete(key).catch(() => {});
        scheduleFlush(cache);
        changed();
        return null;
      }
      entry.used = now();
      scheduleFlush(cache, INDEX_TOUCH_FLUSH_MS);
      return { bytes, policy: entry };
    },
    async put(key: string, bytes: Uint8Array, policy: MapsTileStoragePolicy) {
      const cache = await ready();
      if (!cache || bytes.byteLength < 1) return;
      if (bytes.byteLength > Math.min(requestedBudget, quotaBudget)) return;
      const forGeneration = generation;
      try {
        await cache.put(
          key,
          new Response(bytes.slice(), {
            headers: { "Content-Type": "application/vnd.mapbox-vector-tile" },
          }),
        );
      } catch (error) {
        if (forGeneration !== generation) return;
        status.writeFailures++;
        forget(key);
        if (error instanceof DOMException && error.name === "QuotaExceededError") {
          // The browser allows less than the target: shrink to what it accepted.
          quotaBudget = Math.max(1, Math.min(quotaBudget, status.storedBytes));
          await evict(cache);
        }
        void cache.delete(key).catch(() => {});
        scheduleFlush(cache);
        changed();
        return;
      }
      if (forGeneration !== generation) return;
      forget(key);
      index.set(key, { ...policy, bytes: bytes.byteLength, used: now() });
      status.storedBytes += bytes.byteLength;
      status.writes++;
      await evict(cache);
      scheduleFlush(cache);
      changed();
    },
    /** A 304 answer renews a stored tile's lifetime without rewriting its bytes. */
    renew(key: string, policy: MapsTileStoragePolicy) {
      const entry = index.get(key);
      if (!entry) return;
      index.set(key, { ...policy, bytes: entry.bytes, used: now() });
      void ready().then((cache) => cache && scheduleFlush(cache));
    },
    /** Synchronous for readers: the next `get` of this key misses. */
    discard(key: string, undecodable = false) {
      if (!index.has(key)) return;
      forget(key);
      if (undecodable) status.discarded++;
      changed();
      void ready().then((cache) => {
        if (!cache) return;
        void cache.delete(key).catch(() => {});
        scheduleFlush(cache);
      });
    },
    /** Removes every downloaded tile of this origin; counters keep describing the session. */
    async clear() {
      generation++;
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      index.clear();
      status.storedBytes = 0;
      // Readers arriving meanwhile wait for the deletion instead of opening the doomed cache.
      const reopened = (async () => {
        try {
          await storage()?.delete(CACHE_NAME);
        } catch {
          // Storage that cannot be reached holds nothing this store would serve.
        }
        return open();
      })();
      opened = reopened;
      await reopened;
      changed();
    },
    /** Writes a pending index now; a page about to be hidden may not run its timer. */
    async flush() {
      if (flushTimer === null) return;
      clearTimeout(flushTimer);
      flushTimer = null;
      const cache = await ready();
      if (cache) await flush(cache, generation);
    },
  };
}

let sharedStore: MapsTileStore | null = null;

/** The one store of this page; every opted-in Map View shares its budget. */
export function getMapsTileStore(): MapsTileStore {
  if (!sharedStore) {
    sharedStore = createMapsTileStore();
    const store = sharedStore;
    if (typeof addEventListener === "function") {
      addEventListener("pagehide", () => void store.flush());
    }
  }
  return sharedStore;
}

/** Deletes the downloaded tiles of this origin. Works whether or not a Map View is mounted. */
export function clearMapsDownloadedTiles(): Promise<void> {
  return getMapsTileStore().clear();
}

/** Size, budget and hit/miss counters of this page's downloaded-tile store. */
export function getMapsTilePersistenceStatus(): MapsTilePersistenceStatus {
  return getMapsTileStore().status();
}

/**
 * Wraps one transport reader: fresh stored bytes answer without a request, expired ones are
 * revalidated or fetched again, and nothing is written until the Map View accepted the bytes.
 * Every storage failure falls back to the wrapped network reader.
 */
export function createPersistentMapsTilesetTileReader(
  source: MapsTileset,
  sourceIdentity: string,
  reader: MapsTilesetTileReader,
  store: MapsTileStore,
  now: () => number = Date.now,
): MapsTilesetTileReader {
  type Settlement = { key: string; stored: boolean; then: MapsTileStoragePolicy | "keep" | "drop" };
  const settlements = new WeakMap<Uint8Array, Settlement>();

  async function fetchTile(tile: MapsRasterTileId, signal: AbortSignal): Promise<Uint8Array> {
    const key = mapsTileStorageKey(sourceIdentity, tile);
    if (!key) return reader.fetchTile(tile, signal);
    signal.throwIfAborted();
    const cached = await store.get(key).catch(() => null);
    signal.throwIfAborted();
    if (cached && (cached.policy.expires === null || cached.policy.expires > now())) {
      store.count("hits");
      settlements.set(cached.bytes, { key, stored: true, then: "keep" });
      return cached.bytes;
    }
    // An expired copy is never returned unless its server just confirmed it.
    const read = await reader.readTile(tile, signal, cached?.policy);
    if (read.bytes === null) {
      if (!cached) throw new Error(`Maps Tileset ${source.sourceId}: unexpected HTTP 304`);
      const policy = mapsTileStoragePolicy(source, read.http, now());
      if (policy) {
        // RFC 9111: a 304 that repeats no validator keeps the stored one.
        store.renew(key, {
          ...policy,
          etag: policy.etag ?? cached.policy.etag,
          lastModified: policy.lastModified ?? cached.policy.lastModified,
        });
      } else {
        store.discard(key);
      }
      store.count("revalidations");
      settlements.set(cached.bytes, { key, stored: Boolean(policy), then: "keep" });
      return cached.bytes;
    }
    store.count("misses");
    const policy = mapsTileStoragePolicy(source, read.http, now());
    // A replaced copy the server no longer allows storing is dropped, not kept stale.
    settlements.set(read.bytes, { key, stored: false, then: policy ?? (cached ? "drop" : "keep") });
    return read.bytes;
  }

  return {
    fetchTile,
    readTile: (tile, signal, validator) => reader.readTile(tile, signal, validator),
    settleTile(bytes, accepted) {
      const settlement = settlements.get(bytes);
      if (!settlement) return false;
      settlements.delete(bytes);
      const { key, stored, then } = settlement;
      if (!accepted) {
        if (stored) store.discard(key, true);
        return stored;
      }
      if (then === "drop") store.discard(key);
      else if (then !== "keep") void store.put(key, bytes, then).catch(() => {});
      return false;
    },
    dispose: () => reader.dispose(),
  };
}
