import { expect, test, type Page } from "@playwright/test";

// #305: the WebGPU-free core module serves Canvas2D Map Views; a WebGPU Map View loads only the
// full renderer module (a superset of the core), so neither path fetches both modules.
function recordWasmModules(page: Page) {
  const modules: string[] = [];
  page.on("request", (request) => {
    const match = /\/(maps_wasm(?:_core)?_bg)[^/]*\.wasm(?:\?|$)/.exec(request.url());
    if (match) modules.push(match[1]!);
  });
  return modules;
}

test("a Canvas2D Map View fetches only the WebGPU-free core module @smoke", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const modules = recordWasmModules(page);
  await page.goto("/engine/?source=pmtiles&e2e=1");
  const base = page.locator("[data-flat-runtime=maps]");
  await expect(base).toHaveAttribute("data-map-source-state", "ready", { timeout: 30_000 });
  await expect(base).toHaveAttribute("data-map-base-renderer", "canvas2d");
  await expect
    .poll(async () => Number(await base.getAttribute("data-map-source-retained-tiles")))
    .toBeGreaterThan(0);
  expect([...new Set(modules)]).toEqual(["maps_wasm_core_bg"]);
});

test("a WebGPU Map View fetches only the full renderer module @smoke", async ({ page }) => {
  const modules = recordWasmModules(page);
  await page.goto("/engine/?source=pmtiles&e2e=1");
  const base = page.locator("[data-flat-runtime=maps]");
  await expect(base).toHaveAttribute("data-map-source-state", "ready", { timeout: 30_000 });
  await expect(base).toHaveAttribute("data-map-base-renderer", "wgpu");
  expect([...new Set(modules)]).toEqual(["maps_wasm_bg"]);
});
