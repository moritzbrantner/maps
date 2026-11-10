// Maps-side reading of the `maps-atlas-tileset-v1` evidence (#270 Fast). Moonlight
// owns each round's verdict and runtime-profiler owns comparability; this module only
// combines them without ever turning missing or incomparable evidence into a pass.

export type AtlasOutcome = "passed" | "failed" | "inconclusive";

export type AtlasJourneySample = {
  implementation: string;
  firstUsefulMapMs: number;
  archiveRequests: number;
  archiveBytes: number;
  steps: ReadonlyArray<{
    id: string;
    durationMs: number;
    archiveRequests: number;
    archiveBytes: number;
    state: Record<string, unknown>;
  }>;
};

export type AtlasRound = {
  /** Capture order within the round, e.g. `["reference", "candidate"]`. */
  order: readonly string[];
  /** Moonlight's `agent.evaluation-result/v1` outcome, verbatim. */
  moonlightOutcome: string;
  moonlightSummary: string;
  runtimeScore: number | null;
};

export const ATLAS_MINIMUM_ROUNDS = 2;

/**
 * Passed needs every interleaved round passed by Moonlight, strictly comparable browser
 * evidence and identical source workloads. Any Moonlight failure fails; everything else,
 * including an outcome this module does not know, is inconclusive.
 */
export function combineAtlasOutcome(input: {
  browserComparability: string;
  rounds: readonly AtlasRound[];
  sameWorkload: boolean;
}): { outcome: AtlasOutcome; reasons: string[] } {
  const reasons: string[] = [];
  if (input.rounds.some((round) => round.moonlightOutcome === "failed")) {
    return {
      outcome: "failed",
      reasons: input.rounds
        .filter((round) => round.moonlightOutcome === "failed")
        .map((round) => round.moonlightSummary),
    };
  }
  if (input.rounds.length < ATLAS_MINIMUM_ROUNDS) {
    reasons.push(`fewer than ${ATLAS_MINIMUM_ROUNDS} reference/candidate rounds were captured`);
  }
  const first = new Set(input.rounds.map((round) => round.order[0]));
  if (!first.has("reference") || !first.has("candidate")) {
    reasons.push("reference and candidate captures were not interleaved in both orders");
  }
  for (const [index, round] of input.rounds.entries()) {
    if (round.moonlightOutcome !== "passed") {
      reasons.push(
        `round ${index + 1} Moonlight outcome ${round.moonlightOutcome}: ${round.moonlightSummary}`,
      );
    }
  }
  if (input.browserComparability !== "comparable") {
    reasons.push(`browser evidence is ${input.browserComparability}, not comparable`);
  }
  if (!input.sameWorkload) {
    reasons.push("reference and candidate did not run the same journey over the same archives");
  }
  return { outcome: reasons.length === 0 ? "passed" : "inconclusive", reasons };
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.length !== values.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Medians over one implementation's measured journeys; raw samples stay in the evidence. */
export function summarizeAtlasJourneys(samples: readonly AtlasJourneySample[]) {
  const step = (id: string) =>
    median(
      samples.map(
        (sample) => sample.steps.find((entry) => entry.id === id)?.durationMs ?? Number.NaN,
      ),
    );
  return {
    samples: samples.length,
    firstUsefulMapMs: median(samples.map((sample) => sample.firstUsefulMapMs)),
    warmRevisitMs: step("warm-revisit"),
    sourceBReadyMs: step("source-b"),
    sourceAReadyMs: step("source-a"),
    archiveRequests: median(samples.map((sample) => sample.archiveRequests)),
    archiveBytes: median(samples.map((sample) => sample.archiveBytes)),
  };
}

export function sameAtlasWorkload(
  reference: readonly AtlasJourneySample[],
  candidate: readonly AtlasJourneySample[],
): boolean {
  const shape = (sample: AtlasJourneySample) =>
    JSON.stringify(
      sample.steps.map((step) => [step.id, step.state.sourceId, step.state.dataRevision]),
    );
  const shapes = new Set([...reference, ...candidate].map(shape));
  return reference.length > 0 && reference.length === candidate.length && shapes.size === 1;
}
