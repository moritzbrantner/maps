import { describe, expect, test } from "vitest";

import {
  areMapsViewStatesEqual,
  createMapsViewStateEchoTracker,
} from "./canvas-flat-view-state-sync";

const state = (longitude: number, latitude: number, zoom: number) => ({
  center: [longitude, latitude] as [number, number],
  zoom,
});

describe("flat-map controlled view-state synchronization", () => {
  test("acknowledges delayed local echoes in order", () => {
    const tracker = createMapsViewStateEchoTracker();
    const first = state(13.4, 52.52, 6);
    const second = state(13.3, 52.6, 6);

    tracker.record(first);
    tracker.record(second);

    expect(tracker.acknowledge(first)).toBe(true);
    expect(tracker.acknowledge(second)).toBe(true);
  });

  test("accepts a batched newer echo and discards superseded local states", () => {
    const tracker = createMapsViewStateEchoTracker();
    const first = state(13.4, 52.52, 6);
    const second = state(13.3, 52.6, 6);
    const third = state(13.2, 52.7, 6);

    tracker.record(first);
    tracker.record(second);
    tracker.record(third);

    expect(tracker.acknowledge(third)).toBe(true);
    expect(tracker.acknowledge(first)).toBe(false);
  });

  test("does not classify an external view state as a local echo", () => {
    const tracker = createMapsViewStateEchoTracker();
    const local = state(13.4, 52.52, 6);
    const external = state(-0.1276, 51.5072, 8);

    tracker.record(local);

    expect(tracker.acknowledge(external)).toBe(false);
    tracker.clear();
    expect(tracker.acknowledge(local)).toBe(false);
  });

  test("treats omitted orientation as the zero-orientation compatibility state", () => {
    expect(
      areMapsViewStatesEqual(state(13.4, 52.52, 6), {
        ...state(13.4, 52.52, 6),
        bearing: 0,
        pitch: 0,
      }),
    ).toBe(true);
  });

  test("keeps non-zero orientation in local echo identity", () => {
    const tracker = createMapsViewStateEchoTracker();
    const oriented = {
      ...state(13.4, 52.52, 6),
      bearing: 30,
      pitch: 45,
    };

    tracker.record(oriented);

    expect(tracker.acknowledge({ ...oriented, bearing: 31 })).toBe(false);
    expect(tracker.acknowledge(oriented)).toBe(true);
  });
});
