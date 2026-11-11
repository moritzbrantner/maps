// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

let fixtureId = 0;

// Exercise the real dynamic-import boundary, including overlapping initialization.
// Keep "." out of the fixture source: Bun picks a data URL's loader from its last extension.
function wasmPackage({ failOnce = false, name = "module" } = {}) {
  return `data:text/javascript,${encodeURIComponent(`
    // fixture ${fixtureId++}
    let starts = 0;
    let ready = false;
    export const moduleName = ${JSON.stringify(name)};
    export default async function initialize() {
      starts++;
      const all = (globalThis["mapsWasmStarts"] ??= {});
      all[moduleName] = (all[moduleName] ?? 0) + 1;
      await new Promise(resolve => setTimeout(resolve, 0));
      if (${failOnce} && starts === 1) throw new Error("initialization failed");
      ready = true;
    }
    export class MapsPointAggregationIndex {}
    export function createScalarFieldGrid() {
      return { bounds: [0, 0, 1, 1], columns: 1, rows: 1, valueDomain: [1, 1], values: [1] };
    }
    export function decodeShortbreadBasemap() {
      if (!ready) throw new Error("not initialized");
      return { lines: [], polygons: [], starts };
    }
    export function decodeShortbreadBasemapLines() {
      if (!ready) throw new Error("not initialized");
      return [];
    }
  `)}`;
}

// Vitest's VM cannot perform the constructor-based dynamic import. A Bun process
// exercises the production loaders without mocking the module boundary.
function runLoaders(packageNames: string[], body: string): unknown {
  return JSON.parse(
    execFileSync(
      "bun",
      [
        "--eval",
        `
    import {
      configureMapsWasmPackage,
      importMapsWasmModule,
      loadMapsAggregationWasmRuntime,
      preferMapsWasmRendererModule,
    } from "./src/aggregation-wasm";
    import { decodeShortbreadBasemap, decodeShortbreadBasemapLines } from "./src/vector-tile-wasm";
    import { initializeMapsScalarFieldWasm } from "./src/scalar-field";
    import { loadMapsWasmKernelRuntime } from "./src/kernels/wasm-kernels";
    const [first, second] = ${JSON.stringify(packageNames)};
    const tile = { x: 0, y: 0, z: 0 };
    const bytes = new ArrayBuffer(0);
    ${body}
  `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 },
    ),
  );
}

describe("Maps WASM package loading", () => {
  test("shares initialization across concurrent runtime loaders and subsequent tiles", () => {
    const result = runLoaders(
      [wasmPackage()],
      `
      configureMapsWasmPackage(first);
      const [, result, lines] = await Promise.all([
        loadMapsAggregationWasmRuntime(),
        decodeShortbreadBasemap(bytes, tile, first),
        decodeShortbreadBasemapLines(bytes, tile),
      ]);
      const next = await decodeShortbreadBasemap(bytes, tile);
      console.log(JSON.stringify({ result, lines, next }));
    `,
    );
    expect(result).toEqual({
      result: { lines: [], polygons: [], starts: 1 },
      lines: [],
      next: { lines: [], polygons: [], starts: 1 },
    });
  });

  test("keeps different configured packages independent", () => {
    const result = runLoaders(
      [wasmPackage(), wasmPackage()],
      `
      configureMapsWasmPackage(first);
      const a = await decodeShortbreadBasemap(bytes, tile);
      configureMapsWasmPackage(second);
      const b = await decodeShortbreadBasemap(bytes, tile);
      const c = await decodeShortbreadBasemap(bytes, tile, first);
      console.log(JSON.stringify([a, b, c]));
    `,
    );
    expect(result).toEqual(
      Array.from({ length: 3 }, () => ({ lines: [], polygons: [], starts: 1 })),
    );
  });

  test("shares the same package with scalar fields and geometry kernels", () => {
    const result = runLoaders(
      [wasmPackage()],
      `
      const [scalar] = await Promise.all([
        initializeMapsScalarFieldWasm(first),
        loadMapsWasmKernelRuntime(first),
        loadMapsAggregationWasmRuntime(first),
      ]);
      console.log(JSON.stringify({ scalar, tile: await decodeShortbreadBasemap(bytes, tile, first) }));
    `,
    );
    expect(result).toEqual({ scalar: true, tile: { lines: [], polygons: [], starts: 1 } });
  });

  test("allows a failed initialization to be retried", () => {
    const result = runLoaders(
      [wasmPackage({ failOnce: true })],
      `
      const failures = await Promise.allSettled([
        decodeShortbreadBasemap(bytes, tile, first),
        loadMapsAggregationWasmRuntime(first),
      ]);
      const next = await decodeShortbreadBasemap(bytes, tile, first);
      console.log(JSON.stringify({
        failures: failures.map(result => result.status === "rejected" ? result.reason.message : null),
        next,
      }));
    `,
    );
    expect(result).toEqual({
      failures: ["initialization failed", "initialization failed"],
      next: { lines: [], polygons: [], starts: 2 },
    });
  });
});

// #305: the WebGPU-free core module serves Canvas2D Map Views and data-only consumers; the
// full renderer module (a superset) serves WebGPU Map Views without also fetching the core.
describe("Maps WASM capability modules", () => {
  const split = () => [wasmPackage({ name: "core" }), wasmPackage({ name: "renderer" })];

  test("core loaders fetch only the core module from a split configuration", () => {
    const result = runLoaders(
      split(),
      `
      configureMapsWasmPackage({ core: first, renderer: second });
      const [aggregation, tileResult, scalar] = await Promise.all([
        loadMapsAggregationWasmRuntime(),
        decodeShortbreadBasemap(bytes, tile),
        initializeMapsScalarFieldWasm(),
      ]);
      const module = await importMapsWasmModule("core");
      console.log(JSON.stringify({
        aggregation: typeof aggregation.createIndex,
        module: module.moduleName,
        scalar,
        starts: globalThis.mapsWasmStarts,
        tile: tileResult,
      }));
    `,
    );
    expect(result).toEqual({
      aggregation: "function",
      module: "core",
      scalar: true,
      starts: { core: 1 },
      tile: { lines: [], polygons: [], starts: 1 },
    });
  });

  test("a WebGPU page that prefers the renderer module fetches only that module", () => {
    const result = runLoaders(
      split(),
      `
      configureMapsWasmPackage({ core: first, renderer: second });
      preferMapsWasmRendererModule();
      const [, tileResult, renderer] = await Promise.all([
        loadMapsAggregationWasmRuntime(),
        decodeShortbreadBasemap(bytes, tile),
        importMapsWasmModule("renderer"),
      ]);
      console.log(JSON.stringify({
        renderer: renderer.moduleName,
        starts: globalThis.mapsWasmStarts,
        tile: tileResult,
      }));
    `,
    );
    expect(result).toEqual({
      renderer: "renderer",
      starts: { renderer: 1 },
      tile: { lines: [], polygons: [], starts: 1 },
    });
  });

  test("core loaders share a renderer module that is already loading", () => {
    const result = runLoaders(
      split(),
      `
      configureMapsWasmPackage({ core: first, renderer: second });
      const renderer = importMapsWasmModule("renderer");
      const core = await importMapsWasmModule("core");
      console.log(JSON.stringify({
        core: core.moduleName,
        same: core === (await renderer),
        starts: globalThis.mapsWasmStarts,
      }));
    `,
    );
    expect(result).toEqual({ core: "renderer", same: true, starts: { renderer: 1 } });
  });

  test("a single configured module still serves every loader", () => {
    const result = runLoaders(
      [wasmPackage({ name: "full" })],
      `
      configureMapsWasmPackage(first);
      const core = await importMapsWasmModule("core");
      const renderer = await importMapsWasmModule("renderer");
      console.log(JSON.stringify({
        modules: [core.moduleName, renderer.moduleName],
        starts: globalThis.mapsWasmStarts,
      }));
    `,
    );
    expect(result).toEqual({ modules: ["full", "full"], starts: { full: 1 } });
  });
});
