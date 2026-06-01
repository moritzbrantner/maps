import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "flat": new URL("./src/flat-shim.ts", import.meta.url).pathname,
      "maplibre-gl": new URL("./src/test-maplibre-gl.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
