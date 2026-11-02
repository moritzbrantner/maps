import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createMapsTilesetTileReader } from "../src/maps-tileset-transport";
import { createShowcaseTileset } from "./showcase-tileset";

const archive = readFileSync("public/tilesets/showcase-pmtiles-v1.pmtiles");

afterEach(() => vi.unstubAllGlobals());

it("serves all 21 synthetic showcase quadrants through strict PMTiles byte ranges", async () => {
  const ranges: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range") ?? "";
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) throw new Error(`Missing PMTiles range: ${range}`);
      const offset = Number(match[1]);
      const end = Math.min(Number(match[2]), archive.length - 1);
      return new Response(Uint8Array.from(archive.subarray(offset, end + 1)), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${offset}-${end}/${archive.length}`,
          ETag: '"maps-showcase-v1"',
        },
      });
    }),
  );

  const tileset = createShowcaseTileset("/maps/");
  expect(tileset.transport).toEqual({
    kind: "pmtiles",
    url: "/maps/tilesets/showcase-pmtiles-v1.pmtiles",
  });
  expect(tileset.attribution).toMatch(/synthetic CC0/i);
  expect(tileset.provenance).toMatch(/not real-world/i);

  const reader = createMapsTilesetTileReader(tileset);
  try {
    for (let z = 0; z <= 2; z += 1) {
      for (let x = 0; x < 2 ** z; x += 1) {
        for (let y = 0; y < 2 ** z; y += 1) {
          const bytes = await reader.fetchTile(
            { z, x, y, key: `${z}/${x}/${y}` },
            new AbortController().signal,
          );
          expect(bytes.length).toBeGreaterThan(100);
        }
      }
    }
  } finally {
    reader.dispose();
  }
  expect(ranges.filter((range) => range === "bytes=0-16383")).toHaveLength(1);
  expect(ranges.length).toBeGreaterThanOrEqual(23); // Header, metadata, 21 tiles.
  expect(ranges.every((range) => /^bytes=\d+-\d+$/.test(range))).toBe(true);
});
