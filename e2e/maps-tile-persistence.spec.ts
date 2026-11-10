import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// Opt-in raw-tile persistence (#264) through the real first-party Map View. Each test owns a
// fresh browser context, so Cache Storage starts empty and survives only that test's reloads.

const FIXTURE = "/e2e/fixtures/tileset-sources.html";
const pinnedTile = readFileSync("public/tilesets/fixture-pmtiles-v1.mvt");
const surfaceOf = (page: Page) => page.locator('canvas[data-flat-runtime="maps"]');
const status = (page: Page) => page.evaluate(() => window.tilePersistence.status());

async function ready(page: Page) {
  await expect(surfaceOf(page)).toHaveAttribute("data-map-source-state", "ready");
}

async function tileKey(page: Page, tile = "0/0/0") {
  const identity = await surfaceOf(page).getAttribute("data-map-source-identity");
  return `https://maps-tiles.invalid/v1/tile/${encodeURIComponent(identity!)}/${tile}`;
}

/** Tile entries actually present in Cache Storage, without creating the cache. */
const storedTiles = (page: Page) =>
  page.evaluate(async () => {
    if (!(await caches.has("maps-tiles-v1"))) return [];
    const cache = await caches.open("maps-tiles-v1");
    return (await cache.keys())
      .map((request) => request.url)
      .filter((url) => url.includes("/tile/"))
      .sort();
  });

/** The debounced index is what a later session trusts; reload only once it names the tiles. */
async function indexed(page: Page, keys: string[]) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        if (!(await caches.has("maps-tiles-v1"))) return [];
        const cache = await caches.open("maps-tiles-v1");
        const index = await cache.match("https://maps-tiles.invalid/v1/index");
        const stored = index ? ((await index.json()) as { entries: Array<[string, unknown]> }) : null;
        return (stored?.entries ?? []).map(([key]) => key).sort();
      }),
    )
    .toEqual([...keys].sort());
}

const storedBytes = (page: Page, key: string) =>
  page.evaluate(async (url) => {
    const cache = await caches.open("maps-tiles-v1");
    const response = await cache.match(url);
    return response ? Array.from(new Uint8Array(await response.arrayBuffer())) : null;
  }, key);

function recordTileRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/tilesets/")) requests.push(request.url());
  });
  return requests;
}

/** Serves the XYZ fixtures with explicit cache directives instead of the dev server's. */
async function serveXyzWith(page: Page, cacheControl: string) {
  await page.route("**/tilesets/fixture-*.mvt**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "cache-control": cacheControl } });
  });
}

test("a Map View without tilePersistence writes nothing to origin storage @smoke", async ({ page }) => {
  await page.goto(FIXTURE);
  await ready(page);
  await expect(surfaceOf(page)).not.toHaveAttribute("data-map-tile-persistence", /.*/);
  expect(await page.evaluate(() => caches.has("maps-tiles-v1"))).toBe(false);
});

for (const canvas of [false, true]) {
  test(`cold visit fetches a tile once; reload and a style change reuse its stored bytes (${canvas ? "Canvas" : "WebGPU"}) @smoke`, async ({
    page,
  }) => {
    const requests = recordTileRequests(page);
    await page.goto(`${FIXTURE}?persist&start=pinned${canvas ? "&canvas" : ""}`);
    await ready(page);
    const surface = surfaceOf(page);
    const view = page.locator('[data-map-runtime="maps"]');
    await expect(surface).toHaveAttribute("data-map-tile-persistence", "active");
    await expect.poll(async () => (await status(page)).writes).toBe(1);
    expect(await status(page)).toMatchObject({
      hits: 0,
      misses: 1,
      storedTiles: 1,
      storedBytes: pinnedTile.length,
    });
    const key = await tileKey(page);
    expect(await storedBytes(page, key)).toEqual([...pinnedTile]);
    expect(requests.length).toBeGreaterThan(0);
    await indexed(page, [key]);
    const cold = await view.screenshot();

    requests.length = 0;
    await page.reload();
    await ready(page);
    // Not even the archive header is read: the stored tile answers alone.
    expect(requests).toEqual([]);
    await expect(surface).toHaveAttribute("data-map-tile-persistence-hits", "1");
    expect(await status(page)).toMatchObject({ hits: 1, misses: 0, writes: 0, storedTiles: 1 });
    await expect.poll(async () => (await view.screenshot()).equals(cold)).toBe(true);

    await page.getByRole("button", { name: "Red forest" }).click();
    await expect.poll(async () => (await view.screenshot()).equals(cold)).toBe(false);
    expect(requests).toEqual([]);
    expect(await storedTiles(page)).toEqual([key]);
    expect(await status(page)).toMatchObject({ hits: 1, misses: 0, writes: 0 });
  });
}

test("with the tile host unreachable a stored tile renders and an uncached tile fails visibly @smoke", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?persist&start=pinned`);
  await ready(page);
  await indexed(page, [await tileKey(page)]);
  const view = page.locator('[data-map-runtime="maps"]');
  const online = await view.screenshot();

  await page.route("**/tilesets/**", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await ready(page);
  await expect.poll(async () => (await view.screenshot()).equals(online)).toBe(true);
  expect(await status(page)).toMatchObject({ hits: 1, misses: 0 });

  await page.evaluate(() => window.tilesetController!.setViewState({ center: [0, 0], zoom: 1 }));
  const surface = surfaceOf(page);
  await expect(surface).toHaveAttribute("data-map-source-state", "error");
  await expect(surface).toHaveAttribute("data-map-base-tile-error", /PMTiles/);
  expect(await status(page)).toMatchObject({ storedTiles: 1 });
});

test("clearing downloaded tiles empties storage and the next visit downloads again @smoke", async ({
  page,
}) => {
  const requests = recordTileRequests(page);
  await page.goto(`${FIXTURE}?persist&start=pinned`);
  await ready(page);
  await indexed(page, [await tileKey(page)]);
  await page.evaluate(() => window.tilePersistence.clear());
  expect(await storedTiles(page)).toEqual([]);
  expect(await status(page)).toMatchObject({ state: "active", storedBytes: 0, storedTiles: 0 });

  requests.length = 0;
  await page.reload();
  await ready(page);
  expect(requests.length).toBeGreaterThan(0);
  await expect.poll(async () => (await status(page)).writes).toBe(1);
  expect(await status(page)).toMatchObject({ hits: 0, misses: 1 });
});

test("stored tiles are keyed by source and revision, never by transport URL @smoke", async ({
  page,
}) => {
  await serveXyzWith(page, "max-age=3600");
  const requests = recordTileRequests(page);
  await page.goto(`${FIXTURE}?persist`);
  await ready(page);
  const surface = surfaceOf(page);
  const a = await tileKey(page);
  await page.getByRole("button", { name: "Source B", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-b");
  await ready(page);
  const b = await tileKey(page);
  await page.getByRole("button", { name: "Revision 2", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-revision", "2");
  await ready(page);
  const revision2 = await tileKey(page);
  expect(new Set([a, b, revision2]).size).toBe(3);
  await expect.poll(() => storedTiles(page)).toEqual([a, b, revision2].sort());

  // A refreshed credential changes the transport URL, not the data it names.
  await page.getByRole("button", { name: "Refresh tile URL" }).click();
  await expect(page.getByLabel("Tile transport")).toContainText("credential=refreshed");
  await ready(page);
  expect(await tileKey(page)).toBe(revision2);
  const stored = await storedTiles(page);
  expect(stored).toEqual([a, b, revision2].sort());
  expect(stored.some((url) => /credential|tilesets|\.mvt/.test(url))).toBe(false);

  await indexed(page, [a, b, revision2]);
  requests.length = 0;
  await page.reload();
  await ready(page);
  expect(requests).toEqual([]); // Source A is fresh for an hour.
  expect(await status(page)).toMatchObject({ hits: 1, misses: 0 });
});

test("an unpinned tile is revalidated with its ETag before a stored copy is reused @smoke", async ({
  page,
}) => {
  // The dev server answers `Cache-Control: no-cache` with a weak ETag.
  await page.goto(`${FIXTURE}?persist`);
  await ready(page);
  await indexed(page, [await tileKey(page)]);
  const conditional: Array<{ validator: string | undefined; status: number }> = [];
  page.on("response", (response) => {
    if (!response.url().includes("fixture-a.mvt")) return;
    conditional.push({
      validator: response.request().headers()["if-none-match"],
      status: response.status(),
    });
  });
  await page.reload();
  await ready(page);
  expect(conditional).toHaveLength(1);
  expect(conditional[0]!.validator).toMatch(/^W\//);
  expect(conditional[0]!.status).toBe(304);
  expect(await status(page)).toMatchObject({ revalidations: 1, hits: 0, misses: 0, writes: 0 });
});

test("no-store responses are never stored and an expired tile is not served offline @smoke", async ({
  page,
}) => {
  await serveXyzWith(page, "no-store");
  await page.goto(`${FIXTURE}?persist`);
  await ready(page);
  await expect.poll(async () => (await status(page)).misses).toBe(1);
  await page.getByRole("button", { name: "Source B", exact: true }).click();
  await expect(surfaceOf(page)).toHaveAttribute("data-map-source-id", "fixture-b");
  await ready(page);
  expect(await status(page)).toMatchObject({ misses: 2, writes: 0, storedTiles: 0 });
  expect(await storedTiles(page)).toEqual([]);

  await page.unroute("**/tilesets/fixture-*.mvt**");
  await serveXyzWith(page, "max-age=1");
  await page.reload();
  await ready(page);
  const key = await tileKey(page);
  await indexed(page, [key]);
  await page.waitForTimeout(1_200); // Outlive max-age=1.
  await page.unroute("**/tilesets/fixture-*.mvt**");
  await page.route("**/tilesets/**", (route) => route.abort("internetdisconnected"));
  await page.reload();
  const surface = surfaceOf(page);
  await expect(surface).toHaveAttribute("data-map-source-state", "error");
  expect(await status(page)).toMatchObject({ hits: 0, revalidations: 0 });
});

test("malformed network bytes are not stored; corrupt stored bytes fall back to the network @smoke", async ({
  page,
}) => {
  await page.route("**/tilesets/fixture-a.mvt**", (route) =>
    route.fulfill({
      status: 200,
      body: Buffer.from("not a vector tile"),
      headers: { "Cache-Control": "max-age=3600" },
    }),
  );
  await page.goto(`${FIXTURE}?persist`);
  const surface = surfaceOf(page);
  await expect(surface).toHaveAttribute("data-map-source-state", "error");
  await expect.poll(async () => (await status(page)).misses).toBeGreaterThan(0);
  expect(await storedTiles(page)).toEqual([]);
  await page.unroute("**/tilesets/fixture-a.mvt**");

  await page.goto(`${FIXTURE}?persist&start=pinned`);
  await ready(page);
  const key = await tileKey(page);
  await indexed(page, [key]);
  const view = page.locator('[data-map-runtime="maps"]');
  const intact = await view.screenshot();
  // Same length as the real tile, so only the decoder can tell it is not one.
  await page.evaluate(
    async ([url, length]) => {
      const cache = await caches.open("maps-tiles-v1");
      await cache.put(url as string, new Response(new Uint8Array(length as number).fill(255)));
    },
    [key, pinnedTile.length] as const,
  );
  const requests = recordTileRequests(page);
  await page.reload();
  await ready(page);
  expect(requests.length).toBeGreaterThan(0);
  await expect.poll(async () => (await view.screenshot()).equals(intact)).toBe(true);
  await expect.poll(async () => (await status(page)).writes).toBe(1);
  expect(await status(page)).toMatchObject({ hits: 1, discarded: 1, misses: 1 });
  expect(await storedBytes(page, key)).toEqual([...pinnedTile]);
});

test("a late response for a source the Map View left is not stored @smoke", async ({ page }) => {
  // A network layer that ignores cancellation and answers after the source changed back.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) =>
      original(input, String(input).includes("fixture-b") ? { ...init, signal: undefined } : init);
  });
  const pending: import("@playwright/test").Route[] = [];
  await page.route("**/tilesets/fixture-b.mvt**", (route) => {
    pending.push(route);
  });
  await page.goto(`${FIXTURE}?persist`);
  await ready(page);
  const surface = surfaceOf(page);
  const a = await tileKey(page);
  await page.getByRole("button", { name: "Source B", exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
  await ready(page);
  const late = page.waitForResponse((response) => response.url().includes("fixture-b.mvt"));
  await pending[0]!.fulfill({
    status: 200,
    body: readFileSync("public/tilesets/fixture-b.mvt"),
    headers: { "Cache-Control": "max-age=3600" },
  });
  await (await late).finished();
  await page.waitForTimeout(300); // A wrongly accepted tile would have been written by now.
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
  expect(await storedTiles(page)).toEqual([a]);
});

test("world copies and overzoom reuse one canonical stored tile @smoke", async ({ page }) => {
  const requests = recordTileRequests(page);
  await page.goto(`${FIXTURE}?persist`);
  await ready(page);
  const key = await tileKey(page);
  await page.evaluate(() => window.tilesetController!.setViewState({ center: [179, 0], zoom: 3 }));
  await ready(page);
  await page.evaluate(() => window.tilesetController!.setViewState({ center: [-179, 20], zoom: 1 }));
  await ready(page);
  await expect.poll(() => storedTiles(page)).toEqual([key]);
  expect(requests.every((url) => url.includes("z=0&x=0&y=0"))).toBe(true);
  expect(await status(page)).toMatchObject({ storedTiles: 1 });
});

test("denied storage and a refused quota leave the Map View on the network path @smoke", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    if (!location.search.includes("denied")) return;
    CacheStorage.prototype.open = () =>
      Promise.reject(new DOMException("Storage is disabled", "SecurityError"));
  });
  const requests = recordTileRequests(page);
  await page.goto(`${FIXTURE}?persist&denied`);
  await ready(page);
  await expect(surfaceOf(page)).toHaveAttribute("data-map-tile-persistence", "unavailable");
  expect(requests.length).toBeGreaterThan(0);
  expect(await status(page)).toMatchObject({ state: "unavailable", storedBytes: 0 });

  const quota = await context.newPage();
  await quota.addInitScript(() => {
    const put = Cache.prototype.put;
    Cache.prototype.put = function (request, response) {
      return String(request).includes("/tile/")
        ? Promise.reject(new DOMException("Quota exceeded", "QuotaExceededError"))
        : put.call(this, request, response);
    };
  });
  await quota.goto(`${FIXTURE}?persist&start=pinned`);
  await ready(quota);
  await expect.poll(async () => (await status(quota)).writeFailures).toBe(1);
  expect(await status(quota)).toMatchObject({ state: "active", storedTiles: 0, misses: 1 });
  expect(await storedTiles(quota)).toEqual([]);
});

test("the byte budget evicts the least recently used tile @smoke", async ({ page }) => {
  const tileBytes = readFileSync("public/tilesets/fixture-a.mvt").length;
  // Room for one fixture tile, not two.
  await page.goto(`${FIXTURE}?persist=${Math.floor(tileBytes * 1.5)}`);
  await ready(page);
  const surface = surfaceOf(page);
  await expect.poll(async () => (await status(page)).writes).toBe(1);
  await page.getByRole("button", { name: "Source B", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-b");
  await ready(page);
  const b = await tileKey(page);
  await expect(surface).toHaveAttribute("data-map-tile-persistence-evictions", "1");
  expect(await status(page)).toMatchObject({
    evictions: 1,
    storedTiles: 1,
    budgetBytes: Math.floor(tileBytes * 1.5),
  });
  expect((await status(page)).storedBytes).toBeLessThanOrEqual(Math.floor(tileBytes * 1.5));
  await expect.poll(() => storedTiles(page)).toEqual([b]);
});
