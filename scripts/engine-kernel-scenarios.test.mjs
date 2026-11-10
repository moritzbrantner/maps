// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  kernelObservationSha256,
  kernelScenarioIds,
  prepareKernelScenario,
} from "./engine-kernel-scenarios.mjs";

// Outputs of the measured callbacks carried over unchanged from
// verify-benchmark-budgets.mjs at 748166c. They protect fixture, option and
// operation equivalence independently of the canonical runner and its timing
// statistics. Hashes are taken over the canonical observation (see
// kernelObservationSha256), not over raw IEEE-754 bit patterns: Math.hypot and
// the other libm-backed Math functions are only accurate to about one ULP, and
// their last bit varies with the engine, the C library version and the CPU
// (#406: glibc 2.39 and 2.43 disagree on the same runner CPU).
const legacy = JSON.parse(
  readFileSync(new URL("./fixtures/kernel-observations.json", import.meta.url)),
);

describe("canonical kernel scenario convergence", () => {
  it("preserves every former budget workload and its observable results", () => {
    expect(kernelScenarioIds).toEqual(legacy.map(({ name }) => `${name}-v1`));
    for (const expected of legacy) {
      const workload = prepareKernelScenario(`${expected.name}-v1`);
      expect(workload.metadata).toEqual(expected.metadata);
      // The accepted kernel target is Bun, so observe in the real runtime.
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

  it("hashes observations independently of platform floating-point noise", () => {
    const observation = {
      features: [{ id: "line", coordinates: [[7.469789280110121, 9.718805093152255]] }],
      flowArea: 13088573548421.465,
      residue: 6.123233995736766e-16,
      count: 512,
    };
    const hash = kernelObservationSha256(observation);
    // The differences measured between ubuntu-24.04 and ubuntu-26.04 runners:
    // one ULP directly from Math.hypot, up to 64 ULP (3e-14) after propagation.
    expect(
      kernelObservationSha256({
        ...observation,
        features: [{ id: "line", coordinates: [[7.469789280110122, 9.718805093152283]] }],
        flowArea: 13088573548421.467,
        residue: -1.2246467991473532e-16,
      }),
    ).toBe(hash);

    // Anything of map-domain size stays observable: a tenth of a millimetre of
    // longitude, one part in 1e11 of a large quantity, counts, ids and shape.
    const changed = [
      { ...observation, features: [{ id: "line", coordinates: [[7.469789281, 9.718805093152255]] }] },
      { ...observation, flowArea: 13088573548521.465 },
      { ...observation, count: 513 },
      { ...observation, features: [{ id: "ring", coordinates: [[7.469789280110121, 9.718805093152255]] }] },
      { ...observation, features: [{ id: "line", coordinates: [[9.718805093152255, 7.469789280110121]] }] },
      { ...observation, residue: null },
    ];
    for (const candidate of changed) {
      expect(kernelObservationSha256(candidate), JSON.stringify(candidate)).not.toBe(hash);
    }
  });

  it("rejects an unregistered workload instead of profiling a default", () => {
    expect(() => prepareKernelScenario("unknown-v1")).toThrow(/unknown kernel scenario/i);
  });
});
