import { describe, expect, it } from "vitest";
import type { MapsRasterTilePlacement } from "./flat-runtime-wasm";
import { fadeRasterPlacements } from "./raster-tile-transition";

const placement = (z: number, x: number, y: number): MapsRasterTilePlacement => ({
  tile: { key: `${z}/${x}/${y}`, z, x, y },
  worldCopy: 0,
  localWest: 0,
  localNorth: 0,
  localSize: 256,
  screenX: 0,
  screenY: 0,
  screenWidth: 256,
  screenHeight: 256,
});

describe("raster tile zoom crossfade", () => {
  it("fades a child over its loaded ancestor, then ends the animation", () => {
    const parent = placement(3, 4, 2);
    const child = placement(5, 17, 9);
    const tiles = [parent, child];
    const available = new Set(tiles.map((p) => p.tile.key));
    const loadedAt = new Map([[child.tile.key, 1000]]);

    const halfway = fadeRasterPlacements(tiles, available, loadedAt, 1100);
    expect(halfway.animating).toBe(true);
    expect(halfway.placements[0]?.opacity).toBeUndefined();
    expect(halfway.placements[1]?.opacity).toBe(0.5);

    const finished = fadeRasterPlacements(tiles, available, loadedAt, 1200);
    expect(finished.animating).toBe(false);
    expect(finished.placements[1]?.opacity).toBeUndefined();
  });

  it("paints immediately when no ancestor pixels exist", () => {
    const child = placement(5, 17, 9);
    const result = fadeRasterPlacements(
      [child],
      new Set([child.tile.key]),
      new Map([[child.tile.key, 1000]]),
      1000,
    );
    expect(result.animating).toBe(false);
    expect(result.placements[0]?.opacity).toBeUndefined();
  });
});
