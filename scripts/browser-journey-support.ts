// Shared Maps-side support for runtime-profiler browser journeys over a fixture page:
// a production build of the fixture served with the built WASM package, in-page frame and
// long-task timing, JS heap after forced GC, and distribution summaries. runtime-profiler still
// owns Chromium launch, tracing, normalization and the immutable bundle.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteEntry = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const BUILD_TIMEOUT_MS = 180_000;

export type Summary = {
  count: number;
  max: number | null;
  p50: number | null;
  p95: number | null;
};

export type LongTaskSummary = { count: number; maxMs: number; totalMs: number };

declare global {
  interface Window {
    mapsJourneyTiming?: {
      frames: number[];
      inputEvents: { duration: number; name: string }[];
      longTasks: { duration: number; startTime: number }[];
      reset(): void;
    };
  }
}

/** A production build of a fixture page (repository-relative), served with the built WASM. */
export function buildFixtureSite(tempRoot: string, outDir: string, fixture: string) {
  const config = path.join(tempRoot, "vite.journey.config.mjs");
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
    rollupOptions: { input: { journey: ${JSON.stringify(path.join(rootDir, fixture))} } },
  },
};
`,
  );
  const result = spawnSync("bun", [viteEntry, "build", "--config", config], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `journey build failed\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  // The measured package is the built dist/wasm artifact, never a stale public/ copy.
  mkdirSync(path.join(outDir, "wasm"), { recursive: true });
  for (const file of ["maps_wasm.js", "maps_wasm_bg.wasm"]) {
    copyFileSync(path.join(rootDir, "dist", "wasm", file), path.join(outDir, "wasm", file));
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

export function serveStatic(directory: string) {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
    const file = path.join(directory, pathname);
    if (!file.startsWith(directory)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

export type HeapSample = { jsHeapUsedBytes: number | null; label: string };

/** JS heap used after a forced GC, through the Chromium DevTools protocol. */
export async function createHeapSampler(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return async (label: string): Promise<HeapSample> => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    const used = metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
    return { label, jsHeapUsedBytes: typeof used === "number" ? used : null };
  };
}

/**
 * rAF intervals, long tasks and slow input events, in-page from navigation on. Install with
 * `page.addInitScript(installJourneyTiming)` so page load is attributed too.
 *
 * Input events come from the Event Timing API: each reported duration runs from the input's
 * timestamp to the next paint after its handlers. Chromium reports only events of at least
 * 16 ms, so the count is of slow inputs, not of all inputs.
 */
export function installJourneyTiming() {
  const timing = {
    frames: [] as number[],
    inputEvents: [] as { duration: number; name: string }[],
    longTasks: [] as { duration: number; startTime: number }[],
    reset() {
      timing.frames = [];
      timing.inputEvents = [];
      timing.longTasks = [];
    },
  };
  window.mapsJourneyTiming = timing;
  let previous: number | null = null;
  const tick = (now: number) => {
    if (previous !== null) timing.frames.push(now - previous);
    previous = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        timing.longTasks.push({ duration: entry.duration, startTime: entry.startTime });
      }
    }).observe({ buffered: true, type: "longtask" });
  } catch {
    // Long-task timing is unavailable; the profiler trace still records them.
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        timing.inputEvents.push({ duration: entry.duration, name: entry.name });
      }
    }).observe({ durationThreshold: 16, type: "event" } as PerformanceObserverInit);
  } catch {
    // Event Timing is unavailable; the journey's slow-input summary stays empty.
  }
}

/** Reads and summarizes the frames, long tasks and slow inputs since the last reset. */
export async function readJourneyTiming(page: Page) {
  const timing = await page.evaluate(() => ({
    frames: window.mapsJourneyTiming!.frames,
    inputEvents: window.mapsJourneyTiming!.inputEvents.map((event) => event.duration),
    longTasks: window.mapsJourneyTiming!.longTasks.map((task) => task.duration),
  }));
  return {
    frameIntervalsMs: summarize(timing.frames),
    longTasks: summarizeLongTasks(timing.longTasks),
    slowInputEventsMs: summarize(timing.inputEvents),
  };
}

export function resetJourneyTiming(page: Page) {
  return page.evaluate(() => window.mapsJourneyTiming!.reset());
}

export function summarizeLongTasks(durations: number[]): LongTaskSummary {
  return {
    count: durations.length,
    maxMs: Math.max(0, ...durations),
    totalMs: durations.reduce((sum, value) => sum + value, 0),
  };
}

export function summarize(values: number[]): Summary {
  if (values.length === 0) return { count: 0, max: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { count: sorted.length, max: sorted.at(-1)!, p50: at(0.5), p95: at(0.95) };
}
