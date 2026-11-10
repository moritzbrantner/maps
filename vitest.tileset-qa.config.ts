import { defineConfig } from "vitest/config";

// Tileset QA (#276) runs against the built Rust/WASM kernel, so it is its own gate
// (`bun run verify:tileset-qa`) and not part of the WASM-free unit suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/tileset-qa/**/*.test.ts"],
  },
});
