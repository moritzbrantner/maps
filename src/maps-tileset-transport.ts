import type { MapsRasterTileId } from "./flat-runtime-wasm";
import type { MapsTileset } from "./maps-tileset";

/** Browser transport only. Canonical requests, concurrency, cancellation and retention come from Rust. */
export async function fetchMapsTilesetTile(
  source: MapsTileset,
  tile: MapsRasterTileId,
  signal: AbortSignal,
): Promise<Uint8Array> {
  // Archive readers extend this transport boundary; URL/token values never become resource keys.
  const url = source.transport.urlTemplate
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/vnd.mapbox-vector-tile,application/x-protobuf" },
  });
  if (!response.ok) {
    throw new Error(`Maps Tileset ${source.sourceId}: tile ${tile.key} HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  if (!bytes.length) {
    throw new Error(`Maps Tileset ${source.sourceId}: empty tile ${tile.key}`);
  }
  return bytes;
}
