import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  outputDir: "test-results-hosted",
  projects: [
    {
      name: "hosted-chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
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
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "bunx --bun vite preview --host 127.0.0.1 --port 5182 --strictPort --base /maps/",
    reuseExistingServer: false,
    url: "http://127.0.0.1:5182/maps/",
  },
});
