import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    core: "src/entries/core.ts",
    layers: "src/entries/layers.ts",
    flat: "src/entries/flat.ts",
    globe: "src/entries/globe.ts",
    editor: "src/entries/editor.ts",
    timeline: "src/entries/timeline.ts",
  },
  format: ["esm"],
  outDir: "dist",
  splitting: false,
});
