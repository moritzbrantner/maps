import { describe, expect, test, vi } from "vitest";

import { createMapScopedTimelineClock } from "./entries/temporal";
import { createManualTimelineScheduler } from "./test-timeline-scheduler";

describe("Map-Scoped Timeline clock", () => {
  test("starts at the default time inside the registered time range", () => {
    const clock = createMapScopedTimelineClock({ defaultTime: 4 });

    expect(clock.getSnapshot()).toMatchObject({ isPlaying: false, timeRange: null });

    clock.registerTimeRange({ end: 10, start: 0 });

    expect(clock.getSnapshot()).toMatchObject({
      activeTime: 4,
      hasPlayableRange: true,
      time: 4,
      timeRange: { end: 10, start: 0 },
    });
  });

  test("merges the time ranges of every consumer into one map-scoped range", () => {
    const clock = createMapScopedTimelineClock();
    const unregisterPoints = clock.registerTimeRange({ end: 10, start: 0 });
    const unregisterHeat = clock.registerTimeRange({ end: 30, start: 5 });

    expect(clock.getSnapshot().timeRange).toEqual({ end: 30, start: 0 });

    clock.seek(25);
    unregisterHeat();

    expect(clock.getSnapshot()).toMatchObject({ time: 10, timeRange: { end: 10, start: 0 } });

    unregisterPoints();

    expect(clock.getSnapshot().timeRange).toBeNull();
  });

  test("plays from one frame loop, pauses and resumes from the authoritative time", () => {
    const frames = createManualTimelineScheduler();
    const clock = createMapScopedTimelineClock({
      playbackRate: 2,
      scheduler: frames.scheduler,
      timeRange: { end: 100, start: 0 },
    });
    const listener = vi.fn();

    clock.subscribe(listener);
    clock.play();
    frames.frame(1_000);
    frames.frame(2_000);
    frames.frame(3_500);

    expect(clock.getSnapshot()).toMatchObject({ isPlaying: true, time: 5 });

    clock.pause();

    expect(frames.pending).toBe(false);
    expect(clock.getSnapshot()).toMatchObject({ isPlaying: false, time: 5 });

    clock.play();
    frames.frame(10_000);
    frames.frame(11_000);

    expect(clock.getSnapshot().time).toBe(7);
    expect(listener).toHaveBeenCalled();
  });

  test("seeking keeps playback state and snaps the sampled time to the step", () => {
    const frames = createManualTimelineScheduler();
    const clock = createMapScopedTimelineClock({
      playbackRate: 1,
      scheduler: frames.scheduler,
      timeRange: { end: 20, start: 0 },
      timeStep: 5,
    });

    clock.seek(12.5);

    expect(clock.getSnapshot()).toMatchObject({ activeTime: 10, time: 12.5 });

    clock.play();
    frames.frame(0);
    frames.frame(3_000);

    expect(clock.getSnapshot()).toMatchObject({ activeTime: 15, isPlaying: true, time: 15.5 });
  });

  test("loops or stops at the end of the range", () => {
    const frames = createManualTimelineScheduler();
    const looping = createMapScopedTimelineClock({
      playbackRate: 1,
      scheduler: frames.scheduler,
      timeRange: { end: 10, start: 0 },
    });

    looping.seek(8);
    looping.play();
    frames.frame(0);
    frames.frame(4_000);

    expect(looping.getSnapshot()).toMatchObject({ isPlaying: true, time: 2 });

    looping.dispose();
    const once = createMapScopedTimelineClock({
      loop: false,
      playbackRate: 1,
      scheduler: frames.scheduler,
      timeRange: { end: 10, start: 0 },
    });

    once.seek(8);
    once.play();
    frames.frame(0);
    frames.frame(4_000);

    expect(once.getSnapshot()).toMatchObject({ isPlaying: false, time: 10 });
    expect(frames.pending).toBe(false);
  });

  test("reports snapped time changes once per distinct sampled time", () => {
    const onTimeChange = vi.fn();
    const clock = createMapScopedTimelineClock({
      onTimeChange,
      timeRange: { end: 10, start: 0 },
      timeStep: 5,
    });

    clock.seek(1);
    clock.seek(2);
    clock.seek(6);

    expect(onTimeChange.mock.calls).toEqual([[0], [5]]);
  });

  test("application-controlled time is authoritative and playback requests advance from it", () => {
    const frames = createManualTimelineScheduler();
    const onTimeChange = vi.fn();
    const clock = createMapScopedTimelineClock({
      onTimeChange,
      playbackRate: 1,
      scheduler: frames.scheduler,
      timeRange: { end: 10, start: 0 },
    });

    clock.setControlledTime(3);
    clock.seek(6);

    expect(clock.getSnapshot().time).toBe(3);
    expect(onTimeChange).toHaveBeenLastCalledWith(6);

    clock.setControlledTime(6);
    clock.play();
    frames.frame(0);
    frames.frame(1_000);

    expect(clock.getSnapshot().time).toBe(6);
    expect(onTimeChange).toHaveBeenLastCalledWith(7);

    clock.setControlledTime(undefined);

    expect(clock.getSnapshot().time).toBe(7);
  });

  test("dispose stops the frame loop without losing the authoritative time", () => {
    const frames = createManualTimelineScheduler();
    const clock = createMapScopedTimelineClock({
      playbackRate: 1,
      scheduler: frames.scheduler,
      timeRange: { end: 10, start: 0 },
    });

    clock.play();
    frames.frame(0);
    frames.frame(2_000);
    clock.dispose();

    expect(frames.pending).toBe(false);
    expect(clock.getSnapshot()).toMatchObject({ isPlaying: false, time: 2 });
  });
});
