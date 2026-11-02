import { defineConfig, devices } from "@playwright/test";

import { WEBGPU_SWIFTSHADER_ARGS } from "./e2e/helpers/webgpu-args";

export default defineConfig({
  outputDir: "test-results-hosted",
  projects: [
    {
      name: "hosted-chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: WEBGPU_SWIFTSHADER_ARGS,
          // Optional exact browser binary for local acceptance; CI uses its pinned Playwright browser.
          ...(process.env.MAPS_BROWSER_EXECUTABLE
            ? { executablePath: process.env.MAPS_BROWSER_EXECUTABLE }
            : {}),
        },
        viewport: { height: 1000, width: 1440 },
      },
    },
  ],
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-hosted" }]],
  testDir: "e2e-hosted",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5182",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    // A locally supplied Chrome binary need not come with Playwright's ffmpeg helper.
    video: process.env.MAPS_BROWSER_EXECUTABLE ? "off" : "retain-on-failure",
  },
  webServer: {
    command: "bunx --bun vite preview --host 127.0.0.1 --port 5182 --strictPort --base /maps/",
    reuseExistingServer: false,
    url: "http://127.0.0.1:5182/maps/",
  },
});
