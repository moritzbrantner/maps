// `maps-atlas-tileset-v1` (#270 Fast): MapLibre GL + pmtiles (reference) and the
// first-party Map View (candidate) run one journey over the same content-pinned
// Liechtenstein archives, at the same viewport, on this machine, in this one process.
//
// runtime-profiler captures immutable bundles and decides comparability. Moonlight
// evaluates each interleaved round with the camera foundation policy (≥ 5 samples,
// complete candidate execution, runtime score ≥ 75): a viability guard, not a claim that
// Maps is faster. Absolute timings are advisory. Anything missing or incomparable is
// inconclusive. The command exits 0 only for `passed`, after writing the evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  combineAtlasOutcome,
  sameAtlasWorkload,
  summarizeAtlasJourneys,
  type AtlasJourneySample,
  type AtlasRound,
} from "./atlas-tileset-evaluation.ts";
import {
  ATLAS_TILESET_SCENARIO_ID,
  ATLAS_TILESET_STEPS,
  ATLAS_TILESET_VIEWPORT,
  buildAtlasTilesetSite,
} from "./profile-atlas-tileset-journey.ts";

const MINIMUM_SCORE = 75;
const MINIMUM_SAMPLES = 5;
const ROLES = ["reference", "candidate"] as const;
type Role = (typeof ROLES)[number];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { report: { type: "string" }, rounds: { type: "string", default: "2" } },
});
const roundCount = Number(values.rounds);
assert(Number.isInteger(roundCount) && roundCount >= 1, "--rounds must be a positive integer");
const output = path.resolve(
  root,
  process.env.MAPS_ATLAS_TILESET_EVIDENCE_DIR ?? `.runtime-profiler/${ATLAS_TILESET_SCENARIO_ID}`,
);
const profiler = process.env.RUNTIME_PROFILER_BIN ?? "runtime-profiler";
const moonlight = process.env.MOONLIGHT_RUNTIME_PROFILE_BIN ?? "moonlight-runtime-profile";
const scenarios = {
  process: path.join(root, "runtime-profiler-scenarios/atlas-tileset-v1.yaml"),
  browser: path.join(root, "runtime-profiler-scenarios/atlas-tileset-browser-v1.yaml"),
};
assert(!existsSync(output), `Atlas tileset evidence already exists and is immutable: ${output}`);
mkdirSync(output, { recursive: true });

const temporary = mkdtempSync(path.join(os.tmpdir(), "maps-atlas-tileset-"));
try {
  const site = path.join(temporary, "site");
  const archives = buildAtlasTilesetSite(site);
  const capture = (kind: keyof typeof scenarios, role: Role, bundle: string) => {
    const observations = `${bundle}.observations.jsonl`;
    invoke(profiler, ["capture", "--scenario", scenarios[kind], "--output", bundle], {
      MAPS_ATLAS_TILESET_OBSERVATIONS: observations,
      MAPS_ATLAS_TILESET_SITE: site,
      MAPS_RUNTIME_PROFILE_IMPLEMENTATION: role,
    });
    invoke(profiler, ["validate", "--bundle", bundle]);
    return readFileSync(observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AtlasJourneySample);
  };

  // Browser traces: one journey each, strictly compared by runtime-profiler.
  const browser = Object.fromEntries(
    ROLES.map((role) => {
      const bundle = path.join(output, "browser", role);
      mkdirSync(path.dirname(bundle), { recursive: true });
      const [observation] = capture("browser", role, bundle);
      const summary = json(path.join(bundle, "chromium-trace-summary.json"));
      assert(summary.top_level_task_count > 0, `${role} journey produced no renderer-main tasks`);
      return [
        role,
        {
          observation,
          runtime: json(path.join(bundle, "browser-runtime.json")),
          trace: {
            topLevelTasks: summary.top_level_task_count,
            topLevelDurationUs: summary.top_level_duration_us,
            longTasks: summary.long_task_count,
            longTaskTotalDurationUs: summary.long_task_total_duration_us,
            longestTaskUs: summary.longest_task_us,
          },
        },
      ];
    }),
  ) as Record<Role, { observation: AtlasJourneySample; runtime: unknown; trace: unknown }>;
  const comparability = invoke(profiler, [
    "compare-browser",
    "--reference",
    path.join(output, "browser", "reference"),
    "--candidate",
    path.join(output, "browser", "candidate"),
    "--json",
  ]);
  writeFileSync(path.join(output, "browser", "comparability.json"), comparability);
  const browserComparability = JSON.parse(comparability) as { status: string; reasons: string[] };

  // Process samples: interleaved rounds in alternating order, each evaluated by Moonlight.
  const journeys: Record<Role, AtlasJourneySample[]> = { reference: [], candidate: [] };
  const processSamples: Record<Role, Array<{ round: number; durationMs: number; maxRssKib: number }>> =
    { reference: [], candidate: [] };
  const rounds: Array<AtlasRound & { round: number; evaluation: string; score: string | null }> = [];
  let environmentFingerprint: string | null = null;
  for (let index = 0; index < roundCount; index += 1) {
    const directory = path.join(output, "process", `round-${index + 1}`);
    mkdirSync(directory, { recursive: true });
    const order = index % 2 === 0 ? ROLES : ([...ROLES].reverse() as Role[]);
    for (const role of order) {
      const bundle = path.join(directory, role);
      const observed = capture("process", role, bundle);
      const metrics = json(path.join(bundle, "metrics.json"));
      assert.equal(metrics.samples.length, MINIMUM_SAMPLES, `${role} capture lost process samples`);
      // The warmup journey is observed too; only the measured ones are evidence.
      assert.equal(observed.length, MINIMUM_SAMPLES + 1, `${role} journeys were not all observed`);
      journeys[role].push(...observed.slice(1));
      for (const sample of metrics.samples) {
        processSamples[role].push({
          round: index + 1,
          durationMs: sample.duration_ms,
          maxRssKib: sample.max_rss_kib,
        });
      }
      environmentFingerprint = json(path.join(bundle, "manifest.json")).environment_fingerprint;
    }
    const pair = [
      "--reference",
      path.join(directory, "reference"),
      "--candidate",
      path.join(directory, "candidate"),
    ];
    const score = invoke(profiler, ["score", ...pair, "--json"], {}, true);
    if (score.status === 0) writeFileSync(path.join(directory, "runtime-score.json"), score.stdout);
    const evaluation = invoke(
      moonlight,
      [
        "--runtime-profiler",
        profiler,
        ...pair,
        "--reference-uri",
        `artifact://maps/${ATLAS_TILESET_SCENARIO_ID}/round-${index + 1}/reference`,
        "--candidate-uri",
        `artifact://maps/${ATLAS_TILESET_SCENARIO_ID}/round-${index + 1}/candidate`,
        "--minimum-score",
        String(MINIMUM_SCORE),
        "--minimum-samples",
        String(MINIMUM_SAMPLES),
      ],
      {},
      true,
    );
    writeFileSync(path.join(directory, "moonlight-evaluation.json"), evaluation.stdout);
    let result: { outcome?: unknown; summary?: unknown; metrics?: { runtimeScore?: unknown } } = {};
    try {
      result = JSON.parse(evaluation.stdout);
    } catch {
      // No parseable evaluation is no verdict.
    }
    rounds.push({
      round: index + 1,
      order,
      moonlightOutcome: typeof result.outcome === "string" ? result.outcome : "unavailable",
      moonlightSummary:
        typeof result.summary === "string"
          ? result.summary
          : `Moonlight produced no evaluation (exit ${evaluation.status}): ${evaluation.stderr.trim()}`,
      runtimeScore:
        typeof result.metrics?.runtimeScore === "number" ? result.metrics.runtimeScore : null,
      evaluation: path.relative(output, path.join(directory, "moonlight-evaluation.json")),
      score: score.status === 0 ? path.relative(output, path.join(directory, "runtime-score.json")) : null,
    });
  }

  const sameWorkload =
    sameAtlasWorkload(journeys.reference, journeys.candidate) &&
    sameAtlasWorkload([browser.reference.observation], [browser.candidate.observation]);
  const { outcome, reasons } = combineAtlasOutcome({
    browserComparability: browserComparability.status,
    rounds,
    sameWorkload,
  });

  const revision = invoke("git", ["rev-parse", "HEAD"]).trim();
  const dirty = invoke("git", ["status", "--porcelain", "--untracked-files=no"]).trim().length > 0;
  const version = (name: string) =>
    json(path.join(root, "node_modules", name, "package.json")).version as string;
  const summary = {
    reference: summarizeAtlasJourneys(journeys.reference),
    candidate: summarizeAtlasJourneys(journeys.candidate),
  };
  const lastCandidate = journeys.candidate.at(-1)?.steps.at(-1)?.state ?? {};
  const backend = typeof lastCandidate.backend === "string" ? lastCandidate.backend : null;
  const evaluation = {
    schemaVersion: "maps.atlas-tileset-evaluation/v1",
    scenarioId: ATLAS_TILESET_SCENARIO_ID,
    outcome,
    reasons,
    policy: {
      owner: "moonlight",
      minimumScore: MINIMUM_SCORE,
      minimumSamples: MINIMUM_SAMPLES,
      meaning:
        "Viability guard on runtime-profiler's reference-relative process score. Not a claim that Maps is faster than MapLibre; absolute timings on this machine are advisory.",
    },
    source: { revision, dirty },
    implementations: {
      reference: `maplibre-gl@${version("maplibre-gl")} + pmtiles@${version("pmtiles")}`,
      candidate: `@moritzbrantner/maps first-party Map View (${backend ?? "unknown backend"})`,
    },
    workload: {
      viewport: ATLAS_TILESET_VIEWPORT,
      steps: ["cold", ...ATLAS_TILESET_STEPS.map((step) => step.id)],
      archives,
      wasmSha256: sha256(path.join(root, "dist", "wasm", "maps_wasm_bg.wasm")),
      sameWorkload,
    },
    environment: {
      fingerprint: environmentFingerprint,
      browser: browser.candidate.runtime,
    },
    browser: {
      comparability: browserComparability.status,
      comparabilityReasons: browserComparability.reasons,
      reference: browser.reference,
      candidate: browser.candidate,
    },
    rounds,
    summary,
    memory: {
      processRssKib: {
        scope:
          "VmRSS of the journey driver process sampled by runtime-profiler's process collector. It does not include Chromium's processes.",
        reference: processSamples.reference.map((sample) => sample.maxRssKib),
        candidate: processSamples.candidate.map((sample) => sample.maxRssKib),
      },
      candidateRetained: {
        scope: "First-party Map View retained tile resources after the last journey step.",
        tiles: lastCandidate.retainedTiles ?? null,
        rgbaAndMvtBytesLowerBound: lastCandidate.retainedRgbaAndMvtBytesLowerBound ?? null,
        gpuBufferBytes:
          backend === "wgpu"
            ? (lastCandidate.retainedGpuBufferBytes ?? null)
            : {
                status: "unavailable",
                reason: `the pinned collector's Chromium ran the ${backend ?? "unknown"} backend, which retains no GPU buffers`,
              },
      },
      browserHeap: { status: "unavailable", reason: "browser memory attribution is #76" },
      gpuMemory: { status: "unavailable", reason: "browser memory attribution is #76" },
    },
    unavailable: [
      "Rust decode and bucket-rebuild timings: this capture counts decodes, builds and cache reuses per step but does not time them.",
      "Frame time during camera motion: the journey jumps between settled cameras.",
      "WebGPU backend: the pinned collector launches Chromium without WebGPU.",
    ],
    samples: { process: processSamples, journeys },
  };
  writeFileSync(path.join(output, "evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`);

  if (values.report) {
    const metric = (id: string, label: string, value: unknown, unit?: string) => ({
      id,
      label,
      ...(value === null || value === undefined
        ? { state: "unavailable", value: "not measured" }
        : { state: "measured", value }),
      ...(unit ? { unit } : {}),
    });
    const pair = (id: string, label: string, key: keyof typeof summary.reference, unit: string) =>
      ROLES.map((role) => metric(`${id}-${role}`, `${label} · ${role} median`, summary[role][key], unit));
    const report = {
      schemaVersion: 1,
      producer: "moonlight-runtime-profile",
      repository: "moritzbrantner/maps",
      revision: dirty ? null : revision,
      source: { revision, dirty },
      generatedAt: new Date().toISOString(),
      status: outcome,
      description:
        "Atlas tileset journey (#270): MapLibre GL + pmtiles reference and first-party Map View candidate over the same content-pinned Liechtenstein archives, interleaved in one job. Moonlight's score ≥ 75 policy is a viability guard, not a claim that Maps is faster; shared-runner timings are advisory.",
      metrics: [
        {
          id: "atlas-tileset-moonlight",
          label: "Moonlight evaluation (minimum score 75, 5 samples per round)",
          state: outcome,
          value: reasons.length > 0 ? `${outcome}: ${reasons.join("; ")}` : outcome,
        },
        ...rounds.map((round) => ({
          id: `atlas-tileset-round-${round.round}`,
          label: `Round ${round.round} runtime score (${round.order.join(" → ")})`,
          state: round.moonlightOutcome,
          value: round.runtimeScore ?? round.moonlightSummary,
        })),
        {
          id: "atlas-tileset-browser-comparability",
          label: "runtime-profiler browser comparability",
          state: browserComparability.status === "comparable" ? "measured" : "inconclusive",
          value: browserComparability.status,
        },
        ...pair("atlas-tileset-first-useful-map", "First useful map", "firstUsefulMapMs", "ms"),
        ...pair("atlas-tileset-warm-revisit", "Warm revisit", "warmRevisitMs", "ms"),
        ...pair("atlas-tileset-source-b", "Source A → B ready", "sourceBReadyMs", "ms"),
        ...pair("atlas-tileset-source-a", "Source B → A ready", "sourceAReadyMs", "ms"),
        ...pair("atlas-tileset-requests", "Archive range requests", "archiveRequests", "requests"),
        ...pair("atlas-tileset-bytes", "Archive bytes transferred", "archiveBytes", "bytes"),
        metric(
          "atlas-tileset-retained-bytes",
          "Candidate retained RGBA + MVT bytes (lower bound)",
          evaluation.memory.candidateRetained.rgbaAndMvtBytesLowerBound,
          "bytes",
        ),
        {
          id: "atlas-tileset-browser-memory",
          label: "Browser heap and GPU memory",
          state: "unavailable",
          value: "Browser memory attribution is #76; only the driver process RSS is sampled.",
        },
      ],
      evaluation,
      accomplishments: [],
    };
    const reportPath = path.resolve(root, values.report);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(
    `${JSON.stringify({
      scenarioId: ATLAS_TILESET_SCENARIO_ID,
      outcome,
      reasons,
      runtimeScores: rounds.map((round) => round.runtimeScore),
      browserComparability: browserComparability.status,
      summary,
      output,
    })}\n`,
  );
  if (outcome !== "passed") process.exitCode = 1;
} finally {
  rmSync(temporary, { force: true, recursive: true });
}

function invoke(program: string, args: string[], env?: Record<string, string>): string;
function invoke(
  program: string,
  args: string[],
  env: Record<string, string>,
  allowFailure: true,
): { status: number | null; stdout: string; stderr: string };
function invoke(
  program: string,
  args: string[],
  env: Record<string, string> = {},
  allowFailure = false,
) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 600_000,
  });
  if (result.error) throw result.error;
  if (allowFailure) return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  assert.equal(
    result.status,
    0,
    `${program} ${args[0]} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function json(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
