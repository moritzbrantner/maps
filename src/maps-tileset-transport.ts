import {
  Compression,
  PMTiles,
  SharedPromiseCache,
  TileType,
  type Header,
  type Source,
} from "pmtiles";
import type { MapsRasterTileId } from "./flat-runtime-wasm";
import type { MapsTileset, MapsTilesetMetadata } from "./maps-tileset";

/** HTTP cache metadata of the response that carried a tile; consumed by opt-in persistence only. */
export type MapsTileHttpMetadata = {
  cacheControl: string | null;
  etag: string | null;
  lastModified: string | null;
  expires: string | null;
  age: string | null;
  vary: string | null;
};

/** A stored copy's validators, sent as a conditional request where the transport can. */
export type MapsTileValidator = { etag?: string | null; lastModified?: string | null };

/** `bytes: null` is an HTTP 304 answer to the supplied validator. */
export type MapsTilesetTileRead = { bytes: Uint8Array | null; http: MapsTileHttpMetadata };

/** Browser I/O only. Rust owns tile coordinates, scheduling, source identity and decoded retention. */
export type MapsTilesetTileReader = {
  fetchTile(tile: MapsRasterTileId, signal: AbortSignal): Promise<Uint8Array>;
  /** `fetchTile` plus the response's cache metadata. PMTiles ignores `validator`. */
  readTile(
    tile: MapsRasterTileId,
    signal: AbortSignal,
    validator?: MapsTileValidator,
  ): Promise<MapsTilesetTileRead>;
  /**
   * The Map View reports whether returned bytes decoded as a tile. Only a persistent reader
   * acts on it: accepted bytes may be stored. Rejected bytes that came from storage are
   * discarded and the call returns true, so the caller can read the tile again from the network.
   */
  settleTile?(bytes: Uint8Array, accepted: boolean): boolean;
  dispose(): void;
};

function httpMetadata(headers: Headers): MapsTileHttpMetadata {
  return {
    cacheControl: headers.get("Cache-Control"),
    etag: headers.get("ETag"),
    lastModified: headers.get("Last-Modified"),
    expires: headers.get("Expires"),
    age: headers.get("Age"),
    vary: headers.get("Vary"),
  };
}

const MAX_RANGE_BYTES = 8 * 1024 * 1024;
/** Largest decoded MVT tile the Map View accepts; Tileset QA reports larger ones. */
export const MAX_DECODED_TILE_BYTES = 16 * 1024 * 1024;
const HEADER_REQUEST_BYTES = 16_384; // The upstream PMTiles v3 header/root request.
const BOUNDS_TOLERANCE = 1e-5; // E7 header coordinates and producer metadata rounding.

function archiveError(source: MapsTilesetMetadata, message: string): Error {
  return new Error(`Maps Tileset ${source.sourceId}: PMTiles ${message}`);
}

/** Strict HTTP 206 adapter. Never download an entire archive when a host ignores Range. */
function createRangeSource(
  source: MapsTileset,
  url: string,
  lifetime: AbortSignal,
  onResponse: (http: MapsTileHttpMetadata) => void,
): Source {
  let archiveLength: number | null = null;
  return {
    getKey: () => url,
    async getBytes(offset, length, signal, etag) {
      lifetime.throwIfAborted();
      signal?.throwIfAborted();
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > MAX_RANGE_BYTES ||
        !Number.isSafeInteger(offset + length - 1)
      ) {
        throw archiveError(source, `invalid requested byte range ${offset}+${length}`);
      }
      const combined = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
      const response = await fetch(url, {
        signal: combined,
        headers: {
          Range: `bytes=${offset}-${offset + length - 1}`,
          // RFC 9110 forbids weak validators in If-Range; still compare weak ETags.
          ...(etag && !etag.startsWith("W/") ? { "If-Range": etag } : {}),
          Accept: "application/octet-stream",
        },
      });
      if (response.status !== 206) {
        void response.body?.cancel();
        throw archiveError(
          source,
          response.status === 200
            ? "server ignored byte Range (HTTP 200); archive not downloaded"
            : `byte Range HTTP ${response.status}`,
        );
      }
      // CORS hosts must expose Content-Range (and ETag, when used) to JavaScript.
      const contentRange = response.headers.get("Content-Range");
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      const total = Number(match?.[3]);
      if (
        !match ||
        ![start, end, total].every(Number.isSafeInteger) ||
        total <= 0 ||
        start !== offset ||
        end !== Math.min(offset + length - 1, total - 1) ||
        end < start ||
        (archiveLength !== null && archiveLength !== total)
      ) {
        void response.body?.cancel();
        throw archiveError(source, `missing/inconsistent Content-Range: ${contentRange ?? "none"}`);
      }
      const responseEtag = response.headers.get("ETag") ?? undefined;
      if (etag && responseEtag !== etag) {
        void response.body?.cancel();
        throw archiveError(source, "archive ETag changed during range reads");
      }
      const bytes = await response.arrayBuffer();
      combined.throwIfAborted();
      if (bytes.byteLength !== end - start + 1) {
        throw archiveError(source, "byte Range body length differs from Content-Range");
      }
      archiveLength = total;
      onResponse(httpMetadata(response.headers));
      return { data: bytes, etag: responseEtag };
    },
  };
}

/** Throws when a PMTiles v3 header conflicts with the manifest. Shared with Tileset QA. */
export function validateArchiveHeader(source: MapsTilesetMetadata, header: Header) {
  if (header.specVersion !== 3 || header.tileType !== TileType.Mvt) {
    throw archiveError(source, "requires PMTiles v3 with MVT vector tiles");
  }
  if (
    ![Compression.None, Compression.Gzip].includes(header.internalCompression) ||
    ![Compression.None, Compression.Gzip].includes(header.tileCompression)
  ) {
    throw archiveError(source, "unsupported archive compression (only none/gzip supported)");
  }
  if (header.minZoom !== source.minZoom || header.maxZoom !== source.maxZoom) {
    throw archiveError(source, "archive zoom range conflicts with the source manifest");
  }
  const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
  if (bounds.some((value, index) => Math.abs(value - source.bounds[index]!) > BOUNDS_TOLERANCE)) {
    throw archiveError(source, "archive coverage bounds conflict with the source manifest");
  }
  if (
    header.rootDirectoryOffset < 127 ||
    header.rootDirectoryLength < 1 ||
    header.rootDirectoryOffset + header.rootDirectoryLength > HEADER_REQUEST_BYTES ||
    header.jsonMetadataLength < 1 ||
    header.jsonMetadataLength > MAX_RANGE_BYTES ||
    header.numAddressedTiles < 1
  ) {
    throw archiveError(source, "invalid header directory or metadata lengths");
  }
}

/** Throws when archive JSON metadata conflicts with the manifest. Shared with Tileset QA. */
export function validateArchiveMetadata(source: MapsTilesetMetadata, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw archiveError(source, "invalid JSON metadata");
  }
  const metadata = input as Record<string, unknown>;
  if (metadata.format !== undefined && metadata.format !== "pbf" && metadata.format !== "mvt") {
    throw archiveError(source, "incompatible MVT metadata format");
  }
  const layers = metadata.vector_layers;
  if (!Array.isArray(layers)) {
    throw archiveError(source, "missing Shortbread vector_layers metadata");
  }
  const actual = layers.map((layer: unknown) => {
    if (!layer || typeof layer !== "object") return null;
    return (layer as { id?: unknown }).id;
  });
  const expected = [...source.schema.sourceLayers].sort();
  if (
    actual.some((layer) => typeof layer !== "string") ||
    JSON.stringify([...actual].sort()) !== JSON.stringify(expected)
  ) {
    throw archiveError(source, "Shortbread source layers conflict with archive vector_layers");
  }
  const schema = metadata.mapsSchema;
  if (
    schema !== undefined &&
    (!schema ||
      typeof schema !== "object" ||
      (schema as { id?: unknown }).id !== source.schema.id ||
      (schema as { version?: unknown }).version !== source.schema.version)
  ) {
    throw archiveError(source, "archive Shortbread schema version conflicts with manifest");
  }
  for (const [field, expectedZoom] of [
    ["minzoom", source.minZoom],
    ["maxzoom", source.maxZoom],
  ] as const) {
    if (metadata[field] !== undefined && String(metadata[field]) !== String(expectedZoom)) {
      throw archiveError(source, `archive ${field} conflicts with manifest`);
    }
  }
}

/** One reader per live source transport; no decoded-tile cache or geographic scheduler. */
export function createMapsTilesetTileReader(source: MapsTileset): MapsTilesetTileReader {
  const lifetime = new AbortController();
  if (source.transport.kind === "xyz") {
    const { urlTemplate } = source.transport;
    const readTile: MapsTilesetTileReader["readTile"] = async (tile, signal, validator) => {
      lifetime.signal.throwIfAborted();
      const url = urlTemplate
        .replace("{z}", String(tile.z))
        .replace("{x}", String(tile.x))
        .replace("{y}", String(tile.y));
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const accept = { Accept: "application/vnd.mapbox-vector-tile,application/x-protobuf" };
      const conditional = validator?.etag
        ? { "If-None-Match": validator.etag }
        : validator?.lastModified
          ? { "If-Modified-Since": validator.lastModified }
          : null;
      let response: Response;
      try {
        response = await fetch(url, {
          signal: combined,
          headers: conditional ? { ...accept, ...conditional } : accept,
        });
      } catch (error) {
        if (!conditional || combined.aborted) throw error;
        // A cross-origin host may refuse the conditional header's preflight; ask plainly.
        response = await fetch(url, { signal: combined, headers: accept });
      }
      if (conditional && response.status === 304) {
        return { bytes: null, http: httpMetadata(response.headers) };
      }
      if (!response.ok) {
        throw new Error(`Maps Tileset ${source.sourceId}: tile ${tile.key} HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      combined.throwIfAborted();
      if (!bytes.length) {
        throw new Error(`Maps Tileset ${source.sourceId}: empty tile ${tile.key}`);
      }
      return { bytes, http: httpMetadata(response.headers) };
    };
    return {
      readTile,
      fetchTile: async (tile, signal) => (await readTile(tile, signal)).bytes!,
      dispose: () => lifetime.abort(),
    };
  }

  const cache = new SharedPromiseCache(32); // Header/directory entries only, never tile contents.
  // Tiles share the archive's cache directives: the latest range response speaks for them.
  let archiveHttp = httpMetadata(new Headers());
  const pmtiles = new PMTiles(
    createRangeSource(source, source.transport.url, lifetime.signal, (http) => {
      archiveHttp = http;
    }),
    cache,
  );
  let validated: Promise<void> | null = null;
  function ensureValidated() {
    validated ??= (async () => {
      const header = await pmtiles.getHeader();
      lifetime.signal.throwIfAborted();
      validateArchiveHeader(source, header);
      const metadata = await pmtiles.getMetadata();
      lifetime.signal.throwIfAborted();
      validateArchiveMetadata(source, metadata);
    })();
    return validated;
  }
  const readTile: MapsTilesetTileReader["readTile"] = async (tile, signal) => {
    try {
      lifetime.signal.throwIfAborted();
      signal.throwIfAborted();
      await ensureValidated();
      const combined = AbortSignal.any([signal, lifetime.signal]);
      combined.throwIfAborted();
      const result = await pmtiles.getZxy(tile.z, tile.x, tile.y, combined);
      combined.throwIfAborted();
      if (!result) throw archiveError(source, `missing tile ${tile.key}`);
      const bytes = new Uint8Array(result.data);
      if (!bytes.length || bytes.length > MAX_DECODED_TILE_BYTES) {
        throw archiveError(source, `empty or oversized decoded MVT tile ${tile.key}`);
      }
      return { bytes, http: archiveHttp };
    } catch (error) {
      if (signal.aborted || lifetime.signal.aborted) throw error;
      if (error instanceof Error && error.message.startsWith(`Maps Tileset ${source.sourceId}:`))
        throw error;
      throw archiveError(source, error instanceof Error ? error.message : String(error));
    }
  };
  return {
    readTile,
    fetchTile: async (tile, signal) => (await readTile(tile, signal)).bytes!,
    dispose() {
      lifetime.abort();
      cache.cache.clear();
    },
  };
}
