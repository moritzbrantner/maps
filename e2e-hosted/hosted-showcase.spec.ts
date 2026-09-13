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
  await expect(page.getByText("MapLibre + Canvas2D", { exact: true })).toBeVisible();
  await expect(page.locator(".mb-maps").first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});
