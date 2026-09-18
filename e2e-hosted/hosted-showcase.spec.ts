import { expect, test } from "@playwright/test";

test("hosted Pages artifact reaches Rust authority without browser errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/maps/?e2e=1");

  await expect(page.getByRole("heading", { name: "Map building blocks, end to end." })).toBeVisible();
  await expect(page.getByTestId("rust-runtime-status")).toHaveAttribute(
    "data-state",
    "authoritative",
    { timeout: 30_000 },
  );
  await expect(page.getByText("Rust/WASM + wgpu", { exact: true })).toBeVisible();
  await expect(page.locator(".mb-maps").first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("hosted evidence page fails closed with actionable missing runtime diagnostics", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/maps/evidence/");

  await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
  const runtimeRow = page
    .getByRole("row")
    .filter({ hasText: "Runtime and Moonlight evidence" });
  await expect(runtimeRow).toContainText("source-unavailable", { timeout: 45_000 });
  await expect(runtimeRow).toContainText("unavailable");
  await expect(runtimeRow).toContainText(
    "Evidence source returned non-JSON content (text/html).",
  );
  await expect(page.getByText(/evidence sources need attention/)).toBeVisible();

  expect(pageErrors).toEqual([]);
});
