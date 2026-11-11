import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { summarizeJobs } from "./summarize-provisioning-comparison.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("provisioning comparison stays a manual, non-required experiment", () => {
  const comparison = read(".github/workflows/provisioning-comparison.yml");
  const sample = read(".github/workflows/provisioning-sample.yml");
  assert.match(comparison, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(comparison, /^\s+(pull_request|push|schedule):/m);
  assert.match(sample, /^on:\n  workflow_call:\n/m);
  assert.doesNotMatch(read(".github/workflows/ci.yml"), /workflows\/provisioning-(comparison|sample)\.yml/);
  // No registry writes, privileged containers or nested Docker.
  assert.doesNotMatch(comparison + sample, /packages: write|--privileged|docker:dind/);
});

test("every variant executes the identical task commands", () => {
  const sample = read(".github/workflows/provisioning-sample.yml");
  for (const step of [
    "Install identical package dependencies",
    "Execute identical Rust and WASM verification",
  ]) {
    const body = sample.split(`      - name: ${step}\n`)[1]?.split("\n      - name:")[0];
    assert.ok(body, step);
    assert.doesNotMatch(body, /if:/, `${step} must run for every variant`);
    assert.match(body, /\.github\/provisioning\/run-in-variant\.sh/);
  }
  assert.match(sample, /bun install --frozen-lockfile/);
  assert.match(sample, /bun run verify:rust\n\s+bun run build:wasm/);
});

test("the agent image adds no version authority of its own", () => {
  const image = read(".github/provisioning/agent-image.Dockerfile");
  assert.match(image, /^FROM ubuntu:[\d.]+@sha256:[a-f0-9]{64}$/m);
  assert.match(image, /COPY rust-toolchain\.toml/);
  assert.match(image, /\.packageManager/);
  assert.match(image, /install-wasm-bindgen-ci\.sh/);
  assert.doesNotMatch(image, /COPY (bun\.lock|Cargo\.lock|\. )/, "dependencies stay task-time locked");
});

test("summary separates provisioning, cache, install and verification time", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const step = (name: string, start: number, end: number) => ({
    name,
    started_at: at(start),
    completed_at: at(end),
  });
  const { samples, markdown } = summarizeJobs([
    {
      name: "Warm (container, 1) / container warm 1",
      conclusion: "success",
      html_url: "https://example.invalid/1",
      started_at: at(0),
      completed_at: at(100),
      steps: [
        step("Download prebuilt agent image", 1, 5),
        step("Load digest-verified agent image", 5, 15),
        step("Restore persisted caches", 15, 30),
        step("Install identical package dependencies", 30, 40),
        step("Execute identical Rust and WASM verification", 40, 95),
      ],
    },
    { name: "Clean up", conclusion: "success", steps: [] },
  ]);
  assert.equal(samples.length, 1);
  assert.deepEqual(
    { ...samples[0], url: undefined },
    {
      variant: "container",
      mode: "warm",
      sample: 1,
      conclusion: "success",
      url: undefined,
      total: 100,
      toFirstVerification: 40,
      provisioning: 14,
      cacheRestore: 15,
      dependencyInstall: 10,
      verification: 55,
    },
  );
  assert.match(markdown, /\| container \| warm \| 1\/1 \| 100 s \| 40 s \| 14 s \| 15 s \| 10 s \| 55 s \| 100 s \| 2 \|/);
});

test("the retired Nix variant is not provisioned anywhere", () => {
  const comparison = read(".github/workflows/provisioning-comparison.yml");
  assert.equal([...comparison.matchAll(/variant: \[ubuntu, container\]/g)].length, 3);
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/provisioning-comparison.yml",
    ".github/workflows/provisioning-sample.yml",
  ]) {
    assert.doesNotMatch(read(path), /nix-installer-action|nix develop|flake\.lock/, path);
  }
  assert.equal(summarizeJobs([{ name: "Warm (nix, 1) / nix warm 1", steps: [] }]).samples.length, 0);
});
