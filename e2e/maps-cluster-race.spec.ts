import { expect, test } from "@playwright/test";

// Acceptance for #212. A MapLibre-backed Map View with 100k clustered points mounts before the
// aggregation WASM runtime is ready (the runtime download is held back), so `style.load` wins
// the race. The page must stay responsive and must never render the dense dataset as
// per-point features; once the runtime arrives the view is clustered.

const WASM_DELAY_MS = 6_000;
const MAX_RENDERED_FEATURES = 5_000;
const RESPONSIVE_BUDGET_MS = 3_000;

type Probe = {
  latest: { clusters: number; points: number; unclustered: number } | null;
  maxRenderedFeatures: number;
  samples: number;
};

async function respondsWithin(evaluate: () => Promise<unknown>, budgetMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"blocked">((resolve) => {
    timer = setTimeout(() => resolve("blocked"), budgetMs);
  });
  const result = await Promise.race([evaluate().then(() => "responsive" as const), timeout]);
  clearTimeout(timer);
  return result;
}

test("100k clustered points stay responsive and clustered when the map style loads before the aggregation runtime", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let delayedWasmRequests = 0;
  await page.route("**/wasm/maps_wasm*", async (route) => {
    delayedWasmRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, WASM_DELAY_MS));
    await route.continue();
  });

  await page.goto("/?e2e=1&acceptance=maps-cluster-race");
  const map = page.getByLabel("Dense cluster race");
  await expect(map).toBeVisible();

  // The main thread must keep answering while the runtime is still held back and right after
  // it arrives (no multi-second style re-validation storms).
  const deadline = Date.now() + WASM_DELAY_MS + 6_000;
  while (Date.now() < deadline) {
    expect(
      await respondsWithin(() => page.evaluate(() => performance.now()), RESPONSIVE_BUDGET_MS),
    ).toBe("responsive");
    await page.waitForTimeout(250);
  }

  expect(delayedWasmRequests).toBeGreaterThan(0);
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: 30_000 });

  // Once the runtime is available the dense view is clustered.
  await expect
    .poll(
      async () => {
        const probe = await page.evaluate(
          () => (window as unknown as { __MB_CLUSTER_RACE__?: Probe }).__MB_CLUSTER_RACE__,
        );
        const latest = probe?.latest;
        return (
          latest !== null &&
          latest !== undefined &&
          latest.clusters > 0 &&
          latest.unclustered < latest.points
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // At no point, before or after the runtime arrived, was the dataset rendered point by point.
  const probe = await page.evaluate(
    () => (window as unknown as { __MB_CLUSTER_RACE__?: Probe }).__MB_CLUSTER_RACE__,
  );
  expect(probe?.samples ?? 0).toBeGreaterThan(0);
  expect(probe?.maxRenderedFeatures ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    MAX_RENDERED_FEATURES,
  );
});
