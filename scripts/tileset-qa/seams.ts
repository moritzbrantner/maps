// Tile seam QA (#276, part 3): whether lines and polygons continue across the shared edges of
// adjacent tiles in one archive, and the bounded `maps-tileset-seams-v1` artifact.
//
// The directory gives every edge-adjacent pair of addressed tiles at each zoom (the eastern
// neighbour wraps at the antimeridian; a single-tile zoom is its own eastern neighbour). A
// seeded per-zoom sample of pairs, or all of them in `full` mode, goes through the Rust kernel
// (`maps-core::tileset_seam`, the runtime MVT decoder), which accounts for tile-local clipping,
// quantization and a provider slack. An edge whose neighbour is not addressed is not a seam;
// missing coverage is part 1's `tile-coverage` check. Runs in Node and the browser.
import {
  PMTiles,
  SharedPromiseCache,
  TileType,
  zxyToTileId,
  type Header,
  type Source,
} from "pmtiles";

import { MAX_DECODED_TILE_BYTES } from "../../src/maps-tileset-transport";
import { validateMapsTilesetMetadata, type MapsTilesetMetadata } from "../../src/maps-tileset";
import {
  describe,
  readDirectory,
  sampleTileIndices,
  type MvtSeam,
  type MvtSeamCounts,
  type MvtSeamEdge,
  type MvtSeamFinding,
  type TilesetQaKernel,
  type TilesetQaLimits,
  type TilesetQaMode,
  type TilesetQaSeverity,
  type TilesetQaStatus,
} from "./core";

export const TILESET_SEAMS_SCHEMA = "maps-tileset-seams-v1";
/** Bump when a check's meaning changes; artifacts of different versions are not comparable. */
export const TILESET_SEAMS_CHECK_VERSION = "1.0.0";

export type TilesetSeamsCheckId = "archive" | "pairs" | "line-seams" | "polygon-seams";
export type TilesetSeamsTileRef = {
  z: number;
  x: number;
  y: number;
  /** `[west, south, east, north]` from the Rust tile rule. */
  bounds: [number, number, number, number];
};
export type TilesetSeamsCheck = {
  id: TilesetSeamsCheckId;
  status: TilesetQaStatus;
  summary: string;
};
export type TilesetSeamsFinding = {
  check: TilesetSeamsCheckId;
  code: string;
  severity: TilesetQaSeverity;
  message: string;
  count: number;
  tiles: TilesetSeamsTileRef[];
};
export type TilesetSeamsLimits = Pick<TilesetQaLimits, "maxAddressedTiles" | "tilesPerFinding"> & {
  /** Pairs checked in `sampled` mode. */
  samplePairs: number;
  /** Pairs checked at most in `full` mode; more make the seam checks inconclusive. */
  maxPairs: number;
  /** Defective pairs listed in the artifact. */
  reportedPairs: number;
  /** Kernel findings kept per listed pair. */
  findingsPerPair: number;
  /** Decoded tile bytes kept for reuse by neighbouring pairs. */
  cacheBytes: number;
};
/** Provider allowance on top of the ±0.5-unit quantization of every vertex. */
export type TilesetSeamsTolerance = {
  /** Extra offset allowed for per-tile simplification, in units of the finer extent. */
  slackUnits: number;
  /** A leftover line event within this distance of a counterpart is a displaced line. */
  offsetWindowUnits: number;
};

const SAMPLED_LIMITS: TilesetSeamsLimits = {
  samplePairs: 32,
  maxPairs: 32,
  maxAddressedTiles: 250_000,
  tilesPerFinding: 16,
  reportedPairs: 32,
  findingsPerPair: 16,
  cacheBytes: 64 * 1024 * 1024,
};
const FULL_LIMITS: TilesetSeamsLimits = {
  ...SAMPLED_LIMITS,
  maxPairs: 20_000,
  maxAddressedTiles: 4_000_000,
};
export const DEFAULT_SEAM_TOLERANCE: TilesetSeamsTolerance = {
  slackUnits: 2,
  offsetWindowUnits: 64,
};

export type TilesetSeamsInput = {
  manifest: unknown;
  archive: { name: string; source: Source; bytes: number; sha256: string };
  kernel: TilesetQaKernel;
  pmtilesReaderVersion: string;
  fixtureId?: string | null;
  mode?: TilesetQaMode;
  seed?: number;
  limits?: Partial<TilesetSeamsLimits>;
  tolerance?: Partial<TilesetSeamsTolerance>;
  signal?: AbortSignal;
};

export type TilesetSeamsPair = {
  /** `antimeridian`: the eastern neighbour of the last column is the first column. */
  edge: MvtSeamEdge;
  first: TilesetSeamsTileRef;
  second: TilesetSeamsTileRef;
  /** Union of both tiles; the first tile alone across the antimeridian. */
  bounds: [number, number, number, number];
};

export type TilesetSeamsReportedPair = TilesetSeamsPair & {
  status: "defective" | "unreadable" | "undecodable";
  counts: MvtSeamCounts | null;
  findings: MvtSeamFinding[];
  findingsTruncated: boolean;
  reason: string;
};

export type TilesetSeamsLayerSummary = {
  name: string;
  /** Checked pairs in which either tile carries the layer. */
  pairs: number;
  extents: number[];
  /** Smallest and largest reach beyond the tile seen in the layer; `0` is clipped at the edge. */
  buffer: [number, number] | null;
  counts: MvtSeamCounts;
};

export type TilesetSeamsArtifact = {
  schema: typeof TILESET_SEAMS_SCHEMA;
  checkVersion: string;
  fixtureId: string | null;
  status: TilesetQaStatus;
  mode: TilesetQaMode;
  seed: number;
  limits: TilesetSeamsLimits;
  tolerance: TilesetSeamsTolerance & { quantizationUnits: number };
  source: {
    sourceId: string;
    dataRevision: string;
    bounds: [number, number, number, number];
    minZoom: number;
    maxZoom: number;
    provenance: string;
    archive: {
      name: string;
      bytes: number;
      sha256: string;
      tileCompression: number | null;
    };
  } | null;
  tools: { pmtilesReader: string };
  checks: TilesetSeamsCheck[];
  findings: TilesetSeamsFinding[];
  pairs: {
    addressedTiles: number;
    adjacent: number;
    east: number;
    south: number;
    antimeridian: number;
    /** Tile edges inside the pyramid whose neighbour is not addressed; not checked. */
    withoutNeighbour: number;
    checked: number;
    complete: boolean;
    byZoom: { zoom: number; adjacent: number; checked: number }[];
  } | null;
  seams: {
    counts: MvtSeamCounts;
    layers: TilesetSeamsLayerSummary[];
    defectivePairs: number;
    reported: TilesetSeamsReportedPair[];
  } | null;
};

const CHECK_ORDER: TilesetSeamsCheckId[] = ["archive", "pairs", "line-seams", "polygon-seams"];

const zeroCounts = (): MvtSeamCounts => ({
  lineCrossings: 0,
  lineSlackUsed: 0,
  lineInterrupted: 0,
  lineDuplicated: 0,
  lineOffset: 0,
  polygonGroups: 0,
  polygonSlackUsed: 0,
  polygonMismatches: 0,
});
const addCounts = (into: MvtSeamCounts, from: MvtSeamCounts) => {
  for (const key of Object.keys(into) as (keyof MvtSeamCounts)[]) into[key] += from[key];
};
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Kernel counts that are defects, with their finding code, check and message. */
const DEFECTS: [keyof MvtSeamCounts, string, TilesetSeamsCheckId, string][] = [
  [
    "lineInterrupted",
    "line-interrupted",
    "line-seams",
    "a line reaches the shared edge on one side only",
  ],
  [
    "lineDuplicated",
    "line-duplicated",
    "line-seams",
    "an unpaired line event coincides with another of the same side",
  ],
  [
    "lineOffset",
    "line-offset",
    "line-seams",
    "a line continues across the edge displaced beyond the tolerance",
  ],
  [
    "polygonMismatches",
    "polygon-edge-mismatch",
    "polygon-seams",
    "part of the shared edge is covered by a polygon on one side only",
  ],
];

/** Run the seam checks and return the artifact. Rejects only when `signal` aborts. */
export async function runTilesetSeams(input: TilesetSeamsInput): Promise<TilesetSeamsArtifact> {
  const { signal, kernel } = input;
  const mode = input.mode ?? "sampled";
  const seed = (input.seed ?? 1) >>> 0;
  const limits = {
    ...(mode === "full" ? FULL_LIMITS : SAMPLED_LIMITS),
    ...input.limits,
  };
  const tolerance = { ...DEFAULT_SEAM_TOLERANCE, ...input.tolerance };
  const checks = new Map<TilesetSeamsCheckId, { status: TilesetQaStatus; summary: string }>();
  const findings: TilesetSeamsFinding[] = [];
  const ref = (z: number, x: number, y: number): TilesetSeamsTileRef => {
    const [west, south, east, north] = kernel.tileLngLatBounds(z, x, y);
    return { z, x, y, bounds: [west!, south!, east!, north!] };
  };
  const find = (
    check: TilesetSeamsCheckId,
    code: string,
    severity: TilesetQaSeverity,
    message: string,
    count = 1,
    tiles: TilesetSeamsTileRef[] = [],
  ) => {
    if (count <= 0) return;
    let entry = findings.find((existing) => existing.check === check && existing.code === code);
    if (!entry) {
      findings.push((entry = { check, code, severity, message, count: 0, tiles: [] }));
    }
    entry.count += count;
    for (const tile of tiles) {
      if (entry.tiles.length >= limits.tilesPerFinding) break;
      if (
        !entry.tiles.some((seen) => seen.z === tile.z && seen.x === tile.x && seen.y === tile.y)
      ) {
        entry.tiles.push(tile);
      }
    }
  };
  const settle = (id: TilesetSeamsCheckId, summary: string, inconclusive = false) => {
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

  let source: TilesetSeamsArtifact["source"] = null;
  let pairs: TilesetSeamsArtifact["pairs"] = null;
  let seams: TilesetSeamsArtifact["seams"] = null;
  const artifact = (): TilesetSeamsArtifact => {
    const ordered = CHECK_ORDER.map((id) => ({ id, ...checks.get(id)! }));
    return {
      schema: TILESET_SEAMS_SCHEMA,
      checkVersion: TILESET_SEAMS_CHECK_VERSION,
      fixtureId: input.fixtureId ?? null,
      status: ordered.some((check) => check.status === "failed")
        ? "failed"
        : ordered.some((check) => check.status === "inconclusive")
          ? "inconclusive"
          : "passed",
      mode,
      seed,
      limits,
      tolerance: { quantizationUnits: 0.5, ...tolerance },
      source,
      tools: { pmtilesReader: input.pmtilesReaderVersion },
      checks: ordered,
      findings: [...findings].sort(
        (a, b) =>
          CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check) ||
          compareText(a.code, b.code),
      ),
      pairs,
      seams,
    };
  };

  signal?.throwIfAborted();

  // Archive: a valid manifest, a readable MVT archive and its directory.
  let manifest: MapsTilesetMetadata;
  try {
    manifest = validateMapsTilesetMetadata(input.manifest);
  } catch (error) {
    find("archive", "invalid-manifest", "error", describe(error));
    settle("archive", "the manifest is not valid Maps Tileset metadata");
    skip("not evaluated: the manifest is invalid");
    return artifact();
  }
  const reader = new PMTiles(input.archive.source, new SharedPromiseCache(16));
  let header: Header | null = null;
  try {
    header = await reader.getHeader();
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    find("archive", "unreadable-archive", "error", describe(error));
  }
  source = {
    sourceId: manifest.sourceId,
    dataRevision: manifest.dataRevision,
    bounds: [...manifest.bounds],
    minZoom: manifest.minZoom,
    maxZoom: manifest.maxZoom,
    provenance: manifest.provenance,
    archive: {
      name: input.archive.name,
      bytes: input.archive.bytes,
      sha256: input.archive.sha256,
      tileCompression: header?.tileCompression ?? null,
    },
  };
  if (header && header.tileType !== TileType.Mvt) {
    find("archive", "not-vector-tiles", "error", `tile type ${header.tileType} is not MVT`);
  }
  if (!header || header.tileType !== TileType.Mvt) {
    settle("archive", "the archive is not a readable MVT archive");
    skip("not evaluated: the archive is not a readable MVT archive");
    return artifact();
  }
  let tiles: Uint32Array;
  try {
    const directory = await readDirectory(reader, header, input.archive.bytes, limits, signal);
    if (directory.exceeded) {
      find(
        "archive",
        "addressed-tile-budget-exceeded",
        "warning",
        `the archive addresses more than ${limits.maxAddressedTiles} tiles`,
      );
      settle("archive", "the directory exceeds the budget", true);
      skip("not evaluated: the directory exceeds the budget");
      return artifact();
    }
    tiles = directory.tiles;
  } catch (error) {
    signal?.throwIfAborted();
    find("archive", "unreadable-directory", "error", describe(error));
    settle("archive", "the tile directory could not be enumerated");
    skip("not evaluated: the tile directory could not be enumerated");
    return artifact();
  }
  const total = tiles.length / 3;
  settle("archive", `${total} addressed tiles`);

  // Pairs: every edge-adjacent pair of addressed tiles, in tile-ID order.
  const addressed = new Set<number>();
  for (let index = 0; index < total; index += 1) {
    addressed.add(zxyToTileId(tiles[index * 3]!, tiles[index * 3 + 1]!, tiles[index * 3 + 2]!));
  }
  type Pair = {
    z: number;
    x: number;
    y: number;
    edge: MvtSeamEdge;
    nx: number;
    ny: number;
  };
  const all: (Pair & { id: number })[] = [];
  let withoutNeighbour = 0;
  const lonely: TilesetSeamsTileRef[] = [];
  const byZoom = new Map<number, { zoom: number; adjacent: number; checked: number }>();
  for (let index = 0; index < total; index += 1) {
    const [z, x, y] = [tiles[index * 3]!, tiles[index * 3 + 1]!, tiles[index * 3 + 2]!];
    const size = 2 ** z;
    const neighbours: [MvtSeamEdge, number, number][] = [
      x + 1 < size ? ["east", x + 1, y] : ["antimeridian", 0, y],
    ];
    if (y + 1 < size) neighbours.push(["south", x, y + 1]);
    for (const [edge, nx, ny] of neighbours) {
      if (addressed.has(zxyToTileId(z, nx, ny))) {
        all.push({ id: zxyToTileId(z, x, y), z, x, y, edge, nx, ny });
        let level = byZoom.get(z);
        if (!level) byZoom.set(z, (level = { zoom: z, adjacent: 0, checked: 0 }));
        level.adjacent += 1;
      } else {
        withoutNeighbour += 1;
        if (lonely.length < limits.tilesPerFinding) lonely.push(ref(z, x, y));
      }
    }
  }
  all.sort((a, b) => a.id - b.id || compareText(a.edge, b.edge));
  find(
    "pairs",
    "edge-without-neighbour",
    "info",
    "tile edge whose neighbour is not addressed; not a seam (coverage is the integrity audit's check)",
    withoutNeighbour,
    lonely,
  );
  const wanted = mode === "full" ? limits.maxPairs : limits.samplePairs;
  const packed = Uint32Array.from(all.flatMap((pair) => [pair.z, pair.x, pair.y]));
  const chosen = sampleTileIndices(packed, wanted, seed).map((index) => all[index]!);
  const complete = chosen.length === all.length;
  pairs = {
    addressedTiles: total,
    adjacent: all.length,
    east: all.filter((pair) => pair.edge === "east").length,
    south: all.filter((pair) => pair.edge === "south").length,
    antimeridian: all.filter((pair) => pair.edge === "antimeridian").length,
    withoutNeighbour,
    checked: 0,
    complete,
    byZoom: [...byZoom.values()].sort((a, b) => a.zoom - b.zoom),
  };

  // Seams: each chosen pair through the kernel. Decoded tiles are cached for their neighbours.
  const cache = new Map<number, Uint8Array>();
  let cached = 0;
  const read = async (z: number, x: number, y: number) => {
    const id = zxyToTileId(z, x, y);
    const hit = cache.get(id);
    if (hit) return hit;
    const response = await reader.getZxy(z, x, y, signal);
    signal?.throwIfAborted();
    if (!response) throw new Error(`tile ${z}/${x}/${y} has no data`);
    const bytes = new Uint8Array(response.data);
    if (!bytes.length || bytes.length > MAX_DECODED_TILE_BYTES) {
      throw new Error(`tile ${z}/${x}/${y} is empty or above the decoded size limit`);
    }
    cache.set(id, bytes);
    cached += bytes.length;
    for (const [key, value] of cache) {
      if (cached <= limits.cacheBytes) break;
      cache.delete(key);
      cached -= value.length;
    }
    return bytes;
  };
  const totals = zeroCounts();
  const layers = new Map<string, TilesetSeamsLayerSummary & { extentSet: Set<number> }>();
  const reported: TilesetSeamsReportedPair[] = [];
  let defectivePairs = 0;
  let failedPairs = 0;
  for (const pair of chosen) {
    signal?.throwIfAborted();
    const first = ref(pair.z, pair.x, pair.y);
    const second = ref(pair.z, pair.nx, pair.ny);
    const described: TilesetSeamsPair = {
      edge: pair.edge,
      first,
      second,
      bounds:
        pair.edge === "antimeridian"
          ? first.bounds
          : [
              Math.min(first.bounds[0], second.bounds[0]),
              Math.min(first.bounds[1], second.bounds[1]),
              Math.max(first.bounds[2], second.bounds[2]),
              Math.max(first.bounds[3], second.bounds[3]),
            ],
    };
    pairs.checked += 1;
    byZoom.get(pair.z)!.checked += 1;
    const fail = (status: "unreadable" | "undecodable", reason: string) => {
      failedPairs += 1;
      find("pairs", `${status}-tile`, "error", reason, 1, [first, second]);
      if (reported.length < limits.reportedPairs) {
        reported.push({
          ...described,
          status,
          counts: null,
          findings: [],
          findingsTruncated: false,
          reason,
        });
      }
    };
    let firstBytes: Uint8Array;
    let secondBytes: Uint8Array;
    try {
      firstBytes = await read(pair.z, pair.x, pair.y);
      secondBytes = await read(pair.z, pair.nx, pair.ny);
    } catch (error) {
      signal?.throwIfAborted();
      fail("unreadable", describe(error));
      continue;
    }
    let seam: MvtSeam;
    try {
      seam = kernel.checkMvtSeam(
        firstBytes,
        secondBytes,
        pair.edge,
        tolerance.slackUnits,
        tolerance.offsetWindowUnits,
        limits.findingsPerPair,
      );
    } catch (error) {
      fail("undecodable", describe(error));
      continue;
    }
    addCounts(totals, seam.counts);
    for (const layer of seam.layers) {
      let summary = layers.get(layer.name);
      if (!summary) {
        summary = {
          name: layer.name,
          pairs: 0,
          extents: [],
          buffer: null,
          counts: zeroCounts(),
          extentSet: new Set(),
        };
        layers.set(layer.name, summary);
      }
      summary.pairs += 1;
      addCounts(summary.counts, layer.counts);
      for (const extent of [layer.firstExtent, layer.secondExtent]) {
        if (extent !== null) summary.extentSet.add(extent);
      }
      for (const buffer of [layer.firstBuffer, layer.secondBuffer]) {
        if (buffer === null) continue;
        summary.buffer = summary.buffer
          ? [Math.min(summary.buffer[0], buffer), Math.max(summary.buffer[1], buffer)]
          : [buffer, buffer];
      }
    }
    const defects = DEFECTS.filter(([key]) => seam.counts[key] > 0);
    for (const [key, code, check, message] of defects) {
      find(check, code, "error", message, seam.counts[key], [first, second]);
    }
    if (defects.length) {
      defectivePairs += 1;
      if (reported.length < limits.reportedPairs) {
        reported.push({
          ...described,
          status: "defective",
          counts: seam.counts,
          findings: seam.findings,
          findingsTruncated: seam.findingsTruncated,
          reason: defects.map(([key, code]) => `${code} ${seam.counts[key]}`).join("; "),
        });
      }
    }
  }
  find(
    "line-seams",
    "line-slack-used",
    "info",
    "line pairs that needed the provider slack beyond quantization",
    totals.lineSlackUsed,
  );
  find(
    "polygon-seams",
    "polygon-slack-used",
    "info",
    "one-sided polygon edge parts within the tolerance",
    totals.polygonSlackUsed,
  );
  seams = {
    counts: totals,
    layers: [...layers.values()]
      .sort((a, b) => compareText(a.name, b.name))
      .map(({ extentSet, ...layer }) => ({
        ...layer,
        extents: [...extentSet].sort((a, b) => a - b),
      })),
    defectivePairs,
    reported,
  };

  const evaluated = pairs.checked - failedPairs;
  const incomplete = mode === "full" && !complete;
  settle(
    "pairs",
    `${pairs.checked} of ${all.length} adjacent pairs checked (${withoutNeighbour} edges without a neighbour)`,
    all.length === 0 || incomplete,
  );
  const lineEvents =
    totals.lineCrossings + totals.lineInterrupted + totals.lineDuplicated + totals.lineOffset;
  settle(
    "line-seams",
    evaluated === 0
      ? "no pair evaluated"
      : lineEvents === 0
        ? `no line reaches a shared edge in ${evaluated} pairs`
        : `${totals.lineCrossings} continuous, ${totals.lineInterrupted} interrupted, ${totals.lineDuplicated} duplicated, ${totals.lineOffset} displaced`,
    evaluated === 0 || lineEvents === 0 || incomplete,
  );
  settle(
    "polygon-seams",
    evaluated === 0
      ? "no pair evaluated"
      : totals.polygonGroups === 0
        ? `no polygon reaches a shared edge in ${evaluated} pairs`
        : `${totals.polygonGroups} polygon groups at shared edges, ${totals.polygonMismatches} one-sided parts beyond tolerance`,
    evaluated === 0 || totals.polygonGroups === 0 || incomplete,
  );
  return artifact();
}
