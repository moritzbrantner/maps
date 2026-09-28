import type { MapsTileImageLoader } from "../src/maps-browser-runtime";
import type { TilePaintRequest, TilePaintResult } from "./shortbread-tile-protocol";

type Pending = {
  bytes: ArrayBuffer;
  resolve(image: ImageBitmap): void;
  reject(error: unknown): void;
  detach(): void;
};

/** One worker per Map View. Only the active tile crosses into the worker; queued
 * cancellations drop their bytes immediately. Image ownership transfers to the runtime. */
export function createShortbreadTileLoader(wasmPackage: string): MapsTileImageLoader {
  let worker: Worker | null = null;
  const lifetime = new AbortController();
  let disposed = false;
  let failure: Error | null = null;
  let sequence = 0;
  let active: number | null = null;
  const pending = new Map<number, Pending>();

  function fail(error: Error) {
    failure = error;
    worker?.terminate();
    worker = null;
    active = null;
    for (const entry of pending.values()) {
      entry.detach();
      entry.reject(error);
    }
    pending.clear();
  }

  function pump() {
    if (disposed || failure || active !== null) return;
    const next = pending.entries().next().value;
    if (!next) return;
    try {
      if (!worker) {
        worker = new Worker(new URL("./shortbread-tile-worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = ({ data }: MessageEvent<TilePaintResult>) => {
          const entry = pending.get(data.id);
          pending.delete(data.id);
          if (active === data.id) active = null;
          entry?.detach();
          if ("image" in data) {
            if (entry) entry.resolve(data.image);
            else data.image.close();
          } else {
            entry?.reject(new Error(data.error));
          }
          pump();
        };
        worker.onerror = (event) =>
          fail(new Error(event.message || "Shortbread tile worker failed."));
        worker.onmessageerror = () => fail(new Error("Invalid Shortbread tile worker message."));
      }
      const [id, entry] = next;
      active = id;
      worker.postMessage({ id, bytes: entry.bytes, wasmPackage } satisfies TilePaintRequest, [
        entry.bytes,
      ]);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    // 512² RGBA tiles: at most 128 MiB of decoded pixels, plus the GPU copy.
    // Use the existing Rust budget; the worker has no second tile cache.
    limits: { cacheCapacity: 128, loadConcurrency: 4, maxVisibleTiles: 128 },
    async load(url, _tile, signal) {
      if (disposed) throw new Error("Shortbread tile loader is disposed.");
      if (failure) throw failure;
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(15000)]),
        headers: { Accept: "application/vnd.mapbox-vector-tile,application/x-protobuf" },
      });
      if (!response.ok) throw new Error(`Shortbread tile request failed: HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      if (disposed) throw new Error("Shortbread tile loader is disposed.");
      if (failure) throw failure;
      if (!bytes.byteLength) throw new Error("Shortbread tile response is empty.");
      return new Promise<ImageBitmap>((resolve, reject) => {
        const id = ++sequence;
        const abort = () => {
          pending.delete(id);
          reject(signal.reason);
          // An active paint may finish, but its orphaned image will be closed.
          pump();
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.set(id, {
          bytes,
          resolve,
          reject,
          detach: () => signal.removeEventListener("abort", abort),
        });
        pump();
      });
    },
    dispose() {
      disposed = true;
      lifetime.abort();
      fail(new Error("Shortbread tile loader is disposed."));
    },
  };
}
