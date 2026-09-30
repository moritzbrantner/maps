// Full-page descriptive frame pacing; not a GPU completion/FPS or Moonlight verdict.
import { chromium } from "@playwright/test";
import { preview } from "vite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createShortbreadTileFixture } from "../e2e/fixtures/shortbread-tile.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    "site-dir": { type: "string", default: "dist" },
    output: { type: "string", default: "benchmark-results/engine-interaction.json" },
    revision: { type: "string" },
    samples: { type: "string", default: "5" },
  },
});
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 20)
  throw new Error("samples must be in 1..20");
const scenarioBytes = await readFile(
  new URL("../engine-scenarios/vector-city-style-v1.json", import.meta.url),
);
const scenario = JSON.parse(scenarioBytes);
const fixture = createShortbreadTileFixture({
  dense: true,
  streetRows: scenario.fixture.streetRows,
  pointsPerStreet: scenario.fixture.pointsPerStreet,
});
const siteDir = path.resolve(root, values["site-dir"]);
const wasm = await readFile(path.join(siteDir, "wasm/maps_wasm_bg.wasm"));
const engineHtml = await readFile(path.join(siteDir, "engine/index.html"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
let revision = git("rev-parse", "HEAD");
let dirty = git("status", "--porcelain", "--untracked-files=normal").length > 0;
if (values.revision) {
  const provenance = JSON.parse(
    await readFile(path.join(siteDir, "evidence/engine-benchmark.json")),
  );
  if (provenance.revision !== values.revision)
    throw new Error("Baseline artifact revision mismatch");
  revision = values.revision;
  dirty = false;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const server = await preview({
  configFile: false,
  root,
  base: "/maps/",
  build: { outDir: siteDir },
  preview: { host: "127.0.0.1", port: 0 },
});
let browser;
let evidence;
try {
  const args = ["--enable-unsafe-swiftshader", "--enable-unsafe-webgpu", "--use-gl=swiftshader"];
  browser = await chromium.launch({ args });
  const page = await browser.newPage({
    viewport: { width: scenario.viewport.width, height: scenario.viewport.height },
    deviceScaleFactor: scenario.viewport.devicePixelRatio,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0;
  await page.route("https://vector.openstreetmap.org/shortbread_v1/**", (route) => {
    requests++;
    return route.fulfill({ body: fixture, contentType: "application/vnd.mapbox-vector-tile" });
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/maps/engine/?e2e=1&vectorTiles=fixture`,
  );
  await page.locator("[data-map-runtime=maps]").waitFor();
  // One complete untimed journey warms decode, pixels and the camera path.
  // The quiet interval is part of the declared workload, not a verification retry.
  await page.waitForTimeout(1000);
  const results = [];
  for (let pass = -1; pass < samples; pass++) {
    await page.getByRole("button", { name: "Reset view" }).click();
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      const capture = { frames: [], longTasks: [], active: true, observer: null };
      window.__mapsInteractionCapture = capture;
      capture.observer = new PerformanceObserver((list) => {
        if (capture.active)
          capture.longTasks.push(...list.getEntries().map(({ duration }) => duration));
      });
      capture.observer.observe({ type: "longtask" });
      let previous;
      const frame = (now) => {
        if (!capture.active) return;
        if (previous !== undefined) capture.frames.push(now - previous);
        previous = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const bounds = await page.locator("[data-map-runtime=maps]").boundingBox();
    const x = bounds.x + bounds.width * 0.65,
      y = bounds.y + bounds.height * 0.5;
    for (const action of scenario.journey) {
      if (action.kind === "pan") {
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let step = 1; step <= action.steps; step++) {
          await page.mouse.move(x + (action.pixelsX * step) / action.steps, y);
          await page.waitForTimeout(action.intervalMs);
        }
        await page.mouse.up();
      } else if (action.kind === "wheel") {
        await page.mouse.wheel(0, action.deltaY);
        await page.waitForTimeout(250);
      }
    }
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => {
      const capture = window.__mapsInteractionCapture;
      capture.active = false;
      capture.longTasks.push(...capture.observer.takeRecords().map(({ duration }) => duration));
      capture.observer.disconnect();
      return { frames: capture.frames, longTasks: capture.longTasks };
    });
    if (!result.frames.length) throw new Error("No animation frames observed");
    if (pass >= 0) results.push(result);
  }
  const rendered = await page.evaluate(() => ({
    baseTiles: Number(
      document.querySelector("[data-flat-runtime=maps]")?.getAttribute("data-map-base-tiles"),
    ),
    overlayPrimitives: Number(
      document
        .querySelector("[data-map-overlay-runtime=maps]")
        ?.getAttribute("data-map-overlay-primitives"),
    ),
    tileError: document
      .querySelector("[data-map-base-tile-error]")
      ?.getAttribute("data-map-base-tile-error"),
    alert: document.querySelector("[role=alert]")?.textContent,
  }));
  if (
    rendered.tileError ||
    rendered.alert ||
    !(rendered.baseTiles > 0 || rendered.overlayPrimitives > 1000)
  ) {
    throw new Error(`Dense basemap did not render: ${JSON.stringify(rendered)}`);
  }
  if (!requests || errors.length)
    throw new Error(`Invalid interaction run: ${requests} tile requests; ${errors.join("; ")}`);
  const backend = await page
    .locator("[data-flat-runtime=maps]")
    .getAttribute("data-map-base-renderer");
  const overlayBackend = await page
    .locator("[data-map-overlay-runtime=maps]")
    .getAttribute("data-map-overlay-backend");
  const frames = results.flatMap((result) => result.frames).sort((a, b) => a - b);
  const longTasks = results.flatMap((result) => result.longTasks);
  const summary = {
    medianFrameMs: frames[Math.floor(frames.length * 0.5)],
    p95FrameMs: frames[Math.ceil(frames.length * 0.95) - 1],
    maxFrameMs: frames.at(-1),
    longTaskCount: longTasks.length,
    longTaskMs: longTasks.reduce((a, b) => a + b, 0),
  };
  evidence = {
    schemaVersion: 1,
    producer: "maps-engine-interaction",
    repository: "moritzbrantner/maps",
    revision: dirty ? null : revision,
    source: { revision, dirty, wasmSha256: hash(wasm), engineHtmlSha256: hash(engineHtml) },
    generatedAt: new Date().toISOString(),
    status: "measured",
    description:
      "Full standalone page with deterministic dense vector tiles and 1,000 points. requestAnimationFrame intervals include main-thread stalls; not GPU-completion FPS or performance acceptance.",
    workload: {
      scenario: scenario.id,
      scenarioSha256: hash(scenarioBytes),
      fixtureSha256: hash(fixture),
      fixture: scenario.fixture,
      viewport: scenario.viewport,
      journey: scenario.journey,
      warmups: 1,
      samples,
      resetSettleMs: 250,
      wheelSettleMs: 250,
      finalSettleMs: 250,
    },
    environment: {
      browser: browser.version(),
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      node: process.version,
      browserArgs: args,
      baseRenderer: backend,
      overlayRenderer: overlayBackend,
    },
    summary,
    rendered,
    results,
    metrics: [
      {
        id: "interaction-scope",
        label: "Full map interaction workload",
        value: `Dense vector tiles + 1,000 points; ${samples} warm pan/zoom journeys. Headless Chromium with software GPU flags. Frame intervals, not GPU FPS.`,
        state: "measured",
      },
      {
        id: "interaction-backend",
        label: "Interaction renderers",
        value: `Base: ${backend}; application: ${overlayBackend}`,
        state: "measured",
      },
      {
        id: "interaction-frame-median",
        label: "Full map pan/zoom · frame interval · median",
        value: summary.medianFrameMs,
        unit: "ms",
        state: "measured",
      },
      {
        id: "interaction-frame-p95",
        label: "Full map pan/zoom · frame interval · p95",
        value: summary.p95FrameMs,
        unit: "ms",
        state: "measured",
      },
      {
        id: "interaction-frame-max",
        label: "Full map pan/zoom · longest frame interval",
        value: summary.maxFrameMs,
        unit: "ms",
        state: "measured",
      },
      {
        id: "interaction-long-task-time",
        label: "Full map pan/zoom · time in long tasks",
        value: summary.longTaskMs,
        unit: "ms",
        state: "measured",
      },
      {
        id: "interaction-long-tasks",
        label: "Full map pan/zoom · long tasks (>50 ms)",
        value: summary.longTaskCount,
        state: "measured",
      },
    ],
    accomplishments: [],
  };
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
const output = path.resolve(root, values.output);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(`${output}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`);
await rename(`${output}.tmp`, output);
console.log(
  JSON.stringify({ output, summary: evidence.summary, environment: evidence.environment }, null, 2),
);
