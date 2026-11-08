import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  createFixturePlaceSearchIndexRef,
  withFixturePlaceSearch,
} from "../demo/place-search-fixtures";
import { createShowcaseTileset } from "../demo/showcase-tileset";
import {
  createMapsPlaceSearchIndex,
  loadMapsPlaceSearchIndex,
  MapsPlaceSearchUnavailableError,
  normalizePlaceSearchText,
  validateMapsPlaceSearchArtifact,
  type MapsPlaceSearchArtifact,
} from "./maps-place-search";
import { validateMapsTileset } from "./maps-tileset";
import { createFixturePmtilesXyzTileset } from "./tileset-fixtures";

const read = (name: string) => readFileSync(`public/search-indexes/${name}`);
const showcaseBytes = read("maps-showcase-places-r1.json");
const xyzBytes = read("fixture-pmtiles-xyz-places-r1.json");
const showcase = JSON.parse(showcaseBytes.toString("utf8")) as MapsPlaceSearchArtifact;
const showcaseTileset = withFixturePlaceSearch(createShowcaseTileset("/"), "/");

const responseFor = (bytes: Uint8Array) => () =>
  Promise.resolve(new Response(new Uint8Array(bytes), { status: 200 }));
const memoryCache = () => {
  const store = new Map<string, Response>();
  return {
    store,
    match: vi.fn(async (key: RequestInfo | URL) => store.get(String(key))?.clone()),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      store.set(String(key), response.clone());
    }),
  };
};
const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MapsPlaceSearchUnavailableError) return error.reason;
    throw error;
  }
  return "loaded";
};

describe("place search normalization", () => {
  it.each([
    ["Zürichberg", "zurichberg"],
    ["ZÜRICHBERG", "zurichberg"],
    ["Zürichberg", "zurichberg"],
    ["Saint Ælfric", "saint aelfric"],
    ["Straße", "strasse"],
    ["St. Aelfric  Bay", "st aelfric bay"],
    ["ＨＡＲＢＯＲ", "harbor"],
    ["Северная Гавань", "северная гавань"],
    ["  ", ""],
  ])("normalizes %j deterministically", (input, expected) => {
    expect(normalizePlaceSearchText(input)).toBe(expected);
  });

  it("does not transliterate across scripts", () => {
    expect(normalizePlaceSearchText("Северная")).not.toBe(normalizePlaceSearchText("Severnaya"));
  });
});

describe("source-pinned place search index", () => {
  const index = createMapsPlaceSearchIndex(showcase);
  const keys = (query: string, limit?: number) =>
    index.search(query, limit ? { limit } : {}).map((result) => result.key);

  it("keeps identical names at different places distinct", () => {
    const results = index.search("harbor point");
    expect(results.map((result) => [result.key, result.context, result.center])).toEqual([
      ["showcase/harbor-point-north", "Northern shore", [20, 45]],
      ["showcase/harbor-point-south", "Southern shore", [-60, -30]],
    ]);
    expect(results.every((result) => result.match === "exact")).toBe(true);
  });

  it("matches aliases, diacritic-insensitive prefixes and word starts", () => {
    expect(index.search("Zuerichberg Reach")[0]).toMatchObject({
      key: "showcase/zurichberg-reach",
      name: "Zürichberg Reach",
      matchedName: "Zuerichberg Reach",
      language: "de",
      match: "alias",
    });
    expect(index.search("zurich")[0]).toMatchObject({ match: "prefix", language: "de" });
    expect(index.search("reach").map((result) => [result.key, result.match])).toEqual([
      ["showcase/zurichberg-reach", "word"],
    ]);
    expect(index.search("st aelfric")[0]).toMatchObject({
      key: "showcase/saint-aelfric-bay",
      match: "alias-prefix",
    });
  });

  it("finds cross-script names only through producer-supplied aliases", () => {
    expect(index.search("северная")[0]).toMatchObject({ language: "ru", match: "prefix" });
    expect(index.search("severnaya")[0]).toMatchObject({
      key: "showcase/severnaya-gavan",
      language: "ru-Latn",
      match: "alias-prefix",
    });
    expect(index.search("moskva")).toEqual([]);
  });

  it("ranks exact matches before prefixes and bounds results", () => {
    expect(keys("h")).toEqual(["showcase/harbor-point-north", "showcase/harbor-point-south"]);
    expect(keys("a", 50).length).toBeLessThanOrEqual(showcase.places.length);
    expect(keys("harbor", 1)).toEqual(["showcase/harbor-point-north"]);
    expect(keys("")).toEqual([]);
    expect(keys("...")).toEqual([]);
  });

  it("reports missing source ids without inventing one", () => {
    expect(index.search("quiet")[0]).toMatchObject({ key: "#4", sourceFeatureId: null });
  });

  it("preserves antimeridian extents and source attribution", () => {
    expect(index.search("dateline")[0]).toMatchObject({
      bounds: [175, -20, -175, -10],
      sourceId: "maps-showcase",
      dataRevision: "1",
      attribution: "Maps synthetic CC0 place fixture",
    });
  });

  it("rejects malformed artifacts before search", () => {
    const place = showcase.places[0]!;
    for (const input of [
      { ...showcase, schema: "other" },
      { ...showcase, places: [place, place] },
      { ...showcase, places: [{ ...place, center: [200, 0] }] },
      { ...showcase, places: [{ ...place, center: [0, 0] }] },
      { ...showcase, places: [{ ...place, language: "English" }] },
      { ...showcase, sourceId: "" },
    ]) {
      expect(() => validateMapsPlaceSearchArtifact(input)).toThrow(MapsPlaceSearchUnavailableError);
    }
  });
});

describe("pinned index loading", () => {
  it("pins both committed fixtures by exact bytes", () => {
    for (const [source, bytes] of [
      ["maps-showcase", showcaseBytes],
      ["fixture-pmtiles-xyz", xyzBytes],
    ] as const) {
      const ref = createFixturePlaceSearchIndexRef(source, "/");
      expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(ref.bytes).toBe(bytes.byteLength);
    }
  });

  it("extends the Maps Tileset manifest only with a validated optional reference", () => {
    expect(validateMapsTileset(showcaseTileset).searchIndex?.sha256).toBe(
      showcaseTileset.searchIndex?.sha256,
    );
    expect(validateMapsTileset(createShowcaseTileset("/")).searchIndex).toBeUndefined();
    for (const url of [
      "javascript:alert(1)",
      "/index.json?token=secret",
      "https://user:pass@cdn.test/index.json",
    ]) {
      expect(() =>
        validateMapsTileset({
          ...showcaseTileset,
          searchIndex: { ...showcaseTileset.searchIndex, url },
        }),
      ).toThrow(/Maps Tileset/);
    }
  });

  it("loads, verifies and caches the exact revision, then works offline from the cache", async () => {
    const cache = memoryCache();
    const fetch = vi.fn(responseFor(showcaseBytes));
    const index = await loadMapsPlaceSearchIndex(showcaseTileset, { fetch, cache });
    expect(index.placeCount).toBe(7);
    expect(fetch).toHaveBeenCalledWith("/search-indexes/maps-showcase-places-r1.json", expect.anything());
    expect(cache.put).toHaveBeenCalledTimes(1);

    const offline = vi.fn(() => Promise.reject(new TypeError("offline")));
    const cached = await loadMapsPlaceSearchIndex(showcaseTileset, { fetch: offline, cache });
    expect(cached.search("harbor point")).toHaveLength(2);
    expect(offline).not.toHaveBeenCalled();
  });

  it("is unavailable offline without the exact cached revision", async () => {
    const offline = () => Promise.reject(new TypeError("offline"));
    expect(
      await reasonOf(
        loadMapsPlaceSearchIndex(showcaseTileset, { fetch: offline, cache: memoryCache() }),
      ),
    ).toBe("offline");
  });

  it("rejects hash mismatches and other source revisions instead of returning stale places", async () => {
    expect(
      await reasonOf(
        loadMapsPlaceSearchIndex(showcaseTileset, { fetch: responseFor(xyzBytes), cache: null }),
      ),
    ).toBe("hash-mismatch");
    const xyz = withFixturePlaceSearch(createFixturePmtilesXyzTileset("/"), "/");
    expect(
      await reasonOf(
        loadMapsPlaceSearchIndex(
          { ...xyz, dataRevision: "2" },
          { fetch: responseFor(xyzBytes), cache: null },
        ),
      ),
    ).toBe("revision-mismatch");
    expect(
      await reasonOf(
        loadMapsPlaceSearchIndex(createShowcaseTileset("/"), { fetch: responseFor(xyzBytes) }),
      ),
    ).toBe("no-index");
  });

  it("ignores a corrupted cache entry and still loads online when storage is inaccessible", async () => {
    const cache = memoryCache();
    cache.store.set(
      `https://maps-place-search.invalid/sha256/${showcaseTileset.searchIndex!.sha256}`,
      new Response(new Uint8Array(xyzBytes)),
    );
    const index = await loadMapsPlaceSearchIndex(showcaseTileset, {
      fetch: responseFor(showcaseBytes),
      cache,
    });
    expect(index.placeCount).toBe(7);
    const denied = {
      match: () => Promise.reject(new DOMException("denied", "SecurityError")),
      put: () => Promise.reject(new DOMException("denied", "SecurityError")),
    };
    const online = await loadMapsPlaceSearchIndex(showcaseTileset, {
      fetch: responseFor(showcaseBytes),
      cache: denied,
    });
    expect(online.placeCount).toBe(7);
  });

  it("propagates cancellation of superseded loads", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadMapsPlaceSearchIndex(showcaseTileset, {
        fetch: responseFor(showcaseBytes),
        cache: null,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
