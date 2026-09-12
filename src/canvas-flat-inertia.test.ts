import { describe, expect, test } from "vitest";

import {
  advanceMapsKineticPan,
  createMapsKineticPanState,
  createMapsPanVelocityTracker,
} from "./canvas-flat-inertia";

describe("flat-map kinetic pan", () => {
  test("derives release velocity from a bounded recent sample window", () => {
    const tracker = createMapsPanVelocityTracker();
    tracker.record(8, 0, 16);
    tracker.record(16, 0, 16);

    expect(tracker.release(0)).toEqual({ x: 0.75, y: 0 });
  });

  test("clamps pathological release velocity", () => {
    const tracker = createMapsPanVelocityTracker();
    tracker.record(1000, 0, 10);

    expect(tracker.release(0)).toEqual({ x: 2.5, y: 0 });
  });

  test("does not coast after a pause or a slow drag", () => {
    const paused = createMapsPanVelocityTracker();
    paused.record(20, 0, 20);
    expect(paused.release(100)).toBeNull();

    const slow = createMapsPanVelocityTracker();
    slow.record(1, 0, 20);
    expect(slow.release(0)).toBeNull();
  });

  test("integrates exponential decay consistently across frame partitions", () => {
    const initial = createMapsKineticPanState({ x: 1, y: 0 });
    expect(initial).not.toBeNull();

    const first = advanceMapsKineticPan(initial!, 16);
    expect(first.next).not.toBeNull();
    const second = advanceMapsKineticPan(first.next!, 16);
    const combined = advanceMapsKineticPan(initial!, 32);

    expect(first.deltaX + second.deltaX).toBeCloseTo(combined.deltaX, 12);
    expect(second.next?.velocity.x).toBeCloseTo(combined.next?.velocity.x ?? 0, 12);
    expect(second.next?.elapsedMs).toBe(combined.next?.elapsedMs);
  });

  test("fails closed on a long animation-frame gap", () => {
    const initial = createMapsKineticPanState({ x: 1, y: 0 });
    expect(initial).not.toBeNull();

    expect(advanceMapsKineticPan(initial!, 60)).toEqual({
      deltaX: 0,
      deltaY: 0,
      next: null,
    });
  });

  test("caps kinetic travel and duration even at maximum release speed", () => {
    let state = createMapsKineticPanState({ x: 100, y: 0 });
    expect(state).not.toBeNull();
    let distance = 0;
    let frames = 0;

    while (state) {
      const step = advanceMapsKineticPan(state, 16);
      distance += step.deltaX;
      state = step.next;
      frames += 1;
      expect(frames).toBeLessThan(50);
    }

    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(510);
  });

  test("rejects sub-threshold and non-finite starting velocity", () => {
    expect(createMapsKineticPanState({ x: 0.01, y: 0 })).toBeNull();
    expect(createMapsKineticPanState({ x: Number.NaN, y: 1 })).toBeNull();
  });
});
