import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        showcase: fileURLToPath(new URL("./index.html", import.meta.url)),
        engine: fileURLToPath(new URL("./engine/index.html", import.meta.url)),
      },
    },
  },
  optimizeDeps: {
    // Scan browser fixtures up front; late reference imports can otherwise reload
    // an already-ready acceptance page while assertions are in flight.
    entries: ["index.html", "engine/index.html", "e2e/fixtures/*.html"],
    exclude: ["maplibre-gl"],
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@moritzbrantner/maps/wasm": fileURLToPath(
        new URL("./src/maps-wasm-unbuilt.ts", import.meta.url),
      ),
      "@moritzbrantner/maps": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
});
