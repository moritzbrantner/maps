import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    core: "src/entries/core.ts",
    layers: "src/entries/layers.ts",
    flat: "src/entries/flat.ts",
    editor: "src/entries/editor.ts",
    timeline: "src/entries/timeline.ts",
    geojson: "src/entries/geojson.ts",
    heat: "src/entries/heat.ts",
    measurement: "src/entries/measurement.ts",
    temporal: "src/entries/temporal.ts",
  },
  format: ["esm"],
  minifyWhitespace: true,
  outDir: "dist",
  splitting: true,
});
