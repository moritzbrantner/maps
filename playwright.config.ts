import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixelRatio: 0.02,
    },
  },
  projects: [
    {
      name: "chromium",
      grepInvert: /@mobile/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
        },
        viewport: { height: 1000, width: 1440 },
      },
    },
    {
      name: "mobile-chromium",
      grep: /@mobile/,
      use: {
        ...devices["Pixel 5"],
        launchOptions: {
          args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
        },
        viewport: { height: 844, width: 390 },
      },
    },
  ],
  reporter: [["list"], ["html", { open: "never" }]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  timeout: 60_000,
  testDir: "e2e",
  use: {
    baseURL: "http://127.0.0.1:5181",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bun run dev -- --host 127.0.0.1 --port 5181",
    reuseExistingServer: false,
    url: "http://127.0.0.1:5181",
  },
});
