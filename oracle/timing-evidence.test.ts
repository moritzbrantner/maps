import { describe, expect, test } from "vitest";

import {
  judgeOracleGates,
  summarizeTiming,
  type TimingAttempt,
  type TimingFingerprint,
} from "./timing-evidence.ts";

const gap = { gate: "time" as const, issue: 343, reason: "documented GPU presentation floor" };
const fingerprint: TimingFingerprint = {
  devicePixelRatio: 1,
  platform: "Linux x86_64",
  userAgent: "Chromium test",
  viewport: { width: 720, height: 480 },
  visibility: "visible",
};

function attempt(round: number, runtime: "maps" | "maplibre", ms: number): TimingAttempt {
  const renderer = runtime === "maps" ? "wgpu" : "webgl2";
  return {
    batchMeansMs: [ms, ms * 1.01],
    error: null,
    fingerprint,
    rendererAfter: renderer,
    rendererBefore: renderer,
    round,
    runtime,
  };
}

const validAttempts = () => [
  attempt(0, "maplibre", 0.4),
  attempt(0, "maps", 1.1),
  attempt(1, "maps", 1.0),
  attempt(1, "maplibre", 0.45),
];

function summarize(attempts: TimingAttempt[], hardware = true) {
  return summarizeTiming(attempts, {
    expectedBatches: 2,
    minRounds: 2,
    requireHardwareRenderers: hardware,
    viewport: { width: 720, height: 480 },
  });
}

describe("oracle timing evidence and known performance gaps", () => {
  test("keeps complete raw rounds and recognizes a valid, slower known gap", () => {
    const time = summarize(validAttempts());
    expect(time.validity).toBe("valid");
    expect(time.rounds.maplibre[0]).toBeCloseTo(0.404);
    expect(time.rounds.maplibre[1]).toBeCloseTo(0.4545);
    expect(time.rounds.maps[0]).toBeCloseTo(1.111);
    expect(time.rounds.maps[1]).toBeCloseTo(1.01);
    expect(time.attempts).toHaveLength(4);
    expect(time.ratio).toBeGreaterThan(1.1);

    const result = judgeOracleGates([gap], true, true, time, true);
    expect(result.passed).toBe(true);
    expect(result.verdict).toContain("time: known gap #343");
  });

  test("does not allow a known gap to conceal a missing measurement", () => {
    const attempts = validAttempts();
    attempts[1] = { ...attempts[1]!, batchMeansMs: null, error: "frameTimes failed" };
    const time = summarize(attempts);
    expect(time.validity).toBe("invalid");
    expect(time.ratio).toBeNull();
    expect(time.invalidReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("frameTimes failed")]),
    );

    const result = judgeOracleGates([gap], true, true, time, true);
    expect(result.passed).toBe(false);
    expect(result.verdict).toContain("time INVALID");
    expect(result.verdict).not.toContain("known gap");
  });

  test.each([
    { name: "partial batch data", batchMeansMs: [1] },
    { name: "NaN", batchMeansMs: [NaN, 1] },
    { name: "zero duration", batchMeansMs: [0, 1] },
  ])("rejects $name independently of exceptions", ({ batchMeansMs }) => {
    const attempts = validAttempts();
    attempts[1] = { ...attempts[1]!, batchMeansMs };
    const time = summarize(attempts);
    expect(time.validity).toBe("invalid");
    expect(judgeOracleGates([gap], true, true, time, true).passed).toBe(false);
  });

  test("rejects an unexpected renderer even with a fast, complete ratio", () => {
    const attempts = validAttempts().map((entry) => ({
      ...entry,
      batchMeansMs: [0.2, 0.2],
    }));
    attempts[1] = { ...attempts[1]!, rendererAfter: "canvas2d", rendererBefore: "canvas2d" };
    const time = summarize(attempts);
    expect(time.invalidReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("expected wgpu")]),
    );
    expect(judgeOracleGates([gap], true, true, time, true).verdict).toContain("time INVALID");
  });

  test("rejects MapLibre renderer fallback, not only Maps fallback", () => {
    const attempts = validAttempts();
    attempts[0] = { ...attempts[0]!, rendererBefore: "webgl1", rendererAfter: "webgl1" };
    const time = summarize(attempts);
    expect(time.invalidReasons).toEqual(
      expect.arrayContaining([expect.stringContaining("expected webgl2")]),
    );
    expect(judgeOracleGates([gap], true, true, time, true).passed).toBe(false);
  });

  test("rejects changes of renderer mid-round, fingerprints, and incomplete pairs", () => {
    const attempts = validAttempts();
    attempts[1] = { ...attempts[1]!, rendererAfter: "canvas2d" };
    attempts[2] = {
      ...attempts[2]!,
      fingerprint: { ...fingerprint, devicePixelRatio: 2 },
    };
    attempts.pop();
    const time = summarize(attempts);
    expect(time.validity).toBe("invalid");
    expect(time.invalidReasons.join(" ")).toMatch(/renderer changed/);
    expect(time.invalidReasons.join(" ")).toMatch(/fingerprint/);
    expect(time.invalidReasons.join(" ")).toMatch(/incomplete/);
    expect(judgeOracleGates([gap], true, true, time, true).passed).toBe(false);
  });

  test("fails stale time exceptions when valid measurements actually pass", () => {
    const attempts = validAttempts().map((entry) => ({
      ...entry,
      batchMeansMs: [0.4, 0.4],
    }));
    const time = summarize(attempts);
    const result = judgeOracleGates([gap], true, true, time, true);
    expect(result.passed).toBe(false);
    expect(result.verdict).toContain("time PASSES: remove known gaps #343");
  });

  test("keeps software-adapter timing advisory, including unavailable samples", () => {
    const time = summarize([{ ...attempt(0, "maps", 1.2), batchMeansMs: null }], false);
    const result = judgeOracleGates([gap], true, true, time, false);
    expect(time.validity).toBe("invalid");
    expect(result.passed).toBe(true);
    expect(result.verdict).toContain("advisory");
    expect(result.verdict).not.toContain("known gap");
  });

  test.each([
    { imageOk: false, interactionOk: true },
    { imageOk: true, interactionOk: false },
  ])("never waives image or interaction correctness with a time gap", ({ imageOk, interactionOk }) => {
    const result = judgeOracleGates([gap], imageOk, interactionOk, summarize(validAttempts()), true);
    expect(result.passed).toBe(false);
    expect(result.verdict).toContain(imageOk ? "interaction FAILS" : "image FAILS");
  });
});
