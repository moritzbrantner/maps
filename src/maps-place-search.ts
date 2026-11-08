import type { MapsTilesetMetadata } from "./maps-tileset";

/**
 * Precomputed, source-pinned place search (#281).
 *
 * Maps owns the reader, normalization and ranking semantics. Producing an index from
 * canonical source features belongs to asset-tooling; Maps never derives one from tiles
 * and never invents names, aliases or translations.
 */
export const MAPS_PLACE_SEARCH_SCHEMA = "maps-place-search-v1";
/** Hard ceiling for a single lazily loaded index artifact. */
export const MAPS_PLACE_SEARCH_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PLACES = 200_000;
const MAX_ALIASES = 32;
const MAX_QUERY_LENGTH = 128;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const MERCATOR_LATITUDE = 85.0511287798066;

/** West, south, east, north. West > east denotes an antimeridian-crossing extent. */
export type MapsPlaceBounds = readonly [number, number, number, number];

/** Optional manifest reference; the only search-related Maps Tileset extension. */
export type MapsPlaceSearchIndexRef = {
  schema: typeof MAPS_PLACE_SEARCH_SCHEMA;
  /** Static HTTP(S) or root-relative JSON artifact; no credentials or query strings. */
  url: string;
  /** Lowercase hex SHA-256 of the exact artifact bytes. */
  sha256: string;
  bytes: number;
  languages: readonly string[];
  bounds: MapsPlaceBounds;
  license: string;
  provenance: string;
};

export type MapsPlaceName = { name: string; language: string };

export type MapsPlaceSearchPlace = {
  /** Stable source feature key when the producer has one. */
  id: string | null;
  name: string;
  language: string;
  type: string;
  /** Producer-supplied disambiguation, e.g. a containing region. */
  context?: string;
  aliases: readonly MapsPlaceName[];
  center: readonly [number, number];
  bounds: MapsPlaceBounds;
};

/** The independent search artifact that a tileset manifest pins by hash. */
export type MapsPlaceSearchArtifact = {
  schema: typeof MAPS_PLACE_SEARCH_SCHEMA;
  sourceId: string;
  dataRevision: string;
  languages: readonly string[];
  attribution: string;
  license: string;
  provenance: string;
  places: readonly MapsPlaceSearchPlace[];
};

export type MapsPlaceSearchMatch = "exact" | "alias" | "prefix" | "alias-prefix" | "word" | "alias-word";

export type MapsPlaceSearchResult = {
  /** Unique within one index revision: the source id or a positional fallback key. */
  key: string;
  sourceFeatureId: string | null;
  sourceId: string;
  dataRevision: string;
  name: string;
  type: string;
  context: string | null;
  /** The name that matched and its effective language. */
  matchedName: string;
  language: string;
  match: MapsPlaceSearchMatch;
  center: readonly [number, number];
  bounds: MapsPlaceBounds;
  attribution: string;
};

export type MapsPlaceSearchIndex = {
  sourceId: string;
  dataRevision: string;
  sha256: string | null;
  placeCount: number;
  artifact: MapsPlaceSearchArtifact;
  search(query: string, options?: { limit?: number }): MapsPlaceSearchResult[];
};

export type MapsPlaceSearchUnavailableReason =
  | "no-index"
  | "unsupported"
  | "hash-mismatch"
  | "revision-mismatch"
  | "offline"
  | "invalid";

export class MapsPlaceSearchUnavailableError extends Error {
  readonly reason: MapsPlaceSearchUnavailableReason;
  constructor(reason: MapsPlaceSearchUnavailableReason, message: string) {
    super(`Maps place search: ${message}`);
    this.name = "MapsPlaceSearchUnavailableError";
    this.reason = reason;
  }
}

const invalid = (message: string): never => {
  throw new MapsPlaceSearchUnavailableError("invalid", message);
};
const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`expected ${what} object`);
  }
  return value as Record<string, unknown>;
};
const text = (value: unknown, what: string, max = 4096): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    return invalid(`${what} is missing or too long`);
  }
  return value;
};
const language = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$|^und$/.test(value)) {
    return invalid("language must be a BCP 47 tag");
  }
  return value;
};
const languages = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > 64) {
    return invalid("languages must be a non-empty list");
  }
  return value.map(language);
};
const longitude = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
const latitude = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= -MERCATOR_LATITUDE &&
  value <= MERCATOR_LATITUDE;

function bounds(value: unknown, what: string): MapsPlaceBounds {
  if (!Array.isArray(value) || value.length !== 4) return invalid(`${what} bounds are invalid`);
  const [west, south, east, north] = value as unknown[];
  if (!longitude(west) || !longitude(east) || !latitude(south) || !latitude(north)) {
    return invalid(`${what} bounds are invalid`);
  }
  if ((south as number) > (north as number)) return invalid(`${what} bounds are invalid`);
  return [west as number, south as number, east as number, north as number];
}

/** True when the point lies in the extent, honoring antimeridian-crossing extents. */
export function placeBoundsContain(extent: MapsPlaceBounds, point: readonly [number, number]) {
  const [west, south, east, north] = extent;
  const [x, y] = point;
  if (y < south || y > north) return false;
  return west <= east ? x >= west && x <= east : x >= west || x <= east;
}

/** Validate the optional manifest reference without fetching anything. */
export function validateMapsPlaceSearchIndexRef(input: unknown): MapsPlaceSearchIndexRef {
  const value = record(input, "search index reference");
  if (value.schema !== MAPS_PLACE_SEARCH_SCHEMA) {
    throw new MapsPlaceSearchUnavailableError("unsupported", "unsupported search index schema");
  }
  const url = text(value.url, "search index url", 8192);
  if (!/^(https:\/\/|http:\/\/|\/)/.test(url) || /[?#]/.test(url) || /^[a-z]+:\/\/[^/]*[@]/i.test(url)) {
    invalid("search index url must be a static HTTP(S) or root-relative path without credentials");
  }
  const sha256 = value.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    invalid("search index sha256 must be 64 lowercase hex characters");
  }
  const bytes = value.bytes;
  if (
    typeof bytes !== "number" ||
    !Number.isInteger(bytes) ||
    bytes <= 0 ||
    bytes > MAPS_PLACE_SEARCH_MAX_BYTES
  ) {
    invalid(`search index bytes must be 1–${MAPS_PLACE_SEARCH_MAX_BYTES}`);
  }
  return {
    schema: MAPS_PLACE_SEARCH_SCHEMA,
    url,
    sha256: sha256 as string,
    bytes: bytes as number,
    languages: languages(value.languages),
    bounds: bounds(value.bounds, "search index"),
    license: text(value.license, "search index license"),
    provenance: text(value.provenance, "search index provenance"),
  };
}

function place(input: unknown): MapsPlaceSearchPlace {
  const value = record(input, "place");
  const id = value.id;
  if (id !== undefined && id !== null && (typeof id !== "string" || !id || id.length > 256)) {
    invalid("place id must be a non-empty string or null");
  }
  const aliasesInput = value.aliases ?? [];
  if (!Array.isArray(aliasesInput) || aliasesInput.length > MAX_ALIASES) {
    invalid("place aliases must be a bounded list");
  }
  const center = value.center;
  if (
    !Array.isArray(center) ||
    center.length !== 2 ||
    !longitude(center[0]) ||
    !latitude(center[1])
  ) {
    return invalid("place center is invalid");
  }
  const extent = bounds(value.bounds, "place");
  const point: [number, number] = [center[0] as number, center[1] as number];
  if (!placeBoundsContain(extent, point)) invalid("place center lies outside its bounds");
  return {
    id: typeof id === "string" ? id : null,
    name: text(value.name, "place name", 512),
    language: language(value.language),
    type: text(value.type, "place type", 64),
    ...(value.context === undefined ? {} : { context: text(value.context, "place context", 512) }),
    aliases: (aliasesInput as unknown[]).map((alias) => {
      const entry = record(alias, "alias");
      return { name: text(entry.name, "alias name", 512), language: language(entry.language) };
    }),
    center: point,
    bounds: extent,
  };
}

/** Validate/copy an index artifact. Throws MapsPlaceSearchUnavailableError. */
export function validateMapsPlaceSearchArtifact(input: unknown): MapsPlaceSearchArtifact {
  const value = record(input, "search index");
  if (value.schema !== MAPS_PLACE_SEARCH_SCHEMA) {
    throw new MapsPlaceSearchUnavailableError("unsupported", "unsupported search index schema");
  }
  const places = value.places;
  if (!Array.isArray(places) || places.length > MAX_PLACES) {
    return invalid("places must be a bounded list");
  }
  const validated = places.map(place);
  const ids = new Set<string>();
  for (const entry of validated) {
    if (entry.id === null) continue;
    if (ids.has(entry.id)) invalid(`duplicate place id ${JSON.stringify(entry.id)}`);
    ids.add(entry.id);
  }
  return {
    schema: MAPS_PLACE_SEARCH_SCHEMA,
    sourceId: text(value.sourceId, "sourceId"),
    dataRevision: text(value.dataRevision, "dataRevision"),
    languages: languages(value.languages),
    attribution: text(value.attribution, "attribution"),
    license: text(value.license, "license"),
    provenance: text(value.provenance, "provenance"),
    places: validated,
  };
}

const FOLDS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/**
 * Deterministic, locale-independent search normalization: compatibility decomposition,
 * diacritic removal, case folding and punctuation/whitespace collapsing. It does not
 * transliterate between scripts; cross-script names must be supplied as aliases.
 */
export function normalizePlaceSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (character) => FOLDS[character] ?? character)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type Entry = { key: string; place: number; name: number; word: boolean };

const RANK: Record<MapsPlaceSearchMatch, number> = {
  exact: 0,
  alias: 1,
  prefix: 2,
  "alias-prefix": 3,
  word: 4,
  "alias-word": 5,
};

function matchKind(entry: Entry, exact: boolean): MapsPlaceSearchMatch {
  const alias = entry.name > 0;
  if (entry.word) return alias ? "alias-word" : "word";
  if (exact) return alias ? "alias" : "exact";
  return alias ? "alias-prefix" : "prefix";
}

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Build the in-memory lookup once per artifact. Every normalized name and word start is
 * sorted so a query is a bounded binary-search prefix scan, never a tile scan.
 */
export function createMapsPlaceSearchIndex(
  artifactInput: MapsPlaceSearchArtifact | unknown,
  options: { sha256?: string } = {},
): MapsPlaceSearchIndex {
  const artifact = validateMapsPlaceSearchArtifact(artifactInput);
  const entries: Entry[] = [];
  const names = artifact.places.map((entry) => [
    { name: entry.name, language: entry.language },
    ...entry.aliases,
  ]);
  const normalizedNames = names.map((list) => list.map((entry) => normalizePlaceSearchText(entry.name)));
  normalizedNames.forEach((list, placeIndex) => {
    const seen = new Set<string>();
    list.forEach((key, nameIndex) => {
      if (!key) return;
      const push = (value: string, word: boolean) => {
        const id = `${word ? "w" : "n"}:${value}`;
        if (seen.has(id)) return;
        seen.add(id);
        entries.push({ key: value, place: placeIndex, name: nameIndex, word });
      };
      push(key, false);
      for (let index = key.indexOf(" "); index >= 0; index = key.indexOf(" ", index + 1)) {
        push(key.slice(index + 1), true);
      }
    });
  });
  entries.sort((left, right) => compare(left.key, right.key) || left.place - right.place || left.name - right.name);
  const keys = artifact.places.map((entry, index) => entry.id ?? `#${index}`);

  const search = (query: string, searchOptions: { limit?: number } = {}) => {
    const normalized = normalizePlaceSearchText(query.slice(0, MAX_QUERY_LENGTH));
    if (!normalized) return [];
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(searchOptions.limit ?? DEFAULT_LIMIT)));
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (entries[middle]!.key < normalized) low = middle + 1;
      else high = middle;
    }
    const best = new Map<number, { entry: Entry; match: MapsPlaceSearchMatch }>();
    for (let index = low; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!entry.key.startsWith(normalized)) break;
      const match = matchKind(entry, entry.key === normalized);
      const current = best.get(entry.place);
      if (!current || RANK[match] < RANK[current.match]) best.set(entry.place, { entry, match });
    }
    return [...best.values()]
      .sort(
        (left, right) =>
          RANK[left.match] - RANK[right.match] ||
          compare(normalizedNames[left.entry.place]![0]!, normalizedNames[right.entry.place]![0]!) ||
          compare(keys[left.entry.place]!, keys[right.entry.place]!),
      )
      .slice(0, limit)
      .map(({ entry, match }): MapsPlaceSearchResult => {
        const source = artifact.places[entry.place]!;
        const matched = names[entry.place]![entry.name]!;
        return {
          key: keys[entry.place]!,
          sourceFeatureId: source.id,
          sourceId: artifact.sourceId,
          dataRevision: artifact.dataRevision,
          name: source.name,
          type: source.type,
          context: source.context ?? null,
          matchedName: matched.name,
          language: matched.language,
          match,
          center: source.center,
          bounds: source.bounds,
          attribution: artifact.attribution,
        };
      });
  };

  return {
    sourceId: artifact.sourceId,
    dataRevision: artifact.dataRevision,
    sha256: options.sha256 ?? null,
    placeCount: artifact.places.length,
    artifact,
    search,
  };
}

export type MapsPlaceSearchLoadOptions = {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /**
   * Content-addressed browser storage. `undefined` uses the Cache API when permitted;
   * `null` disables persistence. Inaccessible storage never blocks an online load.
   */
  cache?: Pick<Cache, "match" | "put"> | null;
};

const CACHE_NAME = "maps-place-search-v1";

async function openCache(
  option: MapsPlaceSearchLoadOptions["cache"],
): Promise<Pick<Cache, "match" | "put"> | null> {
  if (option !== undefined) return option;
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const cacheKey = (ref: MapsPlaceSearchIndexRef) =>
  `https://maps-place-search.invalid/sha256/${ref.sha256}`;

/**
 * Lazily load the exact index revision pinned by a tileset manifest. A missing reference,
 * hash mismatch, source/revision mismatch or unavailable offline copy rejects with
 * MapsPlaceSearchUnavailableError instead of returning stale coordinates.
 */
export async function loadMapsPlaceSearchIndex(
  tileset: Pick<MapsTilesetMetadata, "sourceId" | "dataRevision" | "searchIndex">,
  options: MapsPlaceSearchLoadOptions = {},
): Promise<MapsPlaceSearchIndex> {
  if (!tileset.searchIndex) {
    throw new MapsPlaceSearchUnavailableError("no-index", "this tileset has no search index");
  }
  const ref = validateMapsPlaceSearchIndexRef(tileset.searchIndex);
  const { signal } = options;
  signal?.throwIfAborted();
  const cache = await openCache(options.cache);
  let bytes: ArrayBuffer | null = null;
  let fromCache = false;
  try {
    const cached = await cache?.match(cacheKey(ref));
    if (cached) {
      bytes = await cached.arrayBuffer();
      fromCache = true;
    }
  } catch {
    bytes = null;
  }
  signal?.throwIfAborted();
  if (bytes && (bytes.byteLength !== ref.bytes || (await sha256Hex(bytes)) !== ref.sha256)) {
    bytes = null;
    fromCache = false;
  }
  if (!bytes) {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(ref.url, { signal, credentials: "omit" });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new MapsPlaceSearchUnavailableError(
        "offline",
        "the pinned search index is not reachable and no exact cached revision exists",
      );
    }
    if (!response.ok) {
      throw new MapsPlaceSearchUnavailableError(
        "offline",
        `search index request failed with HTTP ${response.status}`,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAPS_PLACE_SEARCH_MAX_BYTES) {
      throw new MapsPlaceSearchUnavailableError("hash-mismatch", "search index exceeds byte bound");
    }
    bytes = await response.arrayBuffer();
  }
  signal?.throwIfAborted();
  if (!fromCache) {
    if (bytes.byteLength !== ref.bytes || (await sha256Hex(bytes)) !== ref.sha256) {
      throw new MapsPlaceSearchUnavailableError(
        "hash-mismatch",
        "search index bytes do not match the pinned sha256",
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("search index is not UTF-8 JSON");
  }
  const index = createMapsPlaceSearchIndex(parsed, { sha256: ref.sha256 });
  if (index.sourceId !== tileset.sourceId || index.dataRevision !== tileset.dataRevision) {
    throw new MapsPlaceSearchUnavailableError(
      "revision-mismatch",
      `index is for ${index.sourceId}@${index.dataRevision}, not ${tileset.sourceId}@${tileset.dataRevision}`,
    );
  }
  signal?.throwIfAborted();
  if (!fromCache && cache) {
    try {
      await cache.put(
        cacheKey(ref),
        new Response(bytes, { headers: { "content-type": "application/json" } }),
      );
    } catch {
      // Storage may be full or denied; the verified in-memory index remains usable.
    }
  }
  return index;
}
