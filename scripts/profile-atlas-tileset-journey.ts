#!/usr/bin/env node
// runtime-profiler journey for `maps-atlas-tileset-v1` (#270 Fast).
//
// One journey over the content-pinned Liechtenstein Atlas archives: cold load → pan/zoom
// → warm revisit → source A/B/A. MAPS_RUNTIME_PROFILE_IMPLEMENTATION selects who draws
// it: `candidate` is the first-party Map View, `reference` is MapLibre GL + pmtiles.
// Both read the same archive bytes from the same range-serving origin, at the same
// viewport and camera steps. Maps owns the journey and its observation; runtime-profiler
// owns Chromium, tracing, process samples and the immutable bundle.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteEntry = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const FIXTURE = "e2e/fixtures/atlas-tileset-journey.html";
const BUILD_TIMEOUT_MS = 240_000;
const STAGE_TIMEOUT_MS = 30_000;
const IMPLEMENTATIONS = new Set(["candidate", "reference"]);

export const ATLAS_TILESET_SCENARIO_ID = "maps-atlas-tileset-v1";
export const ATLAS_TILESET_VIEWPORT = { width: 1280, height: 720 };
export const ATLAS_TILESET_ARCHIVES = {
  liechtenstein:
    "liechtenstein-a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4.pmtiles",
  "liechtenstein-north":
    "liechtenstein-north-286216eaf8884d4ccf4a1b9e9fdc5e0f2fe14291ca9585e9416011baaf4dee92.pmtiles",
} as const;

type Step =
  | { kind: "camera"; center: [number, number]; zoom: number }
  | { kind: "source"; region: keyof typeof ATLAS_TILESET_ARCHIVES };

/**
 * The journey after the cold load. The archives are sparse inside their declared bounds
 * and the first-party transport fails closed on a missing tile, so every camera is
 * chosen with all of its visible and neighbouring tiles present in the archive it reads.
 */
export const ATLAS_TILESET_STEPS: ReadonlyArray<{ id: string; step: Step }> = [
  { id: "pan-north", step: { kind: "camera", center: [9.53, 47.2], zoom: 12 } },
  { id: "zoom-13", step: { kind: "camera", center: [9.55, 47.12], zoom: 13 } },
  { id: "zoom-14", step: { kind: "camera", center: [9.5444, 47.1673], zoom: 14 } },
  { id: "zoom-11", step: { kind: "camera", center: [9.53, 47.16], zoom: 11 } },
  { id: "warm-revisit", step: { kind: "camera", center: [9.53, 47.14], zoom: 12 } },
  // Inside both the full and the northern archive, so only the source changes below.
  { id: "pan-shared", step: { kind: "camera", center: [9.53, 47.24], zoom: 12 } },
  { id: "source-b", step: { kind: "source", region: "liechtenstein-north" } },
  { id: "source-a", step: { kind: "source", region: "liechtenstein" } },
];

declare global {
  interface Window {
    /** The handle installed by e2e/fixtures/atlas-tileset-journey.ts. */
    mapsAtlasJourney?: Promise<{
      firstUsefulMapMs: number;
      implementation: string;
      observe(): Record<string, unknown>;
      run(step: Step): Promise<number>;
    }>;
  }
}

type ArchiveResponse = { archive: string; bytes: number; range: string; status: number };

export type AtlasTilesetObservation = {
  schemaVersion: "maps.atlas-tileset-journey-observation/v1";
  scenarioId: typeof ATLAS_TILESET_SCENARIO_ID;
  role: string;
  implementation: string;
  viewport: typeof ATLAS_TILESET_VIEWPORT;
  firstUsefulMapMs: number;
  steps: Array<{
    id: string;
    durationMs: number;
    archiveRequests: number;
    archiveBytes: number;
    state: Record<string, unknown>;
  }>;
  archiveRequests: number;
  archiveBytes: number;
};

export async function run({ page }: { page: Page }): Promise<AtlasTilesetObservation> {
  const role = process.env.MAPS_RUNTIME_PROFILE_IMPLEMENTATION;
  if (!role || !IMPLEMENTATIONS.has(role)) {
    throw new Error(
      "MAPS_RUNTIME_PROFILE_IMPLEMENTATION must be either 'reference' or 'candidate'",
    );
  }
  const site = process.env.MAPS_ATLAS_TILESET_SITE;
  if (!site) {
    throw new Error("MAPS_ATLAS_TILESET_SITE must name a site built by buildAtlasTilesetSite");
  }
  const server = await serveSite(path.resolve(rootDir, site));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("static server has no port");
    const observation = await journey(page, `http://127.0.0.1:${address.port}`, role);
    const output = process.env.MAPS_ATLAS_TILESET_OBSERVATIONS;
    if (output) appendFileSync(output, `${JSON.stringify(observation)}\n`);
    return observation;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function journey(page: Page, origin: string, role: string) {
  const responses: ArchiveResponse[] = [];
  page.on("response", (response) => {
    const archive = path.posix.basename(new URL(response.url()).pathname);
    if (!archive.endsWith(".pmtiles")) return;
    responses.push({
      archive,
      bytes: Number(response.headers()["content-length"] ?? Number.NaN),
      range: response.request().headers()["range"] ?? "",
      status: response.status(),
    });
  });
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(String(error)));

  await page.setViewportSize(ATLAS_TILESET_VIEWPORT);
  await page.goto(`${origin}/${FIXTURE}?implementation=${role}`, { timeout: STAGE_TIMEOUT_MS });
  const stage = async <T>(label: string, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${role} ${label} did not settle within ${STAGE_TIMEOUT_MS}ms ${failures.join("; ")}`,
                ),
              ),
            STAGE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const cold = await stage(
    "cold load",
    page.evaluate(async () => {
      const handle = await window.mapsAtlasJourney!;
      return {
        firstUsefulMapMs: handle.firstUsefulMapMs,
        implementation: handle.implementation,
        state: handle.observe(),
      };
    }),
  );

  let seen = 0;
  const drain = () => {
    const fresh = responses.slice(seen);
    seen = responses.length;
    return {
      archiveRequests: fresh.length,
      archiveBytes: fresh.reduce((sum, response) => sum + response.bytes, 0),
    };
  };
  const steps: AtlasTilesetObservation["steps"] = [
    { id: "cold", durationMs: cold.firstUsefulMapMs, ...drain(), state: cold.state },
  ];
  for (const { id, step } of ATLAS_TILESET_STEPS) {
    const result = await stage(
      id,
      page.evaluate(async (next) => {
        const handle = await window.mapsAtlasJourney!;
        const durationMs = await handle.run(next);
        return { durationMs, state: handle.observe() };
      }, step),
    );
    steps.push({ id, durationMs: result.durationMs, ...drain(), state: result.state });
  }

  if (failures.length > 0) throw new Error(`${role} journey raised: ${failures.join("; ")}`);
  // Both runtimes must read the archives through ranges: a whole-archive download or a
  // response without a length would make the transfer evidence meaningless.
  const invalid = responses.filter(
    (response) =>
      response.status !== 206 ||
      !response.range.startsWith("bytes=") ||
      !Number.isFinite(response.bytes) ||
      !Object.values<string>(ATLAS_TILESET_ARCHIVES).includes(response.archive),
  );
  if (responses.length === 0 || invalid.length > 0) {
    throw new Error(
      `${role} journey did not read the pinned archives through HTTP ranges: ${JSON.stringify(invalid)}`,
    );
  }
  return {
    schemaVersion: "maps.atlas-tileset-journey-observation/v1",
    scenarioId: ATLAS_TILESET_SCENARIO_ID,
    role,
    implementation: cold.implementation,
    viewport: ATLAS_TILESET_VIEWPORT,
    firstUsefulMapMs: cold.firstUsefulMapMs,
    steps,
    archiveRequests: responses.length,
    archiveBytes: responses.reduce((sum, response) => sum + response.bytes, 0),
  } satisfies AtlasTilesetObservation;
}

/**
 * A production build of the journey fixture, with the built `dist/wasm` package and the
 * content-pinned archives. Returns each archive's verified SHA-256.
 */
export function buildAtlasTilesetSite(outDir: string) {
  // The producer handoff verifies size and digest before the build copies the bytes.
  command("bun", [path.join(rootDir, "scripts", "fetch-atlas-tiles.ts")], "Atlas archive fetch");
  mkdirSync(outDir, { recursive: true });
  const config = path.join(outDir, "..", `${path.basename(outDir)}.vite.config.mjs`);
  writeFileSync(
    config,
    `import base from ${JSON.stringify(path.join(rootDir, "vite.config.ts"))};
export default {
  ...base,
  configFile: false,
  root: ${JSON.stringify(rootDir)},
  logLevel: "warn",
  build: {
    ...base.build,
    emptyOutDir: true,
    outDir: ${JSON.stringify(outDir)},
    rollupOptions: { input: { journey: ${JSON.stringify(path.join(rootDir, FIXTURE))} } },
  },
};
`,
  );
  command("bun", [viteEntry, "build", "--config", config], "journey fixture build");
  // The measured package is the built dist/wasm artifact, never a stale public/ copy.
  mkdirSync(path.join(outDir, "wasm"), { recursive: true });
  for (const file of ["maps_wasm.js", "maps_wasm_bg.wasm"]) {
    copyFileSync(path.join(rootDir, "dist", "wasm", file), path.join(outDir, "wasm", file));
  }
  const archives: Record<string, { file: string; sha256: string; bytes: number }> = {};
  for (const [region, file] of Object.entries(ATLAS_TILESET_ARCHIVES)) {
    const bytes = readFileSync(path.join(outDir, "tilesets", file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!file.includes(sha256)) {
      throw new Error(`${file} does not contain its content digest ${sha256}`);
    }
    archives[region] = { file, sha256, bytes: bytes.byteLength };
  }
  return archives;
}

function command(program: string, args: string[], label: string) {
  const result = spawnSync(program, args, {
    cwd: rootDir,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".pmtiles": "application/octet-stream",
  ".wasm": "application/wasm",
};

/** Static files with single-range support: PMTiles readers need HTTP 206. */
function serveSite(directory: string) {
  if (!readdirSync(directory).includes("tilesets")) {
    throw new Error(`${directory} is not a built Atlas journey site`);
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
    const file = path.join(directory, pathname);
    let size: number;
    try {
      if (!file.startsWith(directory + path.sep)) throw new Error("outside site");
      const stats = statSync(file);
      if (!stats.isFile()) throw new Error("not a file");
      size = stats.size;
    } catch {
      response.writeHead(404).end();
      return;
    }
    const headers: Record<string, string | number> = {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (!range) {
      response.writeHead(200, { ...headers, "content-length": size });
      createReadStream(file).pipe(response);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start > end) {
      response.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
    });
    createReadStream(file, { start, end }).pipe(response);
  });
  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
