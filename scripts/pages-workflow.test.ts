import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(resolve(root, ".github/workflows/pages.yml"), "utf8");

test("PR preview and deployment builds cannot exchange Pages artifacts", () => {
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(
    workflow,
    /artifact_key: \$\{\{ github\.event_name == 'pull_request' && 'maps-engine-pages-pr-v2' \|\| 'maps-engine-pages-publish-v2' \}\}/,
  );
  assert.match(workflow, /reuse_across_runs: true/);
  assert.match(workflow, /prebuilt_artifact_key: \$\{\{ needs\.build-example\.outputs\.artifact_key \}\}/);
});

test("PR previews preserve CI oracle authority and do not rerun publication measurements", () => {
  const setup = workflow.split("      setup_command: |\n")[1]?.split("      build_command: |\n")[0];
  const build = workflow.split("      build_command: |\n")[1]?.split("      artifact_paths: dist\n")[0];
  assert.ok(setup);
  assert.ok(build);

  assert.match(setup, /if \[ "\$GITHUB_EVENT_NAME" != "pull_request" \]; then\n\s+python3 -m venv/);
  assert.match(build, /if \[ "\$GITHUB_EVENT_NAME" != "pull_request" \]; then\n\s+if ! CI=1 ORACLE_PYTHON=/);
  assert.match(build, /bun run oracle -- --out dist\/oracle/);
  assert.match(build, /if \[ "\$GITHUB_EVENT_NAME" != "pull_request" \] && CI=1 node scripts\/benchmark-interactions\.mjs/);
  assert.match(build, /node scripts\/build-benchmark-history\.mjs --run=/);
  assert.match(build, /PR preview: retaining published main benchmark history/);

  const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /name: MapLibre oracle/);
  assert.match(ci, /bun run oracle -- --out oracle-report/);
});
