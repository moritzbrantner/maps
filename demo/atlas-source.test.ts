import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { atlasReleaseIndex, createAtlasTileset } from "./atlas-source";
import { validateAtlasReleaseIndex, verifyAtlasArchive } from "../scripts/fetch-atlas-tiles";

it("pins the geographical regions, schema, attribution and immutable PMTiles paths", () => {
  const full = createAtlasTileset("liechtenstein", "/maps/");
  const north = createAtlasTileset("liechtenstein-north", "/maps/");
  expect(full.sourceId).toBe("maps-liechtenstein");
  expect(full.dataRevision).toBe(`sha256:${atlasReleaseIndex.tilesets[0]!.archiveRef.sha256}`);
  expect(full.transport).toEqual({
    kind: "pmtiles",
    url: `/maps/tilesets/${atlasReleaseIndex.tilesets[0]!.archiveRef.path}`,
  });
  expect(north.sourceId).not.toBe(full.sourceId);
  expect(north.bounds[1]).toBeGreaterThan(full.bounds[1]);
  expect(north.dataRevision).not.toBe(full.dataRevision);
  expect(full.attribution).toContain("OpenStreetMap contributors");
  expect(full.license).toBe("ODbL-1.0");
  expect(full.observation?.snapshot).toBe("2026-10-25T21:21:21Z");
  expect(full.schema.sourceLayers).toContain("water_polygons");
});

it("rejects drift from the producer metadata and corrupt or truncated release downloads", () => {
  expect(() => validateAtlasReleaseIndex(structuredClone(atlasReleaseIndex))).not.toThrow();
  const changed = structuredClone(atlasReleaseIndex);
  changed.tilesets[0]!.dataRevision = `sha256:${"a".repeat(64)}`;
  expect(() => validateAtlasReleaseIndex(changed)).toThrow(/content pins/);
  const bytes = new Uint8Array([2, 4, 8, 16]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(() => verifyAtlasArchive(bytes, sha256, bytes.length)).not.toThrow();
  expect(() => verifyAtlasArchive(bytes, sha256, bytes.length - 1)).toThrow(/size mismatch/);
  expect(() => verifyAtlasArchive(bytes, "0".repeat(64), bytes.length)).toThrow(/SHA-256 mismatch/);
});
