import { expect, test } from "@playwright/test";

test("Pages showcase makes the Map Library capabilities and runtime boundary visible @smoke", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  await expect(page.getByRole("heading", { name: "Map building blocks, end to end." })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Map examples" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Clusters" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Editor" })).toBeVisible();

  const runtimeStatus = page.getByTestId("rust-runtime-status");
  await expect(runtimeStatus).toHaveAttribute("data-state", /verified|unavailable/);
  await expect(page.getByText("MapLibre", { exact: true })).toBeVisible();
  await expect(page.locator(".mb-maps").first()).toBeVisible();
});
