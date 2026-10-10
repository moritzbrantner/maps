import { expect, test } from "@playwright/test";

// Acceptance for #214. When the aggregation WASM runtime fails to load, ClusterLayer renders the
// explicit unclustered fallback. With 100k points that fallback must be a bounded number of
// MapLibre style layers (not one source+layer per point), the page must stay responsive, and
// individual features must stay selectable.

const MAX_STYLE_LAYERS = 50;
const RESPONSIVE_BUDGET_MS = 3_000;

type Probe = {
  latest: { clusters: number; points: number; unclustered: number } | null;
  maxRenderedFeatures: number;
  samples: number;
};

type ProbeMap = {
  getCanvas(): HTMLCanvasElement;
  getStyle(): { layers?: unknown[] } | undefined;
  project(lngLat: [number, number]): { x: number; y: number };
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

test("a failed aggregation runtime renders 100k points as a bounded, selectable fallback", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let missingAggregationRequests = 0;
  await page.route("**/wasm/missing-aggregation.js", async (route) => {
    missingAggregationRequests += 1;
    await route.fulfill({ status: 404, body: "" });
  });

  await page.goto("/?e2e=1&acceptance=maps-cluster-race&aggregationWasm=missing");
  const map = page.getByLabel("Dense cluster race");
  await expect(map).toBeVisible();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    expect(
      await respondsWithin(() => page.evaluate(() => performance.now()), RESPONSIVE_BUDGET_MS),
    ).toBe("responsive");
    await page.waitForTimeout(250);
  }

  expect(missingAggregationRequests).toBeGreaterThan(0);
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: 30_000 });

  // The explicit fallback is actually rendered (unclustered points are visible)...
  await expect
    .poll(
      async () => {
        const probe = await page.evaluate(
          () => (window as unknown as { __MB_CLUSTER_RACE__?: Probe }).__MB_CLUSTER_RACE__,
        );
        return probe?.latest?.unclustered ?? 0;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(1_000);

  // ...as a bounded number of style layers rather than one per point.
  const layerCount = await page.evaluate(() => {
    const instance = (window as unknown as { __MB_CLUSTER_RACE_MAP__?: ProbeMap })
      .__MB_CLUSTER_RACE_MAP__;
    return instance?.getStyle()?.layers?.length ?? Number.POSITIVE_INFINITY;
  });
  expect(layerCount).toBeLessThanOrEqual(MAX_STYLE_LAYERS);

  // Individual fallback features remain selectable.
  const target = await page.evaluate(() => {
    const instance = (window as unknown as { __MB_CLUSTER_RACE_MAP__?: ProbeMap })
      .__MB_CLUSTER_RACE_MAP__;
    if (!instance) return null;
    const canvas = instance.getCanvas().getBoundingClientRect();
    const point = instance.project([12, 50]);
    return { x: canvas.left + point.x, y: canvas.top + point.y };
  });
  expect(target).not.toBeNull();
  await expect
    .poll(
      async () => {
        await page.mouse.click(target!.x, target!.y);
        return page.getByTestId("cluster-race-selected").textContent();
      },
      { timeout: 15_000 },
    )
    .toMatch(/d-\d+/);
});
