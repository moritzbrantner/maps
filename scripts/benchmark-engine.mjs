// Descriptive CPU/bridge measurements of the canonical dense-points workload.
// This is not an FPS benchmark or a Moonlight performance acceptance verdict.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: { output: { type: "string", default: "benchmark-results/engine.json" } },
});
const scenarioBytes = await readFile(
  new URL("../engine-scenarios/dense-points-100k-v1.json", import.meta.url),
);
const scenario = JSON.parse(scenarioBytes);
const wasmBytes = await readFile(new URL("../public/wasm/maps_wasm_bg.wasm", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;
const server = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  // The fixture imports only the prepared WASM module; do not scan the showcase.
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
let evidence;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: scenario.viewport });
  await page.goto(`http://127.0.0.1:${address.port}/e2e/fixtures/engine-benchmark.html`);
  const results = await page.evaluate(async (scenario) => {
    const wasm = await import("/wasm/maps_wasm.js");
    await wasm.default();
    let seed = scenario.fixture.seed >>> 0;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const coordinates = new Float64Array(scenario.fixture.count * 2);
    for (let index = 0; index < coordinates.length; index += 2) {
      coordinates[index] = random() * 360 - 180;
      coordinates[index + 1] = random() * 160 - 80;
    }
    const runtime = new wasm.MapsFlatRasterRuntime({
      center: [0, 0],
      zoom: 2,
      width: scenario.viewport.width,
      height: scenario.viewport.height,
      source: { minZoom: 0, maxZoom: 19, tileSize: 256 },
    });
    const results = [];
    try {
      for (const [id, bearing, pitch] of [
        ["flat", 0, 0],
        ["oriented", 35, 40],
      ]) {
        const samples = [];
        let finiteCoordinates = 0;
        for (let pass = -3; pass < 15; pass++) {
          let duration = 0;
          finiteCoordinates = 0;
          for (const camera of scenario.journey) {
            runtime.setViewState(camera.longitude, camera.latitude, camera.zoom, bearing, pitch);
            const start = performance.now();
            const output = runtime.projectPacked(coordinates);
            duration += performance.now() - start;
            if (output.length !== coordinates.length) throw new Error("Projection length mismatch");
            for (let i = 0; i < output.length; i += 2) {
              if (Number.isFinite(output[i]) && Number.isFinite(output[i + 1])) finiteCoordinates++;
            }
          }
          if (pass >= 0) samples.push(duration / scenario.journey.length);
        }
        if (finiteCoordinates === 0) throw new Error("Projection produced no finite coordinates");
        const sorted = [...samples].sort((a, b) => a - b);
        results.push({
          id,
          bearing,
          pitch,
          samples,
          finiteCoordinates,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        });
      }
    } finally {
      runtime.free();
    }
    return results;
  }, scenario);
  evidence = {
    schemaVersion: 1,
    producer: "maps-engine-benchmark",
    repository: "moritzbrantner/maps",
    revision: dirty ? null : revision,
    source: { revision, dirty, wasmSha256: createHash("sha256").update(wasmBytes).digest("hex") },
    generatedAt: new Date().toISOString(),
    status: "measured",
    description:
      "Descriptive WASM projection CPU + bridge timings, not FPS or performance acceptance. Lower is better. No GPU drawing, tile network, or cold startup is measured.",
    workload: {
      scenario: scenario.id,
      scenarioSha256: createHash("sha256").update(scenarioBytes).digest("hex"),
      phase: "render-frame projection",
      points: scenario.fixture.count,
      viewport: scenario.viewport,
      journey: scenario.journey,
      generator: "LCG 1664525/1013904223; uniform longitude [-180,180), latitude [-80,80)",
      seed: scenario.fixture.seed,
      warmups: 3,
      samples: 15,
      sampleUnit: "mean milliseconds per 100k-point batch across the five-camera journey",
    },
    environment: {
      browser: browser.version(),
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      node: process.version,
    },
    metrics: [
      {
        id: "projection-scope",
        label: "Engine benchmark scope",
        value:
          "CPU + WASM bridge only; 15 journey means after 3 warmups. Not FPS or a performance acceptance verdict.",
        state: "measured",
      },
      {
        id: "projection-environment",
        label: "Engine benchmark environment",
        value: `Chromium ${browser.version()} · ${os.platform()} ${os.arch()} · ${os.cpus()[0]?.model ?? "unknown CPU"}`,
        state: "measured",
      },
      ...results.flatMap((result) => [
        {
          id: `projection-${result.id}-median`,
          label: `Rust/WASM ${result.id} projection · 100k points · median`,
          value: result.medianMs,
          unit: "ms",
          state: "measured",
        },
        {
          id: `projection-${result.id}-p95`,
          label: `Rust/WASM ${result.id} projection · 100k points · p95`,
          value: result.p95Ms,
          unit: "ms",
          state: "measured",
        },
      ]),
    ],
    results,
    accomplishments: [],
  };
} finally {
  await browser?.close();
  await server.close();
}
const output = path.resolve(root, values.output);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(`${output}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`);
await rename(`${output}.tmp`, output);
console.log(JSON.stringify({ output, metrics: evidence.metrics }, null, 2));
