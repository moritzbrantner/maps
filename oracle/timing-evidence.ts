/** Oracle timing evidence and verdict policy. A known slow frame cannot excuse invalid data. */
import { FRAME_TIME_MARGIN, type Gate, type KnownGap } from "./scenarios.ts";

export type TimingRuntime = "maplibre" | "maps";

/** Identical for the two runtimes in a comparable timing round. */
export type TimingFingerprint = {
  devicePixelRatio: number;
  platform: string;
  userAgent: string;
  viewport: { width: number; height: number };
  visibility: string;
};

export type TimingAttempt = {
  /** Raw per-batch means, retained even when another round is invalid. */
  batchMeansMs: number[] | null;
  error: string | null;
  fingerprint: TimingFingerprint | null;
  rendererAfter: string | null;
  rendererBefore: string | null;
  round: number;
  runtime: TimingRuntime;
};

export type TimingSummary = {
  maplibreMs: number | null;
  mapsMs: number | null;
  ratio: number | null;
  rounds: Record<TimingRuntime, number[]>;
  attempts: TimingAttempt[];
  validity: "valid" | "invalid" | "not-run";
  invalidReasons: string[];
};

type TimingRequirements = {
  expectedBatches: number;
  minRounds: number;
  requireHardwareRenderers: boolean;
  viewport: { width: number; height: number };
};

export function summarizeTiming(
  attempts: TimingAttempt[],
  requirements: TimingRequirements,
): TimingSummary {
  const rounds: TimingSummary["rounds"] = { maplibre: [], maps: [] };
  if (attempts.length === 0) {
    return {
      attempts,
      invalidReasons: [],
      maplibreMs: null,
      mapsMs: null,
      ratio: null,
      rounds,
      validity: "not-run",
    };
  }

  const invalidReasons: string[] = [];
  const pairs = new Map<number, Set<TimingRuntime>>();
  let environment: string | null = null;
  for (const attempt of attempts) {
    const label = `round ${attempt.round} ${attempt.runtime}`;
    if (!Number.isInteger(attempt.round) || attempt.round < 0) {
      invalidReasons.push(`${label}: invalid round index`);
    }
    const seen = pairs.get(attempt.round) ?? new Set<TimingRuntime>();
    if (seen.has(attempt.runtime)) {
      invalidReasons.push(`${label}: duplicate measurement`);
    }
    seen.add(attempt.runtime);
    pairs.set(attempt.round, seen);

    if (attempt.error) {
      invalidReasons.push(`${label}: ${attempt.error}`);
    }
    const values = attempt.batchMeansMs;
    if (
      !values ||
      values.length !== requirements.expectedBatches ||
      !values.every((value) => Number.isFinite(value) && value > 0)
    ) {
      invalidReasons.push(`${label}: missing, nonpositive, nonfinite or incomplete batch timings`);
    } else if (!attempt.error) {
      const sorted = [...values].sort((left, right) => left - right);
      // Preserve the runner's existing median (upper middle for an even batch count).
      rounds[attempt.runtime].push(sorted[Math.floor(sorted.length / 2)]!);
    }

    if (!attempt.rendererBefore || !attempt.rendererAfter) {
      invalidReasons.push(`${label}: missing renderer identity`);
    } else {
      if (attempt.rendererBefore !== attempt.rendererAfter) {
        invalidReasons.push(`${label}: renderer changed during measurement`);
      }
      if (requirements.requireHardwareRenderers) {
        const expected = attempt.runtime === "maps" ? "wgpu" : "webgl2";
        if (attempt.rendererBefore !== expected || attempt.rendererAfter !== expected) {
          invalidReasons.push(
            `${label}: expected ${expected}, got ${attempt.rendererBefore} → ${attempt.rendererAfter}`,
          );
        }
      }
    }

    const fp = attempt.fingerprint;
    if (!fp) {
      invalidReasons.push(`${label}: missing environment fingerprint`);
    } else {
      if (
        fp.viewport.width !== requirements.viewport.width ||
        fp.viewport.height !== requirements.viewport.height ||
        fp.devicePixelRatio !== 1 ||
        fp.visibility !== "visible"
      ) {
        invalidReasons.push(
          `${label}: unexpected viewport, device pixel ratio or visibility fingerprint`,
        );
      }
      const current = JSON.stringify(fp);
      if (environment !== null && current !== environment) {
        invalidReasons.push(`${label}: incomparable environment fingerprint`);
      }
      environment ??= current;
    }
  }

  if (pairs.size < requirements.minRounds) {
    invalidReasons.push(
      `incomplete timing: expected at least ${requirements.minRounds} round pairs`,
    );
  }
  for (const [round, seen] of pairs) {
    if (seen.size !== 2) {
      invalidReasons.push(`round ${round}: incomplete Maps/MapLibre pair`);
    }
  }

  const maplibreMs = rounds.maplibre.length ? Math.min(...rounds.maplibre) : null;
  const mapsMs = rounds.maps.length ? Math.min(...rounds.maps) : null;
  if (maplibreMs === null || mapsMs === null) {
    invalidReasons.push("missing comparable timing pair");
  }
  const valid = invalidReasons.length === 0;
  return {
    attempts,
    invalidReasons,
    maplibreMs,
    mapsMs,
    ratio: valid && maplibreMs !== null && mapsMs !== null ? mapsMs / maplibreMs : null,
    rounds,
    validity: valid ? "valid" : "invalid",
  };
}

/** Only a valid hardware performance shortfall is eligible for a known time gap. */
export function judgeOracleGates(
  knownGaps: KnownGap[],
  imageOk: boolean,
  interactionOk: boolean,
  time: TimingSummary,
  enforceTime: boolean,
) {
  const timeOk =
    !enforceTime ||
    (time.validity === "valid" && time.ratio !== null && time.ratio <= FRAME_TIME_MARGIN);
  const gates: Record<Gate, boolean> = { image: imageOk, interaction: interactionOk, time: timeOk };
  const verdicts: string[] = [];
  let passed = true;
  if (enforceTime && time.validity !== "valid") {
    passed = false;
    verdicts.push(`time INVALID: ${time.invalidReasons.join("; ") || "no timing measurements"}`);
  }
  // Incomparable hardware evidence fails separately, never through a known performance gap.
  const judged: Gate[] =
    enforceTime && time.validity === "valid"
      ? ["image", "interaction", "time"]
      : ["image", "interaction"];
  for (const gate of judged) {
    const gaps = knownGaps
      .filter((entry) => entry.gate === gate)
      .map((entry) => `#${entry.issue}`)
      .join(" ");
    if (gates[gate] && gaps) {
      passed = false;
      verdicts.push(`${gate} PASSES: remove known gaps ${gaps}`);
    } else if (!gates[gate] && gaps) {
      verdicts.push(`${gate}: known gap ${gaps}`);
    } else if (!gates[gate]) {
      passed = false;
      verdicts.push(`${gate} FAILS`);
    }
  }
  if (!enforceTime && time.validity === "invalid") {
    verdicts.push(`time unavailable (advisory): ${time.invalidReasons.join("; ")}`);
  } else if (!enforceTime && time.ratio !== null && time.ratio > FRAME_TIME_MARGIN) {
    verdicts.push("time slower (advisory)");
  }
  return { gates, passed, verdict: verdicts.length ? verdicts.join("; ") : "ok" };
}
