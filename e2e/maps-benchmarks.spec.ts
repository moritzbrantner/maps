import { expect, test } from "@playwright/test";

test("benchmark lab compares explicit renderers without turning local timing into evidence @smoke", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://unpkg.com/**", (route) => route.abort());

  await page.goto("/benchmarks/?e2e=1");

  await expect(page.getByRole("heading", { name: "Renderer benchmark lab" })).toBeVisible();
  await expect(page.getByLabel("Benchmark point count")).toHaveValue("400");
  await expect(page.getByLabel("Benchmark camera steps")).toHaveValue("4");
  await expect(page.getByTestId("benchmark-result-maps")).toContainText("Maps engine");
  await expect(page.getByTestId("benchmark-result-canvas2d")).toContainText(
    "Canvas2D reference",
  );
  await expect(page.getByTestId("benchmark-result-leaflet")).toContainText("Leaflet 1.9.4");
  await expect(page.getByTestId("benchmark-result-maplibre")).toContainText(
    "MapLibre GL 6.4.1",
  );
  await expect(
    page.getByText("These timings are local-session diagnostics only.", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Run Canvas2D reference" }).click();
  const canvasResult = page.getByTestId("benchmark-result-canvas2d");
  await expect(canvasResult).toContainText("Complete · pixel-only Canvas2D");
  await expect(canvasResult).toContainText("ms");
  await expect(page.getByLabel("Canvas2D benchmark preview")).toBeVisible();

  await expect(page.getByTestId("benchmark-result-leaflet")).toContainText("Unavailable", {
    timeout: 10_000,
  });
  expect(pageErrors).toEqual([]);
});
