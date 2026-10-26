// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kernelScenarioIds, prepareKernelScenario } from "./engine-kernel-scenarios.mjs";

// Captured from the unchanged measured callbacks of verify-benchmark-budgets.mjs
// at 748166c. These outputs protect fixture, option and operation equivalence
// independently of the new canonical runner and its timing statistics.
const legacy = JSON.parse(
  readFileSync(new URL("./fixtures/kernel-observations.json", import.meta.url)),
);

describe("canonical kernel scenario convergence", () => {
  it("preserves every former budget workload and its exact observable results", () => {
    expect(kernelScenarioIds).toEqual(legacy.map(({ name }) => `${name}-v1`));
    for (const expected of legacy) {
      const workload = prepareKernelScenario(`${expected.name}-v1`);
      expect(workload.metadata).toEqual(expected.metadata);
      // The accepted kernel target is Bun. V8 and JavaScriptCore may differ in
      // the last bits of transcendental results, so compare in the real runtime.
      const result = JSON.parse(
        execFileSync(
          "bun",
          [
            new URL("./run-engine-kernel-scenario.mjs", import.meta.url).pathname,
            `${expected.name}-v1`,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(result.observationSha256, expected.name).toBe(expected.sha256);
      expect(result.scenarioId).toBe(`${expected.name}-v1`);
    }
  });

  it("rejects an unregistered workload instead of profiling a default", () => {
    expect(() => prepareKernelScenario("unknown-v1")).toThrow(/unknown kernel scenario/i);
  });
});
