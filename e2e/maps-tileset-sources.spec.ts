import { readFileSync } from "node:fs";
import { createShortbreadTileFixture } from "./fixtures/shortbread-tile.mjs";
import { expect, test } from "@playwright/test";

for (const canvas of [false, true]) {
  test(`PMTiles v3 uses genuine partial 206 reads and the same MVT pixels (${canvas ? "Canvas" : "WebGPU"}) @smoke`, async ({
    page,
  }) => {
    const requests: string[] = [];
    const responses: Array<{ status: number; range: string | undefined }> = [];
    page.on("request", (request) => {
      if (request.url().includes("fixture-pmtiles-v1.pmtiles")) {
        requests.push(request.headers()["range"] ?? "");
      }
    });
    page.on("response", (response) => {
      if (response.url().includes("fixture-pmtiles-v1.pmtiles")) {
        responses.push({ status: response.status(), range: response.headers()["content-range"] });
      }
    });
    await page.goto(`/e2e/fixtures/tileset-sources.html${canvas ? "?canvas" : ""}`);
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    const view = page.locator('[data-map-runtime="maps"]');
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    const sourceA = await view.screenshot();
    const camera = await page.evaluate(() => window.tilesetController!.getViewState());
    await page.getByRole("button", { name: "PMTiles v3", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-id", "fixture-pmtiles");
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    const archivedPixels = await view.screenshot();
    expect(archivedPixels.equals(sourceA)).toBe(false);
    expect(requests).toContain("bytes=0-16383");
    expect(requests.length).toBeGreaterThanOrEqual(3); // Header/root, metadata, tile data.
    expect(responses.every((response) => response.status === 206)).toBe(true);
    const first = responses.find((response) => response.range?.startsWith("bytes 0-16383/"));
    expect(first?.range).toMatch(/^bytes 0-16383\/\d+$/);
    expect(Number(first?.range?.split("/")[1])).toBeGreaterThan(16_384);
    expect(await page.evaluate(() => window.tilesetController!.getViewState())).toEqual(camera);
    await page.getByRole("button", { name: "PMTiles equivalent XYZ", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    expect((await view.screenshot()).equals(archivedPixels)).toBe(true);
    await expect(page.locator("[data-map-overlay-primitives]")).toHaveAttribute(
      "data-map-overlay-primitives",
      "1",
    );
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
  });
}

test("PMTiles archive revision and refresh keep Rust source identity semantics @smoke", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/tileset-sources.html");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await page.getByRole("button", { name: "PMTiles v3", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  const identity = await surface.getAttribute("data-map-source-identity");
  await page.getByRole("button", { name: "Refresh tile URL" }).click();
  await expect(page.getByLabel("Tile transport")).toContainText("credential=refreshed");
  await expect(surface).toHaveAttribute("data-map-source-identity", identity!);
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await page.getByRole("button", { name: "PMTiles revision 2" }).click();
  await expect(surface).toHaveAttribute("data-map-source-revision", "2");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(surface).not.toHaveAttribute("data-map-source-identity", identity!);
});

for (const [name, status, headers] of [
  ["ignored Range", 200, {}],
  ["missing Content-Range", 206, {}],
  ["inconsistent Content-Range", 206, { "Content-Range": "bytes 1-10/99999" }],
  ["HTTP failure", 503, {}],
] as const) {
  test(`PMTiles reports ${name} as a visible source error @smoke`, async ({ page }) => {
    await page.route("**/tilesets/*.pmtiles**", (route) =>
      route.fulfill({ status, body: "bad archive", headers }),
    );
    await page.goto("/e2e/fixtures/tileset-sources.html");
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    await page.getByRole("button", { name: "PMTiles v3", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-state", "error");
    await expect(surface).toHaveAttribute("data-map-base-tile-error", /PMTiles.*(Range|HTTP)/i);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
  });
}

test("PMTiles missing tile is a visible failure; switching restores the prior basemap @smoke", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/tileset-sources.html?canvas");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await page.getByRole("button", { name: "PMTiles v3", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await page.evaluate(() => window.tilesetController!.setViewState({ center: [95, 60], zoom: 1 }));
  await expect(surface).toHaveAttribute("data-map-source-state", "error");
  await expect(surface).toHaveAttribute("data-map-base-tile-error", /missing tile/i);
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
});

test("a late PMTiles range response cannot replace the active source or application selection @smoke", async ({
  page,
}) => {
  // Simulate a network layer that returns after cancellation, as in the XYZ journey.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) =>
      original(input, String(input).includes(".pmtiles") ? { ...init, signal: undefined } : init);
  });
  const pending: import("@playwright/test").Route[] = [];
  await page.route("**/tilesets/*.pmtiles**", (route) => {
    pending.push(route);
  });
  await page.goto("/e2e/fixtures/tileset-sources.html");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  const root = page.locator('[data-map-runtime="maps"]');
  const box = await root.boundingBox();
  await page.mouse.click(box!.x + 320, box!.y + 240);
  await expect(page.getByLabel("Selected Map Feature")).toHaveText("application-point");
  const camera = await page.evaluate(() => window.tilesetController!.getViewState());
  await page.getByRole("button", { name: "PMTiles v3", exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByRole("button", { name: "Source B", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-b");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  const pixels = await root.screenshot();

  const archive = readFileSync("public/tilesets/fixture-pmtiles-v1.pmtiles");
  const lateResponse = page.waitForResponse((response) =>
    response.url().includes("fixture-pmtiles-v1.pmtiles"),
  );
  await pending[0]!.fulfill({
    status: 206,
    body: archive.subarray(0, 16_384),
    headers: { "Content-Range": `bytes 0-16383/${archive.length}`, ETag: '"fixture-v1"' },
  });
  await (await lateResponse).finished();
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-b");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  expect((await root.screenshot()).equals(pixels)).toBe(true);
  await expect(page.getByLabel("Selected Map Feature")).toHaveText("application-point");
  expect(await page.evaluate(() => window.tilesetController!.getViewState())).toEqual(camera);
});

for (const canvas of [false, true]) {
  test(`Map View switches versioned MVT sources and reuses style data (${canvas ? "Canvas" : "WebGPU"}) @smoke`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/e2e/fixtures/tileset-sources.html${canvas ? "?canvas" : ""}`);
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
    await expect(page.locator("[data-map-overlay-primitives]")).toHaveAttribute(
      "data-map-overlay-primitives",
      "1",
    );
    // Base canvases overscan beyond the Map View. Capture its clipped public surface,
    // not the oversized canvas box, which also includes focused buttons above it.
    const presentedCanvas = page.locator('[data-map-runtime="maps"]');
    const initial = await presentedCanvas.screenshot();
    const requests = await surface.getAttribute("data-map-source-requests");
    const decodes = await surface.getAttribute("data-map-source-decodes");
    const builds = await surface.getAttribute("data-map-source-bucket-builds");
    await page.getByRole("button", { name: "Red forest" }).click();
    await expect(surface).toHaveAttribute("data-map-source-requests", requests!);
    await expect(surface).toHaveAttribute("data-map-source-decodes", decodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", builds!);
    const styled = await presentedCanvas.screenshot();
    expect(styled.equals(initial)).toBe(false);
    await page.getByRole("button", { name: "Source B" }).click();
    await expect(surface).toHaveAttribute("data-map-source-id", "fixture-b");
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    const bPixels = await presentedCanvas.screenshot();
    expect(bPixels.equals(styled)).toBe(false);
    const bRequests = Number(await surface.getAttribute("data-map-source-requests"));
    const bDecodes = await surface.getAttribute("data-map-source-decodes");
    const bBuilds = await surface.getAttribute("data-map-source-bucket-builds");
    await page.getByRole("button", { name: "Source A", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    expect(Number(await surface.getAttribute("data-map-source-requests"))).toBe(bRequests);
    await expect(surface).toHaveAttribute("data-map-source-decodes", bDecodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", bBuilds!);
    const warmPixels = await presentedCanvas.screenshot();
    await test.info().attach("styled-a", { body: styled, contentType: "image/png" });
    await test.info().attach("warm-a", { body: warmPixels, contentType: "image/png" });
    expect(warmPixels.equals(styled)).toBe(true);
    await page.getByRole("button", { name: "Revision 2", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-revision", "2");
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    expect(Number(await surface.getAttribute("data-map-source-requests"))).toBeGreaterThan(
      bRequests,
    );
    expect(errors).toEqual([]);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
  });
}

test("Map View rejects reversed late source responses while preserving camera and application selection @smoke", async ({
  page,
}) => {
  // Exercise non-cooperative transports: an aborted fetch can still resolve.
  await page.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (input, init) =>
      fetchOriginal(
        input,
        String(input).includes("/tilesets/") ? { ...init, signal: undefined } : init,
      );
  });
  const pending: import("@playwright/test").Route[] = [];
  await page.route("**/tilesets/*.mvt?**", (route) => {
    pending.push(route);
  });
  await page.goto("/e2e/fixtures/tileset-sources.html");
  await expect.poll(() => pending.length).toBe(1);
  const root = page.locator('[data-map-runtime="maps"]');
  const box = await root.boundingBox();
  await page.mouse.click(box!.x + 320, box!.y + 240);
  await expect(page.getByLabel("Selected Map Feature")).toHaveText("application-point");
  const before = await page.evaluate(() => window.tilesetController!.getViewState());
  await page.getByRole("button", { name: "Source B" }).click();
  await expect.poll(() => pending.length).toBe(2);
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect.poll(() => pending.length).toBe(3);
  const body = (await pending[2]!.fetch()).body();
  await pending[2]!.fulfill({ body: await body });
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  const correct = await surface.screenshot();
  // B then original A resolve after the replacement A has already rendered.
  for (const route of [pending[1]!, pending[0]!]) {
    await route.fulfill({ response: await route.fetch() });
  }
  await expect(surface).toHaveAttribute("data-map-source-id", "fixture-a");
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  expect((await surface.screenshot()).equals(correct)).toBe(true);
  await expect(page.getByLabel("Selected Map Feature")).toHaveText("application-point");
  expect(await page.evaluate(() => window.tilesetController!.getViewState())).toEqual(before);
  expect(Number(await surface.getAttribute("data-map-source-decodes"))).toBe(2);
  await expect(page.locator(".maplibregl-map")).toHaveCount(0);
});

test("Engine Inspector exposes the active Maps Tileset identity, metadata and request failures @smoke", async ({
  page,
}) => {
  await page.route("**/tilesets/fixture-b.mvt?**", (route) => route.fulfill({ status: 503 }));
  await page.goto("/engine/?view=inspector&source=a&e2e=1");
  await expect(page.getByText("fixture-a / 1", { exact: true })).toBeVisible();
  await expect(page.getByText("CC0-1.0", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Tile source", exact: true }).selectOption("b");
  await expect(page.getByText("fixture-b / 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  await expect(page.locator(".maplibregl-map")).toHaveCount(0);
});

test("source revisions evict old decoded and GPU resources under the shared Rust budget @smoke", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/tileset-sources.html?smallCache");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  for (const name of ["Source B", "Revision 2"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    expect(
      Number(await surface.getAttribute("data-map-source-retained-tiles")),
    ).toBeLessThanOrEqual(2);
  }
  const requests = Number(await surface.getAttribute("data-map-source-requests"));
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  expect(Number(await surface.getAttribute("data-map-source-requests"))).toBe(requests + 1);
  expect(Number(await surface.getAttribute("data-map-source-retained-tiles"))).toBe(2);
});

test("canonical source tiles are shared by antimeridian world copies and overzoom @smoke", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/tileset-sources.html");
  const surface = page.locator('canvas[data-flat-runtime="maps"]');
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(surface).toHaveAttribute("data-map-source-requests", "1");
  await page.evaluate(() => window.tilesetController!.setViewState({ center: [179, 0], zoom: 4 }));
  await expect(surface).toHaveAttribute("data-map-source-requests", "1");
  const camera = await page.evaluate(() => window.tilesetController!.getViewState());
  await page.getByRole("button", { name: "Source B", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(surface).toHaveAttribute("data-map-source-requests", "2");
  expect(await page.evaluate(() => window.tilesetController!.getViewState())).toEqual(camera);
  await page.evaluate(() => window.tilesetController!.setViewState({ center: [-179, 0], zoom: 0 }));
  await page.getByRole("button", { name: "Source A", exact: true }).click();
  await expect(surface).toHaveAttribute("data-map-source-state", "ready");
  await expect(surface).toHaveAttribute("data-map-source-requests", "2");
});

for (const name of ["Malformed manifest", "Unsupported schema"]) {
  test(`public Map View rejects ${name.toLowerCase()} before source requests @smoke`, async ({
    page,
  }) => {
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/tilesets/")) requests++;
    });
    await page.goto("/e2e/fixtures/tileset-sources.html");
    await expect(page.locator('canvas[data-flat-runtime="maps"]')).toHaveAttribute(
      "data-map-source-state",
      "ready",
    );
    expect(requests).toBe(1);
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Maps Tileset");
    expect(requests).toBe(1);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
  });
}

for (const canvas of [false, true]) {
  const renderer = canvas ? "Canvas" : "WebGPU";
  test(`pending XYZ URL refresh keeps the source identity and rejects old non-cooperative results (${renderer}) @smoke`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const fetchOriginal = window.fetch.bind(window);
      const aborted: string[] = [];
      Object.defineProperty(window, "tileAbortRequests", { get: () => aborted.slice() });
      window.fetch = (input, init) => {
        if (!String(input).includes("/tilesets/")) return fetchOriginal(input, init);
        init?.signal?.addEventListener("abort", () => aborted.push(String(input)), { once: true });
        return fetchOriginal(input, { ...init, signal: undefined });
      };
    });
    const pending: import("@playwright/test").Route[] = [];
    let refreshedRequests = 0;
    await page.route("**/tilesets/fixture-a.mvt?**", async (route) => {
      if (!route.request().url().includes("credential=refreshed")) {
        pending.push(route);
        return;
      }
      refreshedRequests++;
      await route.fulfill({ response: await route.fetch() });
    });
    await page.goto(`/e2e/fixtures/tileset-sources.html${canvas ? "?canvas" : ""}`);
    await expect.poll(() => pending.length).toBe(1);
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    const identity = await surface.getAttribute("data-map-source-identity");
    const camera = await page.evaluate(() => window.tilesetController!.getViewState());
    await page.getByRole("button", { name: "Update observation", exact: true }).click();
    await expect(page.getByLabel("Source observation")).toHaveText("updated-observation");
    await page.getByRole("button", { name: "Red forest", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-requests", "1");
    expect(refreshedRequests).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, "tileAbortRequests"))).toEqual([]);

    await page.getByRole("button", { name: "Refresh tile URL", exact: true }).click();
    await expect.poll(() => refreshedRequests).toBe(1);
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    await expect(surface).toHaveAttribute("data-map-source-identity", identity!);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "tileAbortRequests").length))
      .toBe(1);
    await expect(page.locator("[data-map-overlay-primitives]")).toHaveAttribute(
      "data-map-overlay-primitives",
      "1",
    );
    const view = page.locator('[data-map-runtime="maps"]');
    const pixels = await view.screenshot();
    const decodes = await surface.getAttribute("data-map-source-decodes");
    const buckets = await surface.getAttribute("data-map-source-bucket-builds");
    const oldFinished = page.waitForResponse(
      (response) =>
        response.url().includes("/tilesets/fixture-a.mvt?") &&
        !response.url().includes("credential=refreshed"),
    );
    const wrongOldTile = await page.request.get("/tilesets/fixture-b.mvt");
    await pending[0]!.fulfill({
      body: await wrongOldTile.body(),
      contentType: "application/vnd.mapbox-vector-tile",
    });
    await (await oldFinished).finished();
    expect((await view.screenshot()).equals(pixels)).toBe(true);
    await expect(surface).toHaveAttribute("data-map-source-decodes", decodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", buckets!);

    await page.getByRole("button", { name: "Refresh tile URL", exact: true }).click();
    await expect(page.getByLabel("Tile transport")).toContainText(
      "credential=refreshed&credential=refreshed",
    );
    await expect(surface).toHaveAttribute("data-map-source-requests", "2");
    await expect(surface).toHaveAttribute("data-map-source-decodes", decodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", buckets!);
    expect(refreshedRequests).toBe(1);
    expect(await page.evaluate(() => window.tilesetController!.getViewState())).toEqual(camera);
    await expect(page.locator(".maplibregl-map")).toHaveCount(0);
  });

  test(`failed XYZ URL refresh retries without discarding loaded source data (${renderer}) @smoke`, async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/tilesets/fixture-a.mvt?**", async (route) => {
      requests++;
      if (!route.request().url().includes("credential=refreshed")) {
        await route.fulfill({ status: 401 });
        return;
      }
      await route.fulfill({ response: await route.fetch() });
    });
    await page.goto(`/e2e/fixtures/tileset-sources.html${canvas ? "?canvas" : ""}`);
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    await expect(surface).toHaveAttribute("data-map-source-state", "error");
    await expect(surface).toHaveAttribute("data-map-base-tile-error", /HTTP 401/);
    const identity = await surface.getAttribute("data-map-source-identity");
    await page.getByRole("button", { name: "Update observation", exact: true }).click();
    await expect(page.getByLabel("Source observation")).toHaveText("updated-observation");
    await page.getByRole("button", { name: "Red forest", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-state", "error");
    expect(requests).toBe(1);
    await page.getByRole("button", { name: "Refresh tile URL", exact: true }).click();
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    await expect(surface).toHaveAttribute("data-map-source-identity", identity!);
    await expect(surface).not.toHaveAttribute("data-map-base-tile-error");
    expect(requests).toBe(2);
    const decodes = await surface.getAttribute("data-map-source-decodes");
    const buckets = await surface.getAttribute("data-map-source-bucket-builds");
    await page.getByRole("button", { name: "Refresh tile URL", exact: true }).click();
    await expect(page.getByLabel("Tile transport")).toContainText(
      "credential=refreshed&credential=refreshed",
    );
    expect(requests).toBe(2);
    await expect(surface).toHaveAttribute("data-map-source-decodes", decodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", buckets!);
  });
}

for (const canvas of [false, true]) {
  test(`public building outline opacity preserves Canvas/WebGPU paint parity (${canvas ? "Canvas" : "WebGPU"}) @smoke`, async ({
    page,
  }) => {
    await page.route("**/tilesets/fixture-a.mvt?**", (route) =>
      route.fulfill({
        body: createShortbreadTileFixture({ building: true }),
        contentType: "application/vnd.mapbox-vector-tile",
      }),
    );
    await page.goto(`/e2e/fixtures/tileset-sources.html?building${canvas ? "&canvas" : ""}`);
    const surface = page.locator('canvas[data-flat-runtime="maps"]');
    await expect(surface).toHaveAttribute("data-map-source-state", "ready");
    await expect(page.locator("[data-map-overlay-primitives]")).toHaveAttribute(
      "data-map-overlay-primitives",
      "1",
    );
    const view = page.locator('[data-map-runtime="maps"]');
    const pixels = async () => {
      const bytes = await view.screenshot();
      return page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return {
          outline: Array.from(context.getImageData(256, 240, 1, 1).data),
          background: Array.from(context.getImageData(240, 240, 1, 1).data),
        };
      }, bytes.toString("base64"));
    };
    const opaque = await pixels();
    expect(opaque.outline.slice(0, 3)).toEqual([0, 0, 0]);
    const requests = await surface.getAttribute("data-map-source-requests");
    const decodes = await surface.getAttribute("data-map-source-decodes");
    const buckets = await surface.getAttribute("data-map-source-bucket-builds");
    await page.getByRole("button", { name: "Hide building outline", exact: true }).click();
    const hidden = await pixels();
    expect(hidden.outline).toEqual(hidden.background);
    await page.getByRole("button", { name: "Half building outline", exact: true }).click();
    const half = await pixels();
    for (let channel = 0; channel < 3; channel++) {
      expect(
        Math.abs(half.outline[channel]! - half.background[channel]! * 0.5),
      ).toBeLessThanOrEqual(1);
    }
    await expect(surface).toHaveAttribute("data-map-source-requests", requests!);
    await expect(surface).toHaveAttribute("data-map-source-decodes", decodes!);
    await expect(surface).toHaveAttribute("data-map-source-bucket-builds", buckets!);
  });
}
