#!/usr/bin/env node
// Summarizes one Maps Provisioning Comparison run (issue #211) from the hosted
// job/step timestamps. Usage: node scripts/summarize-provisioning-comparison.mjs <run-id> [repo]
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const seconds = (start, end) =>
  start && end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) : undefined;

const median = (values) => {
  const sorted = values.filter((value) => value !== undefined).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const VERIFY = "Execute identical Rust and WASM verification";
const INSTALL = "Install identical package dependencies";
const RESTORE = /^Restore persisted caches$/;
const PROVISION =
  /^(Conventional .*|Download prebuilt agent image|Load digest-verified agent image)$/;

/** Classifies one hosted job of the comparison into a timed sample. */
export function summarizeJob(job) {
  const match = /(ubuntu|container) (cold|prime|warm) (\d+)$/.exec(job.name);
  if (!match) return undefined;
  const steps = job.steps ?? [];
  const sum = (predicate) =>
    steps
      .filter((step) => predicate(step.name))
      .reduce((total, step) => total + (seconds(step.started_at, step.completed_at) ?? 0), 0);
  const verify = steps.find((step) => step.name === VERIFY);
  return {
    variant: match[1],
    mode: match[2],
    sample: Number(match[3]),
    conclusion: job.conclusion,
    url: job.html_url,
    total: seconds(job.started_at, job.completed_at),
    toFirstVerification: seconds(job.started_at, verify?.started_at),
    provisioning: sum((name) => PROVISION.test(name)),
    cacheRestore: sum((name) => RESTORE.test(name)),
    dependencyInstall: sum((name) => name === INSTALL),
    verification: sum((name) => name === VERIFY),
  };
}

/** Builds the per-variant/cache-mode median table in Markdown. */
export function summarizeJobs(jobs) {
  const samples = jobs.map(summarizeJob).filter(Boolean);
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.variant} ${sample.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const fmt = (value) => (value === undefined ? "n/a" : `${Math.round(value)} s`);
  const lines = [
    "| Variant | Cache | Success | Median job | Start → verification | Provisioning | Cache restore | `bun install` | Verification | Summed job time | Billed runner-min |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [variant, mode] = key.split(" ");
    const ok = group.filter((sample) => sample.conclusion === "success");
    const pick = (field) => median(ok.map((sample) => sample[field]));
    const summed = group.reduce((total, sample) => total + (sample.total ?? 0), 0);
    const billed = group.reduce((total, sample) => total + Math.ceil((sample.total ?? 0) / 60), 0);
    lines.push(
      `| ${variant} | ${mode} | ${ok.length}/${group.length} | ${fmt(pick("total"))} | ${fmt(pick("toFirstVerification"))} | ${fmt(pick("provisioning"))} | ${fmt(pick("cacheRestore"))} | ${fmt(pick("dependencyInstall"))} | ${fmt(pick("verification"))} | ${fmt(summed)} | ${billed} |`,
    );
  }
  return { samples, markdown: lines.join("\n") };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [runId, repo = "moritzbrantner/maps"] = process.argv.slice(2);
  if (!runId) {
    console.error("Usage: summarize-provisioning-comparison.mjs <run-id> [owner/repo]");
    process.exit(2);
  }
  const pages = execFileSync(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const jobs = JSON.parse(pages).flatMap((page) => page.jobs);
  const { samples, markdown } = summarizeJobs(jobs);
  console.log(markdown);
  console.log();
  for (const sample of samples.sort((a, b) => a.variant.localeCompare(b.variant) || a.mode.localeCompare(b.mode) || a.sample - b.sample)) {
    console.log(`- ${sample.variant} ${sample.mode} ${sample.sample}: ${sample.conclusion}, ${Math.round(sample.total ?? 0)} s — ${sample.url}`);
  }
}
