import type { MapsRasterTilePlacement } from "./flat-runtime-wasm";

export const RASTER_TILE_FADE_MS = 200;

/** Tile opacity is presentation state; placement and fallback ownership stay in Rust. */
export function fadeRasterPlacements(
  placements: readonly MapsRasterTilePlacement[],
  available: ReadonlySet<string>,
  loadedAt: ReadonlyMap<string, number>,
  now: number,
): { placements: MapsRasterTilePlacement[]; animating: boolean } {
  let animating = false;
  const result = placements.map((placement) => {
    const loaded = loadedAt.get(placement.tile.key);
    if (loaded === undefined || now - loaded >= RASTER_TILE_FADE_MS) return placement;
    const { z, x, y } = placement.tile;
    let covered = false;
    for (let parentZ = z - 1; parentZ >= 0; parentZ -= 1) {
      const scale = 2 ** (z - parentZ);
      if (available.has(`${parentZ}/${Math.floor(x / scale)}/${Math.floor(y / scale)}`)) {
        covered = true;
        break;
      }
    }
    // Never fade from the bare map background: absent a parent, paint immediately.
    if (!covered) return placement;
    animating = true;
    return {
      ...placement,
      opacity: Math.max(0, Math.min(1, (now - loaded) / RASTER_TILE_FADE_MS)),
    };
  });
  return { placements: result, animating };
}
