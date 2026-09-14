import { describe, expect, test } from "vitest";

import { buildPagesRuntimeEvidence } from "./build-pages-runtime-evidence.mjs";

const baseEvaluation = {
  schemaVersion: 1,
  evaluationId: "evaluation-1",
  evaluator: {
    component: "moonlight",
    version: "1.2.3",
    protocol: "runtime-profiler-bundle/v1",
    configurationDigest: "sha256:policy",
  },
  baseline: { kind: "evidence-bundle", identity: "reference" },
  candidate: { kind: "evidence-bundle", identity: "candidate" },
  outcome: "passed",
  summary: "Candidate runtime score 93 satisfies policy.",
  metrics: {
    minimumScore: 75,
    minimumSamples: 5,
    runtimeScore: 93,
    runtimeRating: "excellent",
    scenarioId: "maps-camera-world-pan-v1",
    referenceMinimumSampleCount: 5,
    candidateMinimumSampleCount: 5,
    candidateSuccessRate: 1,
  },
  finishedAt: "2026-09-14T02:00:00Z",
  evidence: [{ kind: "runtime-profile-bundle" }, { kind: "runtime-profile-bundle" }],
};

describe("Pages runtime evidence", () => {
  test("transports Moonlight metrics and exact source provenance without re-evaluating policy", () => {
    const result = buildPagesRuntimeEvidence(baseEvaluation, {
      repository: "moritzbrantner/maps",
      revision: "0123456789abcdef",
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      producer: "moonlight-runtime-profile",
      repository: "moritzbrantner/maps",
      revision: "0123456789abcdef",
      generatedAt: "2026-09-14T02:00:00Z",
      status: "passed",
      accomplishments: [
        {
          title: "maps-camera-world-pan-v1 runtime policy passed",
          state: "passed",
          revision: "0123456789abcdef",
        },
      ],
      provenance: {
        evaluationId: "evaluation-1",
        baseline: { identity: "reference" },
        candidate: { identity: "candidate" },
      },
    });
    expect(result.metrics).toContainEqual({
      id: "runtime-score",
      label: "Runtime score",
      value: 93,
      unit: "score",
      state: "passed",
    });
    expect(result.metrics).toContainEqual({
      id: "candidate-success-rate",
      label: "Candidate success rate",
      value: 100,
      unit: "%",
      state: "passed",
    });
  });

  test("does not turn a failed producer verdict into an accomplishment", () => {
    const result = buildPagesRuntimeEvidence(
      { ...baseEvaluation, outcome: "failed", summary: "Below the configured minimum." },
      { repository: "moritzbrantner/maps", revision: "abc" },
    );
    expect(result.status).toBe("failed");
    expect(result.accomplishments).toEqual([]);
    expect(result.metrics.every((metric) => metric.state === "failed")).toBe(true);
  });

  test("rejects unsupported Moonlight evidence instead of guessing", () => {
    expect(() =>
      buildPagesRuntimeEvidence(
        { ...baseEvaluation, schemaVersion: 2 },
        { repository: "moritzbrantner/maps", revision: "abc" },
      ),
    ).toThrow("unsupported Moonlight runtime evaluation schema");
    expect(() =>
      buildPagesRuntimeEvidence(
        { ...baseEvaluation, evaluator: { ...baseEvaluation.evaluator, component: "other" } },
        { repository: "moritzbrantner/maps", revision: "abc" },
      ),
    ).toThrow("runtime evaluation producer is not Moonlight");
  });
});
