// Archives Tileset QA knows by fixture ID: manifest, archive location and content pin.
import { atlasReleaseIndex } from "../../demo/atlas-source.ts";
import { createShowcaseTileset } from "../../demo/showcase-tileset.ts";
import {
  createFixturePmtilesTileset,
  createFixtureRevisionTileset,
} from "../../src/tileset-fixtures.ts";

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
  {
    // Two revisions of one source; scripts/tileset-revision-fixture.mjs states their differences.
    fixtureId: "fixture-revision-r1",
    manifest: createFixtureRevisionTileset("r1"),
    archive: "public/tilesets/fixture-revision-r1.pmtiles",
    expectedArchive: {
      sha256: "59dab2efd3e55f1cfb324fd79d63fb75f49dc01a6bcff9ef68f4f8c12e7ca83b",
      bytes: 938,
    },
    committed: true,
  },
  {
    fixtureId: "fixture-revision-r2",
    manifest: createFixtureRevisionTileset("r2"),
    archive: "public/tilesets/fixture-revision-r2.pmtiles",
    expectedArchive: {
      sha256: "c1db371fec86473d50c667ce87b0948dd1d0a2a9605625aea94d46edc6973b72",
      bytes: 1_129,
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

export type KnownComparison = {
  comparisonId: string;
  base: string;
  candidate: string;
  /** Committed comparisons reproduce `expected/<comparisonId>.json` in CI. */
  committed: boolean;
};

/** Archive pairs Tileset revision diff knows by comparison ID. */
export const knownComparisons: KnownComparison[] = [
  {
    comparisonId: "fixture-revision-r1-r2",
    base: "fixture-revision-r1",
    candidate: "fixture-revision-r2",
    committed: true,
  },
  {
    // Different source IDs: a cross-source coverage comparison, never feature identity.
    comparisonId: "atlas-liechtenstein-north-coverage",
    base: "atlas-liechtenstein",
    candidate: "atlas-liechtenstein-north",
    committed: false,
  },
];
