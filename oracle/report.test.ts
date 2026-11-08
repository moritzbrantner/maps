import { describe, expect, test } from "vitest";

import { renderReport } from "./report";

describe("oracle interaction evidence", () => {
  test("identifies a camera mismatch even when both runtimes pick the same feature", () => {
    const trace = { maplibre: [{ kind: "wheel", deltaY: -120 }], maps: [{ kind: "wheel", deltaY: -120 }] };
    const scenario = {
      capability: "wheel and pick parity",
      errors: { maplibre: null, maps: null },
      files: { flip: "flip.png", maplibre: "maplibre.png", maps: "maps.png" },
      gates: { image: true, interaction: false, time: true },
      image: { floor: { mean: 0, p99: 0 }, mean: 0, meanMax: 0.01, p99: 0, p99Max: 0.01 },
      interaction: {
        ok: false,
        steps: [
          {
            bounds: { px: 7.25 },
            boundsOk: false,
            events: { maplibre: [], maps: [] },
            hovered: { maplibre: { source: "same" }, maps: { source: "same" } },
            inputs: trace,
            label: "wheel zoom in",
            ok: false,
            picksOk: true,
            readiness: { maplibre: { moving: false }, maps: { pendingTiles: "0" } },
            selected: { maplibre: {}, maps: {} },
          },
        ],
      },
      knownGaps: [],
      mapsBaseRenderer: "wgpu",
      name: "source-location",
      origin: "oracle",
      passed: false,
      time: {
        attribution: { maplibre: null, maps: null },
        maxHostLoad: null,
        validity: "not-run" as const,
        ratio: null,
        mapsMs: null,
        maplibreMs: null,
        rounds: { maplibre: [], maps: [] },
        attempts: [],
        invalidReasons: [],
      },
      unsupported: null,
      verdict: "interaction FAILS",
    };
    const report = {
      adapter: { renderer: "SwiftShader", software: true },
      boundsTolerancePx: 1,
      commit: "abc",
      flipMeanMax: 0.01,
      flipP99Max: 0.01,
      frameTimeGate: false,
      frameTimeMargin: 1.1,
      generatedAt: "2026-11-04T00:00:00Z",
      maplibreVersion: "6.15",
      timingEnvironment: null,
      passed: false,
      scenarios: [scenario],
      timing: { batchFrames: 1, batches: 1, retries: 0, rounds: 1, warmupMs: 0 },
    } as Parameters<typeof renderReport>[0];

    const html = renderReport(report);
    expect(html).toContain("pick same; camera DIFFER");
    expect(html).toContain("Failed input steps: event ordering and readiness");
    expect(html).toContain("&quot;deltaY&quot;: -120");
    expect(html).toContain("7.25");
    expect(html).toContain("interaction FAILS");
  });
});
