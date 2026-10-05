import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@moritzbrantner/maps/wasm": new URL("./src/maps-wasm-unbuilt.ts", import.meta.url).pathname,
      "@moritzbrantner/maps": new URL("./src/index.ts", import.meta.url).pathname,
      "flat": new URL("./src/flat-shim.ts", import.meta.url).pathname,
      "maplibre-gl": new URL("./src/test-maplibre-gl.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "demo/**/*.test.ts"],
  },
});
