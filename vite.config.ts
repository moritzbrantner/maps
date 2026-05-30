import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ["@mb-rust/geo-viz-wasm"],
  },
  resolve: {
    alias: {
      "@moritzbrantner/maps": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      "@moritzbrantner/viz-engine": fileURLToPath(
        new URL("./src/test-viz-engine.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});
