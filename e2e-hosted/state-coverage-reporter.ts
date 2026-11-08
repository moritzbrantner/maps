import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

import {
  buildEnginePlan,
  formatStateCoverage,
  parseStepTitle,
  readStatePathConfig,
  summarizeStateCoverage,
  type StateObservation,
} from "./engine-state-model";

/** Aggregates per-state/per-edge results across workers; it never affects the verdict. */
export default class StateCoverageReporter implements Reporter {
  private readonly observations: StateObservation[] = [];

  onTestEnd(_test: TestCase, result: TestResult) {
    const seen: StateObservation[] = [];
    const visit = (steps: readonly TestStep[]) => {
      for (const step of steps) {
        const parsed = parseStepTitle(step.title);
        if (parsed) seen.push({ ...parsed, passed: step.error === undefined });
        visit(step.steps);
      }
    };
    visit(result.steps);
    // A timeout can end a step without recording an error on it.
    if (result.status !== "passed" && seen.length > 0) seen[seen.length - 1]!.passed = false;
    this.observations.push(...seen);
  }

  onEnd() {
    if (this.observations.length === 0) return;
    const plan = buildEnginePlan(readStatePathConfig(process.env).tier);
    const report = summarizeStateCoverage(plan, this.observations);
    const output = path.resolve("test-results-hosted/engine-state-coverage.json");
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${formatStateCoverage(report)}\nWrote ${output}`);
  }
}
