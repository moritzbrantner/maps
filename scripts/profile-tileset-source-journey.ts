import type { Browser } from "@playwright/test";
import { createHash } from "node:crypto";

export async function profileTilesetSourceJourney(
  browser: Browser,
  origin: string,
  viewport: { width: number; height: number },
  fixture: Buffer,
  fixtureB: Buffer,
  samples: number,
) {
  // Reuse the dense vector-city fixture and tile-lifecycle observations on the
  // public Maps Tileset path. This extends the existing journey, not its verdict.
  const sourcePage = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
  });
  let sourceNetworkRequests = 0;
  await sourcePage.route("**/tilesets/fixture-*.mvt?**", (route) => {
    sourceNetworkRequests++;
    const isB = route.request().url().includes("fixture-b");
    return route.fulfill({
      body: isB ? fixtureB : fixture,
      contentType: "application/vnd.mapbox-vector-tile",
    });
  });
  await sourcePage.goto(`${origin}/maps/engine/?view=inspector&source=a&e2e=1`);
  const sourceCanvas = sourcePage.locator("canvas[data-flat-runtime=maps]");
  const readySource = () =>
    sourceCanvas.getAttribute("data-map-source-state").then((state) => state === "ready");
  await sourcePage.waitForFunction(
    () =>
      document
        .querySelector("canvas[data-flat-runtime=maps]")
        ?.getAttribute("data-map-source-state") === "ready",
  );
  const sourceObservations: Record<string, unknown>[] = [];
  const readSource = async (phase: string) => {
    if (!(await readySource())) {
      throw new Error(`Source ${phase} did not become ready`);
    }
    const observation = await sourcePage.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-flat-runtime=maps]")!;
      const numeric = (key: string) => Number(canvas.dataset[key]);
      return {
        sourceId: canvas.dataset.mapSourceId,
        revision: canvas.dataset.mapSourceRevision,
        requests: numeric("mapSourceRequests"),
        decodes: numeric("mapSourceDecodes"),
        bucketBuilds: numeric("mapSourceBucketBuilds"),
        cacheReuses: numeric("mapSourceCacheReuses"),
        retainedTiles: numeric("mapSourceRetainedTiles"),
        switchMs: numeric("mapSourceSwitchMs"),
        jsHeapBytes:
          (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? null,
      };
    });
    sourceObservations.push({ phase, ...observation, networkRequests: sourceNetworkRequests });
    return observation;
  };
  await readSource("cold-a");
  const chooseSource = async (source: string) => {
    await sourcePage
      .getByRole("combobox", { name: "Tile source", exact: true })
      .selectOption(source);
    await sourcePage.waitForFunction((choice) => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-flat-runtime=maps]");
      return (
        canvas?.dataset.mapSourceState === "ready" &&
        canvas.dataset.mapSourceId === `fixture-${choice === "b" ? "b" : "a"}` &&
        canvas.dataset.mapSourceRevision === (choice === "a2" ? "2" : "1")
      );
    }, source);
  };
  for (let sample = 0; sample < samples; sample++) {
    await chooseSource("b");
    await readSource(`b-${sample}`);
    await chooseSource("a");
    const warm = await readSource(`warm-a-${sample}`);
    const forest = sourcePage.getByLabel("land-forest", { exact: true });
    await forest.setChecked(!(await forest.isChecked()));
    const styled = await readSource(`style-${sample}`);
    if (
      styled.requests !== warm.requests ||
      styled.decodes !== warm.decodes ||
      styled.bucketBuilds !== warm.bucketBuilds
    ) {
      throw new Error("Style change repeated source work");
    }
  }
  await chooseSource("a2");
  await readSource("revision-2");
  const sourceLifecycle = {
    scenarios: ["vector-city-style-v1", "raster-tile-churn-v1"],
    scope:
      "Dense canonical MVT on public Map View: cold A, B/A revisits, resolved-paint changes, revision bump. Tile churn correctness remains Rust/browser lifecycle checks; this is source-switch cost, not a camera-churn performance verdict.",
    samples,
    fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
    secondFixtureSha256: createHash("sha256").update(fixtureB).digest("hex"),
    backend: await sourceCanvas.getAttribute("data-map-base-renderer"),
    observations: sourceObservations,
    memoryScope:
      "Chromium JS heap is descriptive and GC-dependent; decoded images are 512×512 RGBA per retained tile, plus MVT bytes, decoded pixel objects and GPU buckets. No process/GPU-total or controlled baseline verdict.",
    comparison: {
      status: "unavailable",
      reason:
        "Parent public Map View cannot execute versioned-source switching; no comparable source-switch baseline.",
    },
  };
  if (sourceNetworkRequests !== 3) {
    throw new Error(
      `Expected exactly cold A, B and revision-2 requests; received ${sourceNetworkRequests}`,
    );
  }
  await sourcePage.close();
  return sourceLifecycle;
}
