import { describe, expect, it } from "vitest";
import { createAtlasTileset } from "./atlas-tilesets";

describe("content-pinned real-world Atlas sources", () => {
  it("adopts the full Liechtenstein archive through the public Maps Tileset contract", () => {
    const tileset = createAtlasTileset("atlas", "/maps/");
    expect(tileset.sourceId).toBe("maps-liechtenstein");
    expect(tileset.dataRevision).toBe(
      "sha256:a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4",
    );
    expect(tileset.bounds).toEqual([9.47, 47.04, 9.64, 47.28]);
    expect(tileset.transport).toEqual({
      kind: "pmtiles",
      url: "/maps/tilesets/a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4.pmtiles",
    });
    expect(tileset.attribution).toContain("OpenStreetMap contributors");
    expect(tileset.observation?.snapshot).toBe("2026-01-01T21:21:30Z");
  });

  it("isolates the northern subset under its own identity, revision and coverage", () => {
    const full = createAtlasTileset("atlas", "/maps/");
    const north = createAtlasTileset("atlas-north", "/maps/");
    expect(north.sourceId).toBe("maps-liechtenstein-north");
    expect(north.bounds).toEqual([9.47, 47.16, 9.64, 47.28]);
    expect(north.dataRevision).not.toBe(full.dataRevision);
    expect(north.transport).not.toEqual(full.transport);
    expect(north.schema).toEqual(full.schema);
  });
});
