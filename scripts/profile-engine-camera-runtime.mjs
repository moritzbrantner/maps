#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const IMPLEMENTATIONS = new Set(["candidate", "reference"]);
const PROFILE_ITERATIONS = 12;
const VITE_BUILD_TIMEOUT_MS = 15_000;
const BROWSER_STAGE_TIMEOUT_MS = 10_000;
const PREVIEW_REQUEST_TIMEOUT_MS = 1_000;
const PREVIEW_SHUTDOWN_TIMEOUT_MS = 2_000;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const implementation = process.env.MAPS_RUNTIME_PROFILE_IMPLEMENTATION;

if (!IMPLEMENTATIONS.has(implementation)) {
  throw new Error(
    "MAPS_RUNTIME_PROFILE_IMPLEMENTATION must be either 'reference' or 'candidate'",
  );
}

const mapLibrePackage = JSON.parse(
  readFileSync(path.join(rootDir, "node_modules", "maplibre-gl", "package.json"), "utf8"),
);
const referenceVersion = mapLibrePackage.version;
const viteEntry = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const scenario = JSON.parse(
  readFileSync(path.join(rootDir, "engine-scenarios", "camera-world-pan-v1.json"), "utf8"),
);
const referenceAdapter = readFileSync(
  path.join(rootDir, "scripts", "engine-reference", "maplibre-camera.mjs"),
  "utf8",
);
const wasmEntry = path.join(rootDir, "dist", "wasm", "maps_wasm.js");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "maps-runtime-profile-"));
const previewPort = await reservePort();
let preview;

try {
  readFileSync(viteEntry);
  readFileSync(wasmEntry);
  if (typeof referenceVersion !== "string" || referenceVersion.length === 0) {
    throw new Error("root MapLibre install does not expose a resolved version");
  }

  mkdirSync(path.join(tempRoot, "src"), { recursive: true });
  mkdirSync(path.join(tempRoot, "node_modules", "@moritzbrantner"), { recursive: true });
  linkDirectory(rootDir, path.join(tempRoot, "node_modules", "@moritzbrantner", "maps"));
  linkDirectory(
    path.join(rootDir, "node_modules", "maplibre-gl"),
    path.join(tempRoot, "node_modules", "maplibre-gl"),
  );

  writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
  );
  writeFileSync(
    path.join(tempRoot, "index.html"),
    '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>',
  );
  writeFileSync(path.join(tempRoot, "src", "maplibre-camera-reference.js"), referenceAdapter);
  writeFileSync(
    path.join(tempRoot, "src", "main.js"),
    implementation === "candidate" ? candidateEntry() : referenceEntry(),
  );

  run("bun", [viteEntry, "build"], tempRoot, VITE_BUILD_TIMEOUT_MS);

  preview = spawn(
    "bun",
    [
      viteEntry,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    {
      cwd: tempRoot,
      stdio: "ignore",
    },
  );
  await waitForHttp(`http://127.0.0.1:${previewPort}/`);

  const browser = await chromium.launch({ timeout: BROWSER_STAGE_TIMEOUT_MS });
  try {
    const page = await withTimeout(
      browser.newPage(),
      BROWSER_STAGE_TIMEOUT_MS,
      `${implementation} Chromium page creation`,
    );
    await page.goto(`http://127.0.0.1:${previewPort}/`, {
      timeout: BROWSER_STAGE_TIMEOUT_MS,
      waitUntil: "load",
    });
    const result = await withTimeout(
      page.evaluate(() => window.mapsRuntimeProfile),
      BROWSER_STAGE_TIMEOUT_MS,
      `${implementation} browser profile evaluation`,
    );

    if (result.scenarioId !== scenario.id) {
      throw new Error(`unexpected scenario ${result.scenarioId}`);
    }
    if (result.iterations !== PROFILE_ITERATIONS) {
      throw new Error(`unexpected runtime iteration count ${result.iterations}`);
    }
    if (result.stateCount !== PROFILE_ITERATIONS * (scenario.operations.length + 1)) {
      throw new Error(
        `expected ${PROFILE_ITERATIONS * (scenario.operations.length + 1)} observed states, received ${result.stateCount}`,
      );
    }
    if (!(result.durationMs >= 0) || !Number.isFinite(result.durationMs)) {
      throw new Error("runtime profile did not produce a finite browser duration");
    }

    process.stdout.write(
      `${JSON.stringify({
        implementation: result.implementation,
        scenarioId: result.scenarioId,
        iterations: result.iterations,
        stateCount: result.stateCount,
        browserDurationMs: result.durationMs,
      })}\n`,
    );
  } finally {
    await withTimeout(browser.close(), BROWSER_STAGE_TIMEOUT_MS, "Chromium shutdown");
  }
} finally {
  await stopPreview(preview);
  rmSync(tempRoot, { force: true, recursive: true });
}

function candidateEntry() {
  return String.raw`import init, { executeEngineScenario } from "@moritzbrantner/maps/wasm";

const scenario = ${JSON.stringify(scenario)};
const iterations = ${PROFILE_ITERATIONS};

window.mapsRuntimeProfile = (async () => {
  await init();
  const started = performance.now();
  let stateCount = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const observation = executeEngineScenario(JSON.stringify(scenario));
    if (observation.scenarioId !== scenario.id) {
      throw new Error("candidate scenario identity drifted");
    }
    stateCount += observation.states.length;
  }

  return {
    durationMs: performance.now() - started,
    implementation: "maps-wasm",
    iterations,
    scenarioId: scenario.id,
    stateCount,
  };
})();
`;
}

function referenceEntry() {
  return String.raw`import { executeMapLibreCameraScenario } from "./maplibre-camera-reference.js";

const scenario = ${JSON.stringify(scenario)};
const iterations = ${PROFILE_ITERATIONS};
const referenceVersion = ${JSON.stringify(referenceVersion)};

window.mapsRuntimeProfile = (async () => {
  const started = performance.now();
  let stateCount = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const observation = await executeMapLibreCameraScenario(scenario, referenceVersion);
    if (observation.scenarioId !== scenario.id) {
      throw new Error("reference scenario identity drifted");
    }
    stateCount += observation.states.length;
  }

  return {
    durationMs: performance.now() - started,
    implementation: "maplibre-gl@" + referenceVersion,
    iterations,
    scenarioId: scenario.id,
    stateCount,
  };
})();
`;
}

function linkDirectory(target, linkPath) {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function run(command, args, cwd, timeout) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });

  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed before completion: ${result.error.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

async function waitForHttp(url) {
  const deadline = Date.now() + BROWSER_STAGE_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    if (preview?.exitCode !== null) {
      throw new Error(`Vite preview exited before runtime evidence was served (code ${preview.exitCode})`);
    }

    const remainingMs = deadline - Date.now();
    const controller = new AbortController();
    const requestTimeout = setTimeout(
      () => controller.abort(),
      Math.min(PREVIEW_REQUEST_TIMEOUT_MS, Math.max(1, remainingMs)),
    );

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(requestTimeout);
    }

    const delayMs = Math.min(50, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await delay(delayMs);
  }

  throw new Error(
    `runtime profile preview did not become ready within ${BROWSER_STAGE_TIMEOUT_MS}ms: ${String(lastError ?? "timeout")}`,
  );
}

async function stopPreview(child) {
  if (!child || child.exitCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(PREVIEW_SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (stopped || child.exitCode !== null) return;

  child.kill("SIGKILL");
  const killed = await Promise.race([
    exited.then(() => true),
    delay(PREVIEW_SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (!killed && child.exitCode === null) {
    throw new Error("Vite preview did not terminate after SIGKILL");
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reservePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a runtime profile port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
