// Archives Tileset QA knows by fixture ID: manifest, archive location and content pin.
import { atlasReleaseIndex } from "../../demo/atlas-source.ts";
import { createShowcaseTileset } from "../../demo/showcase-tileset.ts";
import { createFixturePmtilesTileset } from "../../src/tileset-fixtures.ts";

export type KnownTileset = {
  fixtureId: string;
  manifest: unknown;
  /** Path below the repository root. */
  archive: string;
  expectedArchive: { sha256: string; bytes: number };
  /** Committed archives are audited in CI; Atlas archives are fetched on demand. */
  committed: boolean;
};

export const knownTilesets: KnownTileset[] = [
  {
    // Deliberately sparse: one of four z1 tiles exists.
    fixtureId: "fixture-pmtiles-v1",
    manifest: createFixturePmtilesTileset(),
    archive: "public/tilesets/fixture-pmtiles-v1.pmtiles",
    expectedArchive: {
      sha256: "26ac9ae8e322ba7e81ef1304d69e56ab55e9488348dfead315ca17d81712cf37",
      bytes: 91_906,
    },
    committed: true,
  },
  {
    fixtureId: "showcase-pmtiles-v1",
    manifest: createShowcaseTileset("/"),
    archive: "public/tilesets/showcase-pmtiles-v1.pmtiles",
    expectedArchive: {
      sha256: "903f437836c2234a457946b110ed56560202c7caa392568ec0ea485b34486b8e",
      bytes: 351_749,
    },
    committed: true,
  },
  ...atlasReleaseIndex.tilesets.map(({ archiveRef, ...manifest }) => ({
    fixtureId: `atlas-${manifest.sourceId.replace(/^maps-/, "")}`,
    manifest,
    archive: `public/tilesets/${archiveRef.path}`,
    expectedArchive: { sha256: archiveRef.sha256, bytes: archiveRef.bytes },
    committed: false,
  })),
];
