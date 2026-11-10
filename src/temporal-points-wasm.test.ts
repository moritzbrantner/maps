import { afterEach, describe, expect, test } from "vitest";

import {
  createTemporalMapPlaybackIndex,
  ensureMapsTemporalWasm,
  getMapsTemporalRuntimeStatus,
  getTemporalMapPointsAtTime,
  initializeMapsTemporalWasm,
  type TemporalMapTrack,
} from ".";
import {
  resetMapsTemporalWasmRuntimeForTests,
  setMapsTemporalWasmRuntimeForTests,
} from "./temporal-points-wasm";
import { sampleTemporalPointsNaively } from "./test-temporal-oracle";
import {
  canonicalTemporalSample,
  TEMPORAL_EDGE_POINT_TRACKS,
  TEMPORAL_EDGE_SEQUENCE,
} from "./test-temporal-point-sequences";
import { createScanTemporalRuntimeForTests } from "./test-temporal-runtime";

afterEach(() => {
  resetMapsTemporalWasmRuntimeForTests();
});

describe("Maps temporal Rust authority (#172)", () => {
  test("an installed runtime samples every playback index and one-shot sample", () => {
    const calls = { indexes: 0, samples: 0 };
    setMapsTemporalWasmRuntimeForTests(createScanTemporalRuntimeForTests(calls));
    const index = createTemporalMapPlaybackIndex(TEMPORAL_EDGE_POINT_TRACKS);

    expect(calls.indexes).toBe(1);
    expect(index.getTimeRange()).toEqual({ end: 100, start: 0 });

    // Application data (identity, labels, properties, metrics) is joined to the keyframes
    // the runtime reports, and the result matches the independent reference at every step.
    for (const time of TEMPORAL_EDGE_SEQUENCE) {
      const expected = canonicalTemporalSample(
        sampleTemporalPointsNaively(TEMPORAL_EDGE_POINT_TRACKS, time),
      );

      expect(canonicalTemporalSample(index.getPointsAtTime(time)), `index at ${time}`).toEqual(expected);
      expect(
        canonicalTemporalSample(getTemporalMapPointsAtTime(TEMPORAL_EDGE_POINT_TRACKS, time)),
        `one-shot at ${time}`,
      ).toEqual(expected);
    }

    // Invalid times never reach the runtime; every finite sample does, once per call.
    const finiteSteps = TEMPORAL_EDGE_SEQUENCE.filter(Number.isFinite).length;
    expect(calls.samples).toBe(finiteSteps * 2);
    expect(calls.indexes).toBe(1 + finiteSteps);
  });

  test("keyframes are read when the index is prepared and non-numeric values are invalid", () => {
    setMapsTemporalWasmRuntimeForTests(createScanTemporalRuntimeForTests());
    const frames = [
      { latitude: 0, longitude: 0, time: 0 },
      { latitude: 10, longitude: 10, time: "5" as unknown as number },
      { latitude: 10, longitude: 20, time: 10 },
    ];
    const tracks: TemporalMapTrack[] = [{ frames, id: "a" }];
    const index = createTemporalMapPlaybackIndex(tracks);

    frames.splice(0, 1);

    expect(index.getPointsAtTime(5)).toEqual([
      { id: "a", label: "", latitude: 5, longitude: 10, metrics: {}, properties: {} },
    ]);
    expect(index.getPointsAtTime(5)).toEqual(
      sampleTemporalPointsNaively([{ frames: [{ latitude: 0, longitude: 0, time: 0 }, frames[1]!], id: "a" }], 5),
    );
  });

  test("a selected runtime that fails to build an index fails closed", () => {
    setMapsTemporalWasmRuntimeForTests({
      createPointIndex() {
        throw new Error("rust index failed");
      },
    });

    expect(() => createTemporalMapPlaybackIndex(TEMPORAL_EDGE_POINT_TRACKS)).toThrow("rust index failed");
  });

  test("without the WASM package the TypeScript reference stays the explicit fallback", async () => {
    expect(getMapsTemporalRuntimeStatus()).toBe("idle");

    const loading = ensureMapsTemporalWasm();
    expect(getMapsTemporalRuntimeStatus()).toBe("loading");
    expect(ensureMapsTemporalWasm()).toBe(loading);
    await expect(loading).resolves.toBe(false);
    expect(getMapsTemporalRuntimeStatus()).toBe("unavailable");

    expect(canonicalTemporalSample(createTemporalMapPlaybackIndex(TEMPORAL_EDGE_POINT_TRACKS).getPointsAtTime(30))).toEqual(
      canonicalTemporalSample(sampleTemporalPointsNaively(TEMPORAL_EDGE_POINT_TRACKS, 30)),
    );
  });

  test("an older failed load never replaces a runtime installed since", async () => {
    const loading = initializeMapsTemporalWasm();
    setMapsTemporalWasmRuntimeForTests(createScanTemporalRuntimeForTests());

    await expect(loading).resolves.toBe(true);
    expect(getMapsTemporalRuntimeStatus()).toBe("ready");
  });
});
