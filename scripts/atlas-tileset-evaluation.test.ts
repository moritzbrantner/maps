import assert from "node:assert/strict";
import { test } from "node:test";

import {
  combineAtlasOutcome,
  median,
  sameAtlasWorkload,
  summarizeAtlasJourneys,
  type AtlasJourneySample,
  type AtlasRound,
} from "./atlas-tileset-evaluation.ts";

const round = (first: string, moonlightOutcome = "passed"): AtlasRound => ({
  order: first === "reference" ? ["reference", "candidate"] : ["candidate", "reference"],
  moonlightOutcome,
  moonlightSummary: `summary ${moonlightOutcome}`,
  runtimeScore: 90,
});
const interleaved = [round("reference"), round("candidate")];

function sample(implementation: string, warm: number, revision = "sha256:a"): AtlasJourneySample {
  return {
    implementation,
    firstUsefulMapMs: 300,
    archiveRequests: 10,
    archiveBytes: 1000,
    steps: ["cold", "warm-revisit", "source-b", "source-a"].map((id) => ({
      id,
      durationMs: id === "warm-revisit" ? warm : 100,
      archiveRequests: 1,
      archiveBytes: 10,
      state: { sourceId: "maps-liechtenstein", dataRevision: revision },
    })),
  };
}

test("only interleaved, comparable, Moonlight-passed rounds over one workload pass", () => {
  assert.deepEqual(
    combineAtlasOutcome({
      browserComparability: "comparable",
      rounds: interleaved,
      sameWorkload: true,
    }),
    { outcome: "passed", reasons: [] },
  );
});

test("missing or incomparable evidence is inconclusive, never passed", () => {
  const base = { browserComparability: "comparable", rounds: interleaved, sameWorkload: true };
  for (const input of [
    { ...base, browserComparability: "incomparable" },
    { ...base, browserComparability: "insufficient-evidence" },
    { ...base, sameWorkload: false },
    { ...base, rounds: [round("reference")] },
    { ...base, rounds: [round("reference"), round("reference")] },
    { ...base, rounds: [round("reference"), round("candidate", "inconclusive")] },
    { ...base, rounds: [round("reference"), round("candidate", "something-new")] },
    { ...base, rounds: [] },
  ]) {
    const result = combineAtlasOutcome(input);
    assert.equal(result.outcome, "inconclusive", JSON.stringify(input));
    assert.ok(result.reasons.length > 0);
  }
});

test("one Moonlight failure fails the evaluation even when another round passed", () => {
  const result = combineAtlasOutcome({
    browserComparability: "comparable",
    rounds: [round("reference"), round("candidate", "failed")],
    sameWorkload: true,
  });
  assert.deepEqual(result, { outcome: "failed", reasons: ["summary failed"] });
});

test("summaries are medians and an absent measurement stays absent", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([1, Number.NaN]), null);
  const summary = summarizeAtlasJourneys([sample("maps", 20), sample("maps", 40), sample("maps", 30)]);
  assert.equal(summary.samples, 3);
  assert.equal(summary.warmRevisitMs, 30);
  assert.equal(summary.firstUsefulMapMs, 300);
  const incomplete = { ...sample("maps", 20), steps: [] };
  assert.equal(summarizeAtlasJourneys([incomplete]).warmRevisitMs, null);
});

test("a different step list or archive revision is a different workload", () => {
  const reference = [sample("maplibre-gl", 20)];
  assert.equal(sameAtlasWorkload(reference, [sample("maps", 90)]), true);
  assert.equal(sameAtlasWorkload(reference, [sample("maps", 20, "sha256:b")]), false);
  assert.equal(sameAtlasWorkload(reference, [{ ...sample("maps", 20), steps: [] }]), false);
  assert.equal(sameAtlasWorkload(reference, []), false);
  assert.equal(sameAtlasWorkload([], []), false);
});
