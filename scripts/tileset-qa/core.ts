// Tileset integrity QA (#276, part 1): audits one PMTiles archive against its Maps Tileset
// manifest and assembles the bounded `maps-tileset-qa-v1` artifact.
//
// Authority: the upstream `pmtiles` reader does archive I/O; the manifest validator and the
// header/metadata rules are the ones the Map View uses (`src/maps-tileset*.ts`); tile
// contents and required coverage come from the Rust kernel (`maps-core::tileset_qa`).
// This module only orchestrates and reports. It runs in Node and in the browser.
import {
  PMTiles,
  SharedPromiseCache,
  tileIdToZxy,
  type Entry,
  type Header,
  type Source,
} from "pmtiles";
import {
  MAX_DECODED_TILE_BYTES,
  validateArchiveHeader,
  validateArchiveMetadata,
} from "../../src/maps-tileset-transport";
import { validateMapsTilesetMetadata, type MapsTilesetMetadata } from "../../src/maps-tileset";

export const TILESET_QA_SCHEMA = "maps-tileset-qa-v1";
/** Bump when a check's meaning changes; artifacts of different versions are not comparable. */
export const TILESET_QA_CHECK_VERSION = "1.0.0";
/** The upstream validator whose verdict the `upstream-verify` check accepts. */
export const TILESET_QA_UPSTREAM = { tool: "go-pmtiles", version: "1.31.2" } as const;

export type TilesetQaStatus = "passed" | "failed" | "inconclusive";
export type TilesetQaSeverity = "error" | "warning" | "info";
export type TilesetQaMode = "sampled" | "full";
export type TilesetQaTileRef = { z: number; x: number; y: number };
export type TilesetQaCheckId =
  | "manifest"
  | "archive-identity"
  | "archive-header"
  | "archive-metadata"
  | "archive-directory"
  | "upstream-verify"
  | "tile-coverage"
  | "tile-content";

export type TilesetQaCheck = { id: TilesetQaCheckId; status: TilesetQaStatus; summary: string };

/** One finding per check and code. `count` is exact; `tiles` is a bounded sample. */
export type TilesetQaFinding = {
  check: TilesetQaCheckId;
  code: string;
  severity: TilesetQaSeverity;
  message: string;
  count: number;
  tiles: TilesetQaTileRef[];
};

export type TilesetQaLimits = {
  /** Tiles decoded in `sampled` mode. */
  sampleTiles: number;
  /** Tiles decoded at most in `full` mode; more addressed tiles make the check inconclusive. */
  maxContentTiles: number;
  /** Addressed tiles enumerated from the directory before coverage becomes inconclusive. */
  maxAddressedTiles: number;
  /** Tiles the declared coverage may require before coverage becomes inconclusive. */
  maxExpectedTiles: number;
  /** Tile references kept per finding. */
  tilesPerFinding: number;
  /** Inspected tiles listed in the artifact. */
  reportedTiles: number;
};

const SAMPLED_LIMITS: TilesetQaLimits = {
  sampleTiles: 32,
  maxContentTiles: 32,
  maxAddressedTiles: 250_000,
  maxExpectedTiles: 250_000,
  tilesPerFinding: 16,
  reportedTiles: 64,
};
const FULL_LIMITS: TilesetQaLimits = {
  ...SAMPLED_LIMITS,
  maxContentTiles: 20_000,
  maxAddressedTiles: 4_000_000,
  maxExpectedTiles: 4_000_000,
};

export type MvtLayerInspection = {
  name: string;
  extent: number;
  features: number;
  points: number;
  lines: number;
  polygons: number;
  featuresWithId: number;
  emptyGeometries: number;
  propertyKeys: string[];
  propertyKeysTruncated: boolean;
};
export type MvtTileInspection = {
  layers: MvtLayerInspection[];
  features: number;
  duplicateLayers: string[];
};
export type TilesetCoverageAudit = {
  expected: number;
  covered: number;
  missing: number;
  outside: number;
  outOfZoomRange: number;
  addressed: number;
  byZoom: { zoom: number; expected: number; covered: number; missing: number; outside: number }[];
  missingTiles: [number, number, number][];
  outsideTiles: [number, number, number][];
  outOfZoomRangeTiles: [number, number, number][];
};

/** The Rust/WASM kernel. The built WebGPU-free `maps_wasm_core` module (and the full `maps_wasm` module) satisfy this shape directly. */
export type TilesetQaKernel = {
  inspectMvtTile(bytes: Uint8Array): MvtTileInspection;
  auditTilesetCoverage(
    bounds: Float64Array,
    minZoom: number,
    maxZoom: number,
    addressed: Uint32Array,
    sampleLimit: number,
    maxExpected: number,
  ): TilesetCoverageAudit;
  /** Revision diff of one tile (`maps-core::tileset_diff`); throws on an undecodable side. */
  diffMvtTiles(base: Uint8Array, candidate: Uint8Array, sampleLimit: number): MvtTileDiff;
  /**
   * Seam continuity of two adjacent tiles (`maps-core::tileset_seam`); `second` lies `edge` of
   * `first`. Throws on an undecodable side or an invalid tolerance.
   */
  checkMvtSeam(
    first: Uint8Array,
    second: Uint8Array,
    edge: MvtSeamEdge,
    slackUnits: number,
    offsetWindowUnits: number,
    sampleLimit: number,
  ): MvtSeam;
  /** `[west, south, east, north]` of a canonical tile. */
  tileLngLatBounds(z: number, x: number, y: number): Float64Array | number[];
};

export type MvtSeamEdge = "east" | "antimeridian" | "south";
export type MvtSeamCounts = {
  lineCrossings: number;
  lineSlackUsed: number;
  lineInterrupted: number;
  lineDuplicated: number;
  lineOffset: number;
  polygonGroups: number;
  polygonSlackUsed: number;
  polygonMismatches: number;
};
export type MvtSeamFindingKind =
  | "line-interrupted"
  | "line-duplicated"
  | "line-offset"
  | "polygon-edge-mismatch";
export type MvtSeamSide = "first" | "second";
export type MvtSeamFinding = {
  kind: MvtSeamFindingKind;
  layer: string;
  geometryType: "line" | "polygon";
  side: MvtSeamSide | null;
  strip: MvtSeamSide | null;
  along: [number, number];
  distanceUnits: number;
  properties: Record<string, unknown>;
};
export type MvtSeamLayer = {
  name: string;
  firstExtent: number | null;
  secondExtent: number | null;
  firstBuffer: number | null;
  secondBuffer: number | null;
  firstLineEvents: number;
  secondLineEvents: number;
  counts: MvtSeamCounts;
};
export type MvtSeam = {
  edge: MvtSeamEdge;
  counts: MvtSeamCounts;
  layers: MvtSeamLayer[];
  findings: MvtSeamFinding[];
  findingsTruncated: boolean;
};

export type MvtDiffCounts = {
  unchanged: number;
  added: number;
  removed: number;
  changed: number;
  ambiguous: number;
  unmatchedAdded: number;
  unmatchedRemoved: number;
};
export type MvtFeatureChangeKind =
  | "added"
  | "removed"
  | "changed"
  | "ambiguous"
  | "unmatched-added"
  | "unmatched-removed";
export type MvtFeatureChange = {
  kind: MvtFeatureChangeKind;
  layer: string;
  geometryType: "point" | "line" | "polygon";
  id: number | null;
  baseBounds: [number, number, number, number] | null;
  candidateBounds: [number, number, number, number] | null;
  geometryChanged: boolean;
  propertiesChanged: boolean;
  properties: Record<string, unknown>;
};
export type MvtLayerDiff = {
  name: string;
  presence: "both" | "added" | "removed";
  baseExtent: number | null;
  candidateExtent: number | null;
  comparable: boolean;
  baseFeatures: number;
  candidateFeatures: number;
  baseFeaturesWithId: number;
  candidateFeaturesWithId: number;
  counts: MvtDiffCounts;
  propertyKeysAdded: string[];
  propertyKeysRemoved: string[];
};
export type MvtTileDiff = {
  equal: boolean;
  counts: MvtDiffCounts;
  layers: MvtLayerDiff[];
  changes: MvtFeatureChange[];
  changesTruncated: boolean;
};

export type TilesetQaUpstreamVerify = {
  tool: string;
  version: string | null;
  outcome: "passed" | "failed";
  detail: string;
};

export type TilesetQaInput = {
  /** A Maps Tileset manifest or producer metadata; transport is not required. */
  manifest: unknown;
  archive: {
    /** A file name for the report, never a path or URL with credentials. */
    name: string;
    source: Source;
    bytes: number;
    /** SHA-256 of the exact archive bytes, computed by the host. */
    sha256: string;
  };
  /** Content pin published with the manifest (`archiveRef`), when there is one. */
  expectedArchive?: { sha256: string; bytes?: number } | null;
  /** Result of the pinned upstream validator; `null` when it did not run. */
  upstreamVerify: TilesetQaUpstreamVerify | null;
  kernel: TilesetQaKernel;
  /** Version of the upstream `pmtiles` reader in use. */
  pmtilesReaderVersion: string;
  fixtureId?: string | null;
  mode?: TilesetQaMode;
  seed?: number;
  limits?: Partial<TilesetQaLimits>;
  signal?: AbortSignal;
};

export type TilesetQaLayerSummary = {
  name: string;
  declared: boolean;
  tiles: number;
  features: number;
  points: number;
  lines: number;
  polygons: number;
  featuresWithId: number;
  extents: number[];
  propertyKeys: string[];
};

export type TilesetQaArtifact = {
  schema: typeof TILESET_QA_SCHEMA;
  checkVersion: string;
  fixtureId: string | null;
  status: TilesetQaStatus;
  mode: TilesetQaMode;
  seed: number;
  limits: TilesetQaLimits;
  source: {
    sourceId: string;
    dataRevision: string;
    schema: { id: string; version: string; sourceLayers: string[] };
    bounds: [number, number, number, number];
    minZoom: number;
    maxZoom: number;
    attribution: string;
    license: string;
    provenance: string;
  } | null;
  archive: {
    name: string;
    bytes: number;
    sha256: string;
    expectedSha256: string | null;
    expectedBytes: number | null;
    header: {
      specVersion: number;
      tileType: number;
      tileCompression: number;
      internalCompression: number;
      minZoom: number;
      maxZoom: number;
      bounds: [number, number, number, number];
      addressedTiles: number;
      tileEntries: number;
      tileContents: number;
    } | null;
  };
  tools: {
    pmtilesReader: string;
    upstreamVerify: { tool: string; version: string | null } | null;
  };
  checks: TilesetQaCheck[];
  findings: TilesetQaFinding[];
  coverage: Pick<
    TilesetCoverageAudit,
    "expected" | "covered" | "missing" | "outside" | "outOfZoomRange" | "addressed" | "byZoom"
  > | null;
  content: {
    addressedTiles: number;
    inspectedTiles: number;
    layers: TilesetQaLayerSummary[];
    /** Reproducible references: decoded byte length and SHA-256 of each inspected tile. */
    tiles: (TilesetQaTileRef & { bytes: number; sha256: string; features: number })[];
  } | null;
};

const CHECK_ORDER: TilesetQaCheckId[] = [
  "manifest",
  "archive-identity",
  "archive-header",
  "archive-metadata",
  "archive-directory",
  "upstream-verify",
  "tile-coverage",
  "tile-content",
];
const SHA256 = /^[0-9a-f]{64}$/;

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded choice of `count` tile indices, taken zoom by zoom so every level is represented. */
export function sampleTileIndices(tiles: Uint32Array, count: number, seed: number): number[] {
  const total = tiles.length / 3;
  if (total <= count) return Array.from({ length: total }, (_, index) => index);
  const byZoom = new Map<number, number[]>();
  for (let index = 0; index < total; index += 1) {
    const zoom = tiles[index * 3]!;
    let group = byZoom.get(zoom);
    if (!group) byZoom.set(zoom, (group = []));
    group.push(index);
  }
  const random = mulberry32(seed);
  const groups = [...byZoom.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => {
      for (let index = group.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [group[index], group[other]] = [group[other]!, group[index]!];
      }
      return group;
    });
  const chosen: number[] = [];
  for (let round = 0; chosen.length < count; round += 1) {
    for (const group of groups) {
      if (round < group.length && chosen.length < count) chosen.push(group[round]!);
    }
  }
  return chosen.sort((a, b) => a - b);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type Directory = {
  tiles: Uint32Array;
  tileEntries: number;
  exceeded: boolean;
  zeroLength: TilesetQaTileRef[];
  zeroLengthCount: number;
  outOfArchive: TilesetQaTileRef[];
  outOfArchiveCount: number;
};

/** Enumerate addressed tiles from the root and leaf directories; no tile bytes are read. */
export async function readDirectory(
  pmtiles: PMTiles,
  header: Header,
  archiveBytes: number,
  limits: Pick<TilesetQaLimits, "maxAddressedTiles" | "tilesPerFinding">,
  signal: AbortSignal | undefined,
): Promise<Directory> {
  const packed: number[] = [];
  const result: Omit<Directory, "tiles"> = {
    tileEntries: 0,
    exceeded: false,
    zeroLength: [],
    zeroLengthCount: 0,
    outOfArchive: [],
    outOfArchiveCount: 0,
  };
  const note = (list: TilesetQaTileRef[], entry: Entry) => {
    if (list.length >= limits.tilesPerFinding) return;
    const [z, x, y] = tileIdToZxy(entry.tileId);
    list.push({ z, x, y });
  };
  const visit = async (offset: number, length: number, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await pmtiles.cache.getDirectory(
      pmtiles.source,
      offset,
      length,
      header,
      signal,
    );
    signal?.throwIfAborted();
    for (const entry of entries) {
      if (result.exceeded) return;
      if (entry.runLength === 0) {
        if (depth >= 3) throw new Error("directory depth exceeds the PMTiles v3 limit");
        await visit(header.leafDirectoryOffset + entry.offset, entry.length, depth + 1);
        continue;
      }
      result.tileEntries += 1;
      if (entry.length === 0) {
        result.zeroLengthCount += entry.runLength;
        note(result.zeroLength, entry);
      } else if (header.tileDataOffset + entry.offset + entry.length > archiveBytes) {
        result.outOfArchiveCount += entry.runLength;
        note(result.outOfArchive, entry);
      }
      if (packed.length / 3 + entry.runLength > limits.maxAddressedTiles) {
        result.exceeded = true;
        return;
      }
      for (let run = 0; run < entry.runLength; run += 1) {
        const [z, x, y] = tileIdToZxy(entry.tileId + run);
        packed.push(z, x, y);
      }
    }
  };
  await visit(header.rootDirectoryOffset, header.rootDirectoryLength, 0);
  return { ...result, tiles: Uint32Array.from(packed) };
}

/** Run every check and return the artifact. Rejects only when `signal` aborts. */
export async function runTilesetQa(input: TilesetQaInput): Promise<TilesetQaArtifact> {
  const { signal, kernel } = input;
  const mode = input.mode ?? "sampled";
  const seed = (input.seed ?? 1) >>> 0;
  const limits = { ...(mode === "full" ? FULL_LIMITS : SAMPLED_LIMITS), ...input.limits };
  const checks = new Map<TilesetQaCheckId, { status: TilesetQaStatus; summary: string }>();
  const findings: TilesetQaFinding[] = [];
  const refs = (tiles: readonly (readonly [number, number, number])[]): TilesetQaTileRef[] =>
    tiles.slice(0, limits.tilesPerFinding).map(([z, x, y]) => ({ z, x, y }));
  const find = (
    check: TilesetQaCheckId,
    code: string,
    severity: TilesetQaSeverity,
    message: string,
    count = 1,
    tiles: TilesetQaTileRef[] = [],
  ) => {
    const existing = findings.find((entry) => entry.check === check && entry.code === code);
    if (!existing) {
      findings.push({ check, code, severity, message, count, tiles: [...tiles] });
      return;
    }
    existing.count += count;
    for (const tile of tiles) {
      if (existing.tiles.length < limits.tilesPerFinding) existing.tiles.push(tile);
    }
  };
  /** A check fails on any error finding; `inconclusive` must be stated by the caller. */
  const settle = (id: TilesetQaCheckId, summary: string, inconclusive = false) => {
    const failed = findings.some((entry) => entry.check === id && entry.severity === "error");
    checks.set(id, {
      status: failed ? "failed" : inconclusive ? "inconclusive" : "passed",
      summary,
    });
  };
  const skip = (ids: TilesetQaCheckId[], reason: string) => {
    for (const id of ids) {
      if (!checks.has(id)) checks.set(id, { status: "inconclusive", summary: reason });
    }
  };

  signal?.throwIfAborted();

  // Manifest: the Map View's own validator decides.
  let manifest: MapsTilesetMetadata | null = null;
  try {
    manifest = validateMapsTilesetMetadata(input.manifest);
    settle("manifest", "manifest is valid Maps Tileset metadata");
  } catch (error) {
    find("manifest", "invalid-manifest", "error", describe(error));
    settle("manifest", "manifest is not valid Maps Tileset metadata");
  }

  // Archive identity: exact bytes against the published content pin.
  const declared = input.expectedArchive ?? null;
  const revisionDigest = /^sha256:([0-9a-f]{64})$/.exec(manifest?.dataRevision ?? "")?.[1] ?? null;
  const expectedSha256 = declared?.sha256 ?? revisionDigest;
  const expectedBytes = declared?.bytes ?? null;
  if (!SHA256.test(input.archive.sha256)) {
    find("archive-identity", "archive-hash-unavailable", "warning", "archive was not hashed");
    settle("archive-identity", "archive SHA-256 is unavailable", true);
  } else if (!expectedSha256) {
    find(
      "archive-identity",
      "content-hash-undeclared",
      "warning",
      "neither an archive reference nor a sha256 data revision pins the archive bytes",
    );
    settle("archive-identity", "no declared content hash to compare with", true);
  } else {
    for (const [code, expected] of [
      ["archive-hash-mismatch", declared?.sha256],
      ["revision-hash-mismatch", revisionDigest],
    ] as const) {
      if (expected && expected !== input.archive.sha256) {
        find(
          "archive-identity",
          code,
          "error",
          `archive SHA-256 ${input.archive.sha256} differs from declared ${expected}`,
        );
      }
    }
    if (expectedBytes !== null && expectedBytes !== input.archive.bytes) {
      find(
        "archive-identity",
        "archive-size-mismatch",
        "error",
        `archive has ${input.archive.bytes} bytes, declared ${expectedBytes}`,
      );
    }
    settle("archive-identity", `archive bytes compared with declared SHA-256 ${expectedSha256}`);
  }

  // Upstream validator: only the pinned tool's own verdict counts.
  const upstream = input.upstreamVerify;
  if (!upstream) {
    find(
      "upstream-verify",
      "upstream-verify-unavailable",
      "warning",
      `${TILESET_QA_UPSTREAM.tool} ${TILESET_QA_UPSTREAM.version} verify did not run`,
    );
    settle("upstream-verify", "pinned upstream validator did not run", true);
  } else if (
    upstream.tool !== TILESET_QA_UPSTREAM.tool ||
    upstream.version !== TILESET_QA_UPSTREAM.version
  ) {
    find(
      "upstream-verify",
      "upstream-version-mismatch",
      "warning",
      `ran ${upstream.tool} ${upstream.version ?? "unknown"}, pinned is ${TILESET_QA_UPSTREAM.tool} ${TILESET_QA_UPSTREAM.version}`,
    );
    settle("upstream-verify", "upstream validator is not the pinned version", true);
  } else {
    if (upstream.outcome === "failed") {
      find("upstream-verify", "upstream-verify-failed", "error", upstream.detail);
    }
    settle("upstream-verify", `${upstream.tool} ${upstream.version} verify ${upstream.outcome}`);
  }

  const artifact = (
    header: Header | null,
    coverage: TilesetQaArtifact["coverage"],
    content: TilesetQaArtifact["content"],
  ): TilesetQaArtifact => {
    const ordered = CHECK_ORDER.map((id) => ({ id, ...checks.get(id)! }));
    const status = ordered.some((check) => check.status === "failed")
      ? "failed"
      : ordered.some((check) => check.status === "inconclusive")
        ? "inconclusive"
        : "passed";
    return {
      schema: TILESET_QA_SCHEMA,
      checkVersion: TILESET_QA_CHECK_VERSION,
      fixtureId: input.fixtureId ?? null,
      status,
      mode,
      seed,
      limits,
      source: manifest && {
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
      },
      archive: {
        name: input.archive.name,
        bytes: input.archive.bytes,
        sha256: input.archive.sha256,
        expectedSha256,
        expectedBytes,
        header: header && {
          specVersion: header.specVersion,
          tileType: header.tileType,
          tileCompression: header.tileCompression,
          internalCompression: header.internalCompression,
          minZoom: header.minZoom,
          maxZoom: header.maxZoom,
          bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
          addressedTiles: header.numAddressedTiles,
          tileEntries: header.numTileEntries,
          tileContents: header.numTileContents,
        },
      },
      tools: {
        pmtilesReader: input.pmtilesReaderVersion,
        upstreamVerify: upstream && { tool: upstream.tool, version: upstream.version },
      },
      checks: ordered,
      findings: [...findings].sort(
        (a, b) =>
          CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check) ||
          (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
      ),
      coverage,
      content,
    };
  };
  const dependent: TilesetQaCheckId[] = [
    "archive-header",
    "archive-metadata",
    "archive-directory",
    "tile-coverage",
    "tile-content",
  ];
  if (!manifest) {
    skip(dependent, "not evaluated: the manifest is invalid");
    return artifact(null, null, null);
  }

  // Header: readable at all, then the Map View's activation rules.
  const pmtiles = new PMTiles(input.archive.source, new SharedPromiseCache(16));
  let header: Header;
  try {
    header = await pmtiles.getHeader();
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    find("archive-header", "unreadable-archive", "error", describe(error));
    settle("archive-header", "archive header could not be read");
    skip(dependent, "not evaluated: the archive header is unreadable");
    return artifact(null, null, null);
  }
  try {
    validateArchiveHeader(manifest, header);
  } catch (error) {
    find("archive-header", "header-conflict", "error", describe(error));
  }
  settle("archive-header", "PMTiles v3 header compared with the manifest");

  // Metadata: declared source layers and schema.
  let metadata: unknown = null;
  try {
    metadata = await pmtiles.getMetadata();
    signal?.throwIfAborted();
    validateArchiveMetadata(manifest, metadata);
  } catch (error) {
    signal?.throwIfAborted();
    find("archive-metadata", "metadata-conflict", "error", describe(error));
  }
  settle("archive-metadata", "archive JSON metadata compared with the manifest");
  const declaredFields = new Map<string, Set<string>>();
  const vectorLayers = (metadata as { vector_layers?: unknown } | null)?.vector_layers;
  if (Array.isArray(vectorLayers)) {
    for (const layer of vectorLayers as { id?: unknown; fields?: unknown }[]) {
      if (typeof layer?.id !== "string" || !layer.fields || typeof layer.fields !== "object") {
        continue;
      }
      const fields = Object.keys(layer.fields);
      if (fields.length) declaredFields.set(layer.id, new Set(fields));
    }
  }

  // Directory: which tiles are addressed, and whether the header agrees.
  let directory: Directory;
  try {
    directory = await readDirectory(pmtiles, header, input.archive.bytes, limits, signal);
  } catch (error) {
    signal?.throwIfAborted();
    find("archive-directory", "unreadable-directory", "error", describe(error));
    settle("archive-directory", "tile directory could not be read");
    skip(dependent, "not evaluated: the tile directory is unreadable");
    return artifact(header, null, null);
  }
  if (directory.exceeded) {
    find(
      "archive-directory",
      "addressed-tile-budget-exceeded",
      "warning",
      `archive addresses more than ${limits.maxAddressedTiles} tiles`,
    );
    settle("archive-directory", "directory scan stopped at the addressed-tile budget", true);
    skip(dependent, "not evaluated: the directory scan exceeded its budget");
    return artifact(header, null, null);
  }
  const addressed = directory.tiles.length / 3;
  if (addressed !== header.numAddressedTiles) {
    find(
      "archive-directory",
      "addressed-count-mismatch",
      "error",
      `directory addresses ${addressed} tiles, header declares ${header.numAddressedTiles}`,
    );
  }
  if (directory.tileEntries !== header.numTileEntries) {
    find(
      "archive-directory",
      "entry-count-mismatch",
      "error",
      `directory has ${directory.tileEntries} tile entries, header declares ${header.numTileEntries}`,
    );
  }
  if (directory.zeroLengthCount) {
    find(
      "archive-directory",
      "zero-length-tile",
      "error",
      "directory entry addresses a tile with no bytes",
      directory.zeroLengthCount,
      directory.zeroLength,
    );
  }
  if (directory.outOfArchiveCount) {
    find(
      "archive-directory",
      "tile-beyond-archive",
      "error",
      "directory entry points past the end of the archive",
      directory.outOfArchiveCount,
      directory.outOfArchive,
    );
  }
  settle("archive-directory", `${addressed} addressed tiles in ${directory.tileEntries} entries`);

  // Coverage: the tiles the declared bounds and zoom range require (Rust rule).
  let coverage: TilesetQaArtifact["coverage"] = null;
  try {
    const audit = kernel.auditTilesetCoverage(
      Float64Array.from(manifest.bounds),
      manifest.minZoom,
      manifest.maxZoom,
      directory.tiles,
      limits.tilesPerFinding,
      limits.maxExpectedTiles,
    );
    coverage = {
      expected: audit.expected,
      covered: audit.covered,
      missing: audit.missing,
      outside: audit.outside,
      outOfZoomRange: audit.outOfZoomRange,
      addressed: audit.addressed,
      byZoom: audit.byZoom,
    };
    if (audit.missing) {
      find(
        "tile-coverage",
        "missing-tile",
        "error",
        "tile inside the declared bounds and zoom range is not in the archive; the Map View fails closed on it",
        audit.missing,
        refs(audit.missingTiles),
      );
    }
    if (audit.outOfZoomRange) {
      find(
        "tile-coverage",
        "tile-outside-zoom-range",
        "error",
        "archive addresses a tile outside the declared zoom range",
        audit.outOfZoomRange,
        refs(audit.outOfZoomRangeTiles),
      );
    }
    if (audit.outside) {
      find(
        "tile-coverage",
        "tile-outside-bounds",
        "warning",
        "archive addresses a tile outside the declared bounds; the Map View never requests it",
        audit.outside,
        refs(audit.outsideTiles),
      );
    }
    settle(
      "tile-coverage",
      `${audit.covered} of ${audit.expected} required tiles present, ${audit.missing} missing`,
    );
  } catch (error) {
    find("tile-coverage", "coverage-not-evaluated", "warning", describe(error));
    settle("tile-coverage", "declared coverage could not be enumerated within budget", true);
  }

  // Content: decode a bounded set of tiles with the runtime MVT decoder.
  const wanted = mode === "full" ? limits.maxContentTiles : limits.sampleTiles;
  const indices = sampleTileIndices(directory.tiles, wanted, seed);
  const declaredLayers = new Set(manifest.schema.sourceLayers);
  const layers = new Map<string, TilesetQaLayerSummary & { keys: Set<string> }>();
  const inspected: NonNullable<TilesetQaArtifact["content"]>["tiles"] = [];
  for (const index of indices) {
    signal?.throwIfAborted();
    const tile = {
      z: directory.tiles[index * 3]!,
      x: directory.tiles[index * 3 + 1]!,
      y: directory.tiles[index * 3 + 2]!,
    };
    let bytes: Uint8Array;
    try {
      const response = await pmtiles.getZxy(tile.z, tile.x, tile.y, signal);
      signal?.throwIfAborted();
      if (!response) {
        find("tile-content", "unreadable-tile", "error", "addressed tile has no data", 1, [tile]);
        continue;
      }
      bytes = new Uint8Array(response.data);
    } catch (error) {
      signal?.throwIfAborted();
      find("tile-content", "unreadable-tile", "error", describe(error), 1, [tile]);
      continue;
    }
    if (!bytes.length || bytes.length > MAX_DECODED_TILE_BYTES) {
      find(
        "tile-content",
        bytes.length ? "oversized-tile" : "empty-tile",
        "error",
        "the Map View rejects an empty tile or one above its decoded size limit",
        1,
        [tile],
      );
      continue;
    }
    let inspection: MvtTileInspection;
    try {
      inspection = kernel.inspectMvtTile(bytes);
    } catch (error) {
      find("tile-content", "undecodable-tile", "error", describe(error), 1, [tile]);
      continue;
    }
    inspected.push({
      ...tile,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
      features: inspection.features,
    });
    if (!inspection.features) {
      find("tile-content", "featureless-tile", "warning", "tile decodes to no feature", 1, [tile]);
    }
    if (inspection.duplicateLayers.length) {
      find(
        "tile-content",
        "duplicate-source-layer",
        "error",
        `tile repeats source layer ${inspection.duplicateLayers.join(", ")}`,
        1,
        [tile],
      );
    }
    for (const layer of inspection.layers) {
      let summary = layers.get(layer.name);
      if (!summary) {
        summary = {
          name: layer.name,
          declared: declaredLayers.has(layer.name),
          tiles: 0,
          features: 0,
          points: 0,
          lines: 0,
          polygons: 0,
          featuresWithId: 0,
          extents: [],
          propertyKeys: [],
          keys: new Set(),
        };
        layers.set(layer.name, summary);
      }
      summary.tiles += 1;
      summary.features += layer.features;
      summary.points += layer.points;
      summary.lines += layer.lines;
      summary.polygons += layer.polygons;
      summary.featuresWithId += layer.featuresWithId;
      if (!summary.extents.includes(layer.extent)) summary.extents.push(layer.extent);
      for (const key of layer.propertyKeys) summary.keys.add(key);
      if (!summary.declared) {
        find(
          "tile-content",
          "undeclared-source-layer",
          "error",
          `tile carries source layer the manifest does not declare: ${layer.name}`,
          1,
          [tile],
        );
      }
      const fields = declaredFields.get(layer.name);
      const unknown = fields ? layer.propertyKeys.filter((key) => !fields.has(key)) : [];
      if (unknown.length) {
        find(
          "tile-content",
          "undeclared-property",
          "warning",
          `feature property is absent from the archive's vector_layers fields: ${layer.name}.${unknown[0]}`,
          1,
          [tile],
        );
      }
    }
  }
  const complete = indices.length === addressed;
  for (const name of manifest.schema.sourceLayers) {
    if (layers.has(name)) continue;
    find(
      "tile-content",
      "declared-layer-unobserved",
      complete ? "warning" : "info",
      complete
        ? `no tile carries declared source layer ${name}`
        : `no inspected tile carries declared source layer ${name}`,
    );
  }
  settle(
    "tile-content",
    `${inspected.length} of ${indices.length} inspected tiles decoded (${addressed} addressed)`,
    !indices.length || (mode === "full" && !complete),
  );
  const content: TilesetQaArtifact["content"] = {
    addressedTiles: addressed,
    inspectedTiles: indices.length,
    layers: [...layers.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(({ keys, ...summary }) => ({
        ...summary,
        extents: [...summary.extents].sort((a, b) => a - b),
        propertyKeys: [...keys].sort().slice(0, 64),
      })),
    tiles: inspected.slice(0, limits.reportedTiles),
  };
  return artifact(header, coverage, content);
}
