// Tileset revision diff (#276, part 2): compares a base and a candidate revision of one source
// before the candidate is adopted, and assembles the bounded `maps-tileset-diff-v1` artifact.
//
// Fast path first: equal archive SHA-256 settles everything; otherwise the directories give
// the coverage delta without reading tile bytes, and only a bounded set of common tiles is
// read. Equal decompressed tile bytes settle a tile; only tiles whose bytes differ go through
// the Rust kernel (`maps-core::tileset_diff`, the runtime MVT decoder), which reports
// unmatched/ambiguous features rather than asserting identity without stable IDs.
// Integrity of each archive on its own is `runTilesetQa` (part 1). Runs in Node and the browser.
import { PMTiles, SharedPromiseCache, zxyToTileId, type Header, type Source } from "pmtiles";

import { MAX_DECODED_TILE_BYTES } from "../../src/maps-tileset-transport";
import { validateMapsTilesetMetadata, type MapsTilesetMetadata } from "../../src/maps-tileset";
import {
  describe,
  readDirectory,
  sampleTileIndices,
  sha256Hex,
  type MvtDiffCounts,
  type MvtFeatureChange,
  type MvtTileDiff,
  type TilesetQaKernel,
  type TilesetQaLimits,
  type TilesetQaMode,
  type TilesetQaSeverity,
  type TilesetQaStatus,
} from "./core";

export const TILESET_DIFF_SCHEMA = "maps-tileset-diff-v1";
/** Bump when a check's meaning changes; artifacts of different versions are not comparable. */
export const TILESET_DIFF_CHECK_VERSION = "1.0.0";

export type TilesetDiffCheckId =
  | "pairing"
  | "archives"
  | "source-metadata"
  | "coverage"
  | "features";
/**
 * - `identical-bytes`: the archives are byte-identical, nothing else is read;
 * - `revision`: two revisions of one source ID, compared feature by feature;
 * - `cross-source`: different source IDs; coverage only, features have no shared identity.
 */
export type TilesetDiffRelation = "identical-bytes" | "revision" | "cross-source";
export type TilesetDiffTileRef = {
  z: number;
  x: number;
  y: number;
  /** `[west, south, east, north]` from the Rust tile rule, for camera focus. */
  bounds: [number, number, number, number];
};
export type TilesetDiffCheck = {
  id: TilesetDiffCheckId;
  status: TilesetQaStatus;
  summary: string;
};
export type TilesetDiffFinding = {
  check: TilesetDiffCheckId;
  code: string;
  severity: TilesetQaSeverity;
  message: string;
  count: number;
  tiles: TilesetDiffTileRef[];
};
export type TilesetDiffLimits = Pick<
  TilesetQaLimits,
  "sampleTiles" | "maxContentTiles" | "maxAddressedTiles" | "maxExpectedTiles" | "tilesPerFinding"
> & {
  /** Differing tiles listed in the artifact. */
  reportedTiles: number;
  /** Feature changes kept per listed tile. */
  changesPerTile: number;
};

const SAMPLED_LIMITS: TilesetDiffLimits = {
  sampleTiles: 32,
  maxContentTiles: 32,
  maxAddressedTiles: 250_000,
  maxExpectedTiles: 250_000,
  tilesPerFinding: 16,
  reportedTiles: 32,
  changesPerTile: 16,
};
const FULL_LIMITS: TilesetDiffLimits = {
  ...SAMPLED_LIMITS,
  maxContentTiles: 20_000,
  maxAddressedTiles: 4_000_000,
  maxExpectedTiles: 4_000_000,
};

export type TilesetDiffArchiveInput = {
  manifest: unknown;
  archive: { name: string; source: Source; bytes: number; sha256: string };
};

export type TilesetDiffInput = {
  base: TilesetDiffArchiveInput;
  candidate: TilesetDiffArchiveInput;
  kernel: TilesetQaKernel;
  pmtilesReaderVersion: string;
  comparisonId?: string | null;
  mode?: TilesetQaMode;
  seed?: number;
  limits?: Partial<TilesetDiffLimits>;
  signal?: AbortSignal;
};

export type TilesetDiffSide = {
  sourceId: string;
  dataRevision: string;
  schema: { id: string; version: string; sourceLayers: string[] };
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  attribution: string;
  license: string;
  provenance: string;
  archive: {
    name: string;
    bytes: number;
    sha256: string;
    tileCompression: number | null;
  };
};

export type TilesetDiffTile = TilesetDiffTileRef & {
  status: "changed" | "reencoded" | "undiffable";
  baseSha256: string;
  candidateSha256: string;
  counts: MvtDiffCounts | null;
  /** Layers that appeared, disappeared, changed extent or property keys. */
  schemaChanges: string[];
  changes: MvtFeatureChange[];
  changesTruncated: boolean;
  reason: string;
};

export type TilesetDiffLayerSummary = {
  name: string;
  /** Compared tiles where the layer exists only in the candidate / only in the base. */
  addedInTiles: number;
  removedInTiles: number;
  incomparableTiles: number;
  counts: MvtDiffCounts;
  propertyKeysAdded: string[];
  propertyKeysRemoved: string[];
};

export type TilesetDiffArtifact = {
  schema: typeof TILESET_DIFF_SCHEMA;
  checkVersion: string;
  comparisonId: string | null;
  status: TilesetQaStatus;
  relation: TilesetDiffRelation | null;
  mode: TilesetQaMode;
  seed: number;
  limits: TilesetDiffLimits;
  base: TilesetDiffSide | null;
  candidate: TilesetDiffSide | null;
  tools: { pmtilesReader: string };
  checks: TilesetDiffCheck[];
  findings: TilesetDiffFinding[];
  coverage: {
    base: number;
    candidate: number;
    common: number;
    added: number;
    removed: number;
    byZoom: {
      zoom: number;
      base: number;
      candidate: number;
      added: number;
      removed: number;
    }[];
    addedTiles: TilesetDiffTileRef[];
    removedTiles: TilesetDiffTileRef[];
  } | null;
  features: {
    /** Every common tile was compared (or the archives are byte-identical). */
    complete: boolean;
    commonTiles: number;
    comparedTiles: number;
    identicalTiles: number;
    reencodedTiles: number;
    changedTiles: number;
    undiffableTiles: number;
    counts: MvtDiffCounts;
    layers: TilesetDiffLayerSummary[];
    tiles: TilesetDiffTile[];
  } | null;
};

const CHECK_ORDER: TilesetDiffCheckId[] = [
  "pairing",
  "archives",
  "source-metadata",
  "coverage",
  "features",
];

const zeroCounts = (): MvtDiffCounts => ({
  unchanged: 0,
  added: 0,
  removed: 0,
  changed: 0,
  ambiguous: 0,
  unmatchedAdded: 0,
  unmatchedRemoved: 0,
});
const addCounts = (into: MvtDiffCounts, from: MvtDiffCounts) => {
  for (const key of Object.keys(into) as (keyof MvtDiffCounts)[]) into[key] += from[key];
};
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What a feature-change count means, in the words the artifact uses. */
const FEATURE_CODES: [keyof MvtDiffCounts, string, string][] = [
  ["added", "features-added", "feature with a stable MVT ID only in the candidate"],
  ["removed", "features-removed", "feature with a stable MVT ID only in the base"],
  ["changed", "features-changed", "feature with a stable MVT ID changed geometry or properties"],
  [
    "ambiguous",
    "features-ambiguous",
    "no stable ID: same type and properties on both sides with different geometry; identity is not asserted",
  ],
  [
    "unmatchedAdded",
    "features-unmatched-added",
    "no stable ID: candidate feature without a counterpart in the base",
  ],
  [
    "unmatchedRemoved",
    "features-unmatched-removed",
    "no stable ID: base feature without a counterpart in the candidate",
  ],
];

/** Compare two archives and return the artifact. Rejects only when `signal` aborts. */
export async function runTilesetDiff(input: TilesetDiffInput): Promise<TilesetDiffArtifact> {
  const { signal, kernel } = input;
  const mode = input.mode ?? "sampled";
  const seed = (input.seed ?? 1) >>> 0;
  const limits = {
    ...(mode === "full" ? FULL_LIMITS : SAMPLED_LIMITS),
    ...input.limits,
  };
  const checks = new Map<TilesetDiffCheckId, { status: TilesetQaStatus; summary: string }>();
  const findings: TilesetDiffFinding[] = [];
  const ref = (z: number, x: number, y: number): TilesetDiffTileRef => {
    const [west, south, east, north] = kernel.tileLngLatBounds(z, x, y);
    return { z, x, y, bounds: [west!, south!, east!, north!] };
  };
  const find = (
    check: TilesetDiffCheckId,
    code: string,
    severity: TilesetQaSeverity,
    message: string,
    count = 1,
    tiles: TilesetDiffTileRef[] = [],
  ) => {
    if (count <= 0) return;
    const existing = findings.find((entry) => entry.check === check && entry.code === code);
    if (!existing) {
      findings.push({
        check,
        code,
        severity,
        message,
        count,
        tiles: tiles.slice(0, limits.tilesPerFinding),
      });
      return;
    }
    existing.count += count;
    for (const tile of tiles) {
      if (existing.tiles.length >= limits.tilesPerFinding) break;
      if (
        !existing.tiles.some((seen) => seen.z === tile.z && seen.x === tile.x && seen.y === tile.y)
      ) {
        existing.tiles.push(tile);
      }
    }
  };
  const settle = (id: TilesetDiffCheckId, summary: string, inconclusive = false) => {
    const failed = findings.some((entry) => entry.check === id && entry.severity === "error");
    checks.set(id, {
      status: failed ? "failed" : inconclusive ? "inconclusive" : "passed",
      summary,
    });
  };
  const skip = (reason: string) => {
    for (const id of CHECK_ORDER) {
      if (!checks.has(id)) checks.set(id, { status: "inconclusive", summary: reason });
    }
  };

  let relation: TilesetDiffRelation | null = null;
  const sides: Record<"base" | "candidate", TilesetDiffSide | null> = {
    base: null,
    candidate: null,
  };
  let coverage: TilesetDiffArtifact["coverage"] = null;
  let features: TilesetDiffArtifact["features"] = null;
  const artifact = (): TilesetDiffArtifact => {
    const ordered = CHECK_ORDER.map((id) => ({ id, ...checks.get(id)! }));
    return {
      schema: TILESET_DIFF_SCHEMA,
      checkVersion: TILESET_DIFF_CHECK_VERSION,
      comparisonId: input.comparisonId ?? null,
      status: ordered.some((check) => check.status === "failed")
        ? "failed"
        : ordered.some((check) => check.status === "inconclusive")
          ? "inconclusive"
          : "passed",
      relation,
      mode,
      seed,
      limits,
      base: sides.base,
      candidate: sides.candidate,
      tools: { pmtilesReader: input.pmtilesReaderVersion },
      checks: ordered,
      findings: [...findings].sort(
        (a, b) =>
          CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check) ||
          compareText(a.code, b.code),
      ),
      coverage,
      features,
    };
  };

  signal?.throwIfAborted();

  // Pairing: which comparison the two manifests permit.
  const manifests: Partial<Record<"base" | "candidate", MapsTilesetMetadata>> = {};
  for (const side of ["base", "candidate"] as const) {
    try {
      manifests[side] = validateMapsTilesetMetadata(input[side].manifest);
    } catch (error) {
      find("pairing", "invalid-manifest", "error", `${side}: ${describe(error)}`);
    }
  }
  const { base, candidate } = manifests;
  if (!base || !candidate) {
    settle("pairing", "a manifest is not valid Maps Tileset metadata");
    skip("not evaluated: a manifest is invalid");
    return artifact();
  }
  const sameBytes = input.base.archive.sha256 === input.candidate.archive.sha256;
  if (sameBytes) {
    relation = "identical-bytes";
    if (base.dataRevision !== candidate.dataRevision || base.sourceId !== candidate.sourceId) {
      find(
        "pairing",
        "identical-archives",
        "info",
        "the two manifests name byte-identical archives",
      );
    }
    settle("pairing", "archives are byte-identical");
  } else if (base.sourceId !== candidate.sourceId) {
    relation = "cross-source";
    find(
      "pairing",
      "cross-source",
      "warning",
      `${base.sourceId} and ${candidate.sourceId} are different sources: coverage is compared, feature identity is not`,
    );
    settle("pairing", "different sources: cross-source coverage comparison");
  } else {
    relation = "revision";
    if (base.dataRevision === candidate.dataRevision) {
      find(
        "pairing",
        "revision-label-reused",
        "error",
        `revision ${base.dataRevision} names two archives with different bytes`,
      );
    }
    settle("pairing", `${base.sourceId}: ${base.dataRevision} → ${candidate.dataRevision}`);
  }

  // Archives: readable headers through the upstream reader.
  const readers = {
    base: new PMTiles(input.base.archive.source, new SharedPromiseCache(16)),
    candidate: new PMTiles(input.candidate.archive.source, new SharedPromiseCache(16)),
  };
  const headers: Partial<Record<"base" | "candidate", Header>> = {};
  for (const side of ["base", "candidate"] as const) {
    try {
      headers[side] = await readers[side].getHeader();
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      find("archives", "unreadable-archive", "error", `${side}: ${describe(error)}`);
    }
    const manifest = manifests[side]!;
    sides[side] = {
      sourceId: manifest.sourceId,
      dataRevision: manifest.dataRevision,
      schema: {
        id: manifest.schema.id,
        version: manifest.schema.version,
        sourceLayers: [...manifest.schema.sourceLayers],
      },
      bounds: [...manifest.bounds],
      minZoom: manifest.minZoom,
      maxZoom: manifest.maxZoom,
      attribution: manifest.attribution,
      license: manifest.license,
      provenance: manifest.provenance,
      archive: {
        name: input[side].archive.name,
        bytes: input[side].archive.bytes,
        sha256: input[side].archive.sha256,
        tileCompression: headers[side]?.tileCompression ?? null,
      },
    };
  }
  settle("archives", "both archive headers read");

  // Source metadata: what the manifests and headers declare differently.
  for (const [code, severity, label, a, b] of [
    // The manifest validator admits only Shortbread 1.0, so the schema ID and version agree.
    ["attribution-changed", "warning", "attribution", base.attribution, candidate.attribution],
    ["license-changed", "warning", "license", base.license, candidate.license],
    ["provenance-changed", "info", "provenance", base.provenance, candidate.provenance],
    ["bounds-changed", "info", "bounds", base.bounds.join(","), candidate.bounds.join(",")],
    [
      "zoom-range-changed",
      "info",
      "zoom range",
      `${base.minZoom}–${base.maxZoom}`,
      `${candidate.minZoom}–${candidate.maxZoom}`,
    ],
    [
      "tile-compression-changed",
      "info",
      "tile compression",
      String(headers.base?.tileCompression ?? "?"),
      String(headers.candidate?.tileCompression ?? "?"),
    ],
  ] as const) {
    if (a !== b) find("source-metadata", code, severity, `${label}: ${a} → ${b}`);
  }
  const baseLayers = new Set(base.schema.sourceLayers);
  const candidateLayers = new Set(candidate.schema.sourceLayers);
  const removedLayers = [...baseLayers].filter((layer) => !candidateLayers.has(layer));
  const addedLayers = [...candidateLayers].filter((layer) => !baseLayers.has(layer));
  if (removedLayers.length) {
    find(
      "source-metadata",
      "source-layer-removed",
      "warning",
      `declared source layers removed: ${removedLayers.join(", ")}`,
      removedLayers.length,
    );
  }
  if (addedLayers.length) {
    find(
      "source-metadata",
      "source-layer-added",
      "info",
      `declared source layers added: ${addedLayers.join(", ")}`,
      addedLayers.length,
    );
  }
  settle("source-metadata", "manifests and headers compared");

  if (!headers.base || !headers.candidate) {
    skip("not evaluated: an archive header is unreadable");
    return artifact();
  }

  // Coverage: tile sets from both directories; no tile bytes are read.
  const directories: Partial<Record<"base" | "candidate", Uint32Array>> = {};
  for (const side of ["base", "candidate"] as const) {
    try {
      const directory = await readDirectory(
        readers[side],
        headers[side]!,
        input[side].archive.bytes,
        limits,
        signal,
      );
      if (directory.exceeded) {
        find(
          "coverage",
          "addressed-tile-budget-exceeded",
          "warning",
          `${side} addresses more than ${limits.maxAddressedTiles} tiles`,
        );
      } else {
        directories[side] = directory.tiles;
      }
    } catch (error) {
      signal?.throwIfAborted();
      find("coverage", "unreadable-directory", "error", `${side}: ${describe(error)}`);
    }
  }
  if (!directories.base || !directories.candidate) {
    settle("coverage", "a tile directory could not be enumerated", true);
    skip("not evaluated: a tile directory could not be enumerated");
    return artifact();
  }
  const baseTiles = directories.base;
  const candidateTiles = directories.candidate;
  const ids = (tiles: Uint32Array) => {
    const map = new Map<number, number>();
    for (let index = 0; index < tiles.length / 3; index += 1) {
      map.set(zxyToTileId(tiles[index * 3]!, tiles[index * 3 + 1]!, tiles[index * 3 + 2]!), index);
    }
    return map;
  };
  const baseIds = ids(baseTiles);
  const candidateIds = ids(candidateTiles);
  const triple = (tiles: Uint32Array, index: number) =>
    [tiles[index * 3]!, tiles[index * 3 + 1]!, tiles[index * 3 + 2]!] as const;
  const byZoom = new Map<
    number,
    {
      zoom: number;
      base: number;
      candidate: number;
      added: number;
      removed: number;
    }
  >();
  const level = (zoom: number) => {
    let entry = byZoom.get(zoom);
    if (!entry) byZoom.set(zoom, (entry = { zoom, base: 0, candidate: 0, added: 0, removed: 0 }));
    return entry;
  };
  const removed: number[] = [];
  const added: number[] = [];
  const common: number[] = [];
  for (const [id, index] of baseIds) {
    const [z] = triple(baseTiles, index);
    level(z).base += 1;
    if (candidateIds.has(id)) common.push(id);
    else {
      removed.push(id);
      level(z).removed += 1;
    }
  }
  for (const [id, index] of candidateIds) {
    const [z] = triple(candidateTiles, index);
    level(z).candidate += 1;
    if (!baseIds.has(id)) {
      added.push(id);
      level(z).added += 1;
    }
  }
  const sortIds = (list: number[]) => list.sort((a, b) => a - b);
  sortIds(removed);
  sortIds(added);
  sortIds(common);
  const refsOf = (list: number[], tiles: Uint32Array, map: Map<number, number>) =>
    list.slice(0, limits.tilesPerFinding).map((id) => ref(...triple(tiles, map.get(id)!)));
  // A removed tile the candidate still declares is lost coverage: the Map View fails closed.
  let lostRefs: TilesetDiffTileRef[] = [];
  let lost = 0;
  let coverageInconclusive = false;
  if (removed.length) {
    const packed = Uint32Array.from(
      removed.flatMap((id) => [...triple(baseTiles, baseIds.get(id)!)]),
    );
    try {
      // The candidate's declared coverage, by the Rust coverage rule, classifies each removed
      // tile. With the removed tiles as "addressed", the exclusion lists name every removed
      // tile the candidate does not declare (the sample limit is the removed count).
      const audit = kernel.auditTilesetCoverage(
        Float64Array.from(candidate.bounds),
        candidate.minZoom,
        candidate.maxZoom,
        packed,
        removed.length,
        limits.maxExpectedTiles,
      );
      const declared = new Set<number>(removed);
      for (const [z, x, y] of [...audit.outsideTiles, ...audit.outOfZoomRangeTiles]) {
        declared.delete(zxyToTileId(z, x, y));
      }
      lost = declared.size;
      const declaredRemoved = removed.filter((id) => declared.has(id));
      lostRefs = refsOf(declaredRemoved, baseTiles, baseIds);
      find(
        "coverage",
        "coverage-lost",
        "error",
        "base tile missing from the candidate inside the candidate's declared coverage; the Map View fails closed on it",
        lost,
        lostRefs,
      );
      const narrowed = removed.filter((id) => !declared.has(id));
      find(
        "coverage",
        "coverage-narrowed",
        "info",
        "base tile outside the candidate's declared coverage",
        narrowed.length,
        refsOf(narrowed, baseTiles, baseIds),
      );
    } catch (error) {
      coverageInconclusive = true;
      find("coverage", "coverage-not-classified", "warning", describe(error), removed.length);
    }
  }
  find(
    "coverage",
    "coverage-added",
    "info",
    "candidate tile not in the base",
    added.length,
    refsOf(added, candidateTiles, candidateIds),
  );
  coverage = {
    base: baseIds.size,
    candidate: candidateIds.size,
    common: common.length,
    added: added.length,
    removed: removed.length,
    byZoom: [...byZoom.values()].sort((a, b) => a.zoom - b.zoom),
    addedTiles: refsOf(added, candidateTiles, candidateIds),
    removedTiles: refsOf(removed, baseTiles, baseIds),
  };
  settle(
    "coverage",
    `${common.length} common tiles, ${added.length} added, ${removed.length} removed (${lost} inside the candidate's coverage)`,
    coverageInconclusive,
  );

  // Features: only a revision of one source has feature identity to compare.
  const totals = zeroCounts();
  const layers = new Map<
    string,
    TilesetDiffLayerSummary & { added: Set<string>; removed: Set<string> }
  >();
  const listed: TilesetDiffTile[] = [];
  const summary = {
    complete: true,
    commonTiles: common.length,
    comparedTiles: 0,
    identicalTiles: 0,
    reencodedTiles: 0,
    changedTiles: 0,
    undiffableTiles: 0,
  };
  const finish = () => {
    features = {
      ...summary,
      counts: totals,
      layers: [...layers.values()]
        .sort((a, b) => compareText(a.name, b.name))
        .map(({ added: keysAdded, removed: keysRemoved, ...layer }) => ({
          ...layer,
          propertyKeysAdded: [...keysAdded].sort(),
          propertyKeysRemoved: [...keysRemoved].sort(),
        })),
      tiles: listed,
    };
  };
  if (relation === "identical-bytes") {
    summary.identicalTiles = common.length;
    finish();
    settle("features", "byte-identical archives: every tile is unchanged");
    return artifact();
  }
  if (relation === "cross-source") {
    summary.complete = false;
    finish();
    settle("features", "not evaluated: different sources share no feature identity", true);
    return artifact();
  }

  // Revision: a bounded, seeded sample of common tiles, every zoom represented.
  const packedCommon = Uint32Array.from(
    common.flatMap((id) => [...triple(baseTiles, baseIds.get(id)!)]),
  );
  const wanted = mode === "full" ? limits.maxContentTiles : limits.sampleTiles;
  const indices = sampleTileIndices(packedCommon, wanted, seed);
  summary.complete = indices.length === common.length;
  const read = async (side: "base" | "candidate", z: number, x: number, y: number) => {
    const response = await readers[side].getZxy(z, x, y, signal);
    signal?.throwIfAborted();
    if (!response) throw new Error(`${side} tile has no data`);
    const bytes = new Uint8Array(response.data);
    if (!bytes.length || bytes.length > MAX_DECODED_TILE_BYTES) {
      throw new Error(`${side} tile is empty or above the decoded size limit`);
    }
    return bytes;
  };
  for (const index of indices) {
    signal?.throwIfAborted();
    const [z, x, y] = triple(packedCommon, index);
    const tile = ref(z, x, y);
    summary.comparedTiles += 1;
    let baseBytes: Uint8Array;
    let candidateBytes: Uint8Array;
    try {
      baseBytes = await read("base", z, x, y);
      candidateBytes = await read("candidate", z, x, y);
    } catch (error) {
      signal?.throwIfAborted();
      summary.undiffableTiles += 1;
      find("features", "unreadable-tile", "error", describe(error), 1, [tile]);
      continue;
    }
    if (equalBytes(baseBytes, candidateBytes)) {
      summary.identicalTiles += 1;
      continue;
    }
    const entry: TilesetDiffTile = {
      ...tile,
      status: "changed",
      baseSha256: await sha256Hex(baseBytes),
      candidateSha256: await sha256Hex(candidateBytes),
      counts: null,
      schemaChanges: [],
      changes: [],
      changesTruncated: false,
      reason: "",
    };
    let diff: MvtTileDiff;
    try {
      diff = kernel.diffMvtTiles(baseBytes, candidateBytes, limits.changesPerTile);
    } catch (error) {
      summary.undiffableTiles += 1;
      entry.status = "undiffable";
      entry.reason = describe(error);
      find("features", "undiffable-tile", "error", entry.reason, 1, [tile]);
      if (listed.length < limits.reportedTiles) listed.push(entry);
      continue;
    }
    addCounts(totals, diff.counts);
    entry.counts = diff.counts;
    entry.changes = diff.changes;
    entry.changesTruncated = diff.changesTruncated;
    for (const layer of diff.layers) {
      let summaryLayer = layers.get(layer.name);
      if (!summaryLayer) {
        summaryLayer = {
          name: layer.name,
          addedInTiles: 0,
          removedInTiles: 0,
          incomparableTiles: 0,
          counts: zeroCounts(),
          propertyKeysAdded: [],
          propertyKeysRemoved: [],
          added: new Set(),
          removed: new Set(),
        };
        layers.set(layer.name, summaryLayer);
      }
      addCounts(summaryLayer.counts, layer.counts);
      for (const key of layer.propertyKeysAdded) summaryLayer.added.add(key);
      for (const key of layer.propertyKeysRemoved) summaryLayer.removed.add(key);
      if (layer.presence === "added") {
        summaryLayer.addedInTiles += 1;
        entry.schemaChanges.push(`layer ${layer.name} added`);
        find("features", "tile-layer-added", "warning", "source layer appears in a tile", 1, [
          tile,
        ]);
      } else if (layer.presence === "removed") {
        summaryLayer.removedInTiles += 1;
        entry.schemaChanges.push(`layer ${layer.name} removed`);
        find(
          "features",
          "tile-layer-removed",
          "warning",
          "source layer disappears from a tile",
          1,
          [tile],
        );
      }
      if (!layer.comparable) {
        summaryLayer.incomparableTiles += 1;
        entry.schemaChanges.push(
          `layer ${layer.name} extent ${layer.baseExtent} → ${layer.candidateExtent}`,
        );
        find(
          "features",
          "layer-extent-changed",
          "warning",
          "layer extent changed, so its features are not comparable and count as unmatched",
          1,
          [tile],
        );
      }
      if (layer.propertyKeysAdded.length || layer.propertyKeysRemoved.length) {
        entry.schemaChanges.push(
          `layer ${layer.name} property keys ${[
            ...layer.propertyKeysAdded.map((key) => `+${key}`),
            ...layer.propertyKeysRemoved.map((key) => `-${key}`),
          ].join(" ")}`,
        );
        find("features", "property-keys-changed", "warning", "feature property keys changed", 1, [
          tile,
        ]);
      }
    }
    if (diff.equal) {
      summary.reencodedTiles += 1;
      entry.status = "reencoded";
      entry.reason = "bytes differ; decoded features are equal";
      find(
        "features",
        "tile-reencoded",
        "info",
        "tile bytes differ but its decoded features are equal",
        1,
        [tile],
      );
    } else {
      summary.changedTiles += 1;
      entry.reason = FEATURE_CODES.filter(([key]) => diff.counts[key] > 0)
        .map(([key, code]) => `${code.replace(/^features-/, "")} ${diff.counts[key]}`)
        .concat(entry.schemaChanges)
        .join("; ");
      for (const [key, code, message] of FEATURE_CODES) {
        if (diff.counts[key] > 0) find("features", code, "info", message, diff.counts[key], [tile]);
      }
    }
    if (listed.length < limits.reportedTiles) listed.push(entry);
  }
  finish();
  settle(
    "features",
    `${summary.comparedTiles} of ${common.length} common tiles compared: ${summary.identicalTiles} identical, ${summary.reencodedTiles} re-encoded, ${summary.changedTiles} changed`,
    mode === "full" && !summary.complete,
  );
  return artifact();
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
