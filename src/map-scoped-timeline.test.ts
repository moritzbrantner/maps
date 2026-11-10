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

  // #172 phase B: source changes, invalid input and stale asynchronous work.

  test("a consumer replacing its range keeps the time while another consumer stays registered", () => {
    const clock = createMapScopedTimelineClock();

    clock.registerTimeRange({ end: 40, start: 0 });
    let unregister = clock.registerTimeRange({ end: 100, start: 0 });

    clock.seek(70);

    // Replacing a source unregisters its old range before registering the new one.
    unregister();
    expect(clock.getSnapshot()).toMatchObject({ time: 40, timeRange: { end: 40, start: 0 } });
    unregister = clock.registerTimeRange({ end: 90, start: 10 });

    expect(clock.getSnapshot()).toMatchObject({ time: 70, timeRange: { end: 90, start: 0 } });

    // A source that no longer covers the time clamps what is sampled, to the nearest bound.
    unregister();
    unregister = clock.registerTimeRange({ end: 60, start: 10 });
    expect(clock.getSnapshot()).toMatchObject({ activeTime: 60, time: 60 });

    // The next seek or playback frame starts from the sampled time, not the older request.
    clock.seek(55);
    unregister();
    clock.registerTimeRange({ end: 100, start: 0 });
    expect(clock.getSnapshot().time).toBe(55);
  });

  test("a source change while playing keeps the playback state and advances from the sampled time", () => {
    const frames = createManualTimelineScheduler();
    const clock = createMapScopedTimelineClock({ loop: false, playbackRate: 10, scheduler: frames.scheduler });
    let unregister = clock.registerTimeRange({ end: 100, start: 0 });

    clock.seek(80);
    clock.play();
    frames.frame(0);
    frames.frame(500);
    expect(clock.getSnapshot()).toMatchObject({ isPlaying: true, time: 85 });

    unregister();
    // No data: nothing to play, but the playback intent and the time survive.
    expect(clock.getSnapshot()).toMatchObject({ hasPlayableRange: false, isPlaying: true, timeRange: null });
    expect(frames.pending).toBe(false);

    unregister = clock.registerTimeRange({ end: 50, start: 20 });
    expect(clock.getSnapshot()).toMatchObject({ isPlaying: true, time: 50 });
    expect(frames.pending).toBe(true);

    clock.seek(30);
    frames.frame(10_000);
    frames.frame(10_500);
    expect(clock.getSnapshot()).toMatchObject({ isPlaying: true, time: 35 });

    // A single-keyframe source has no playable range; the clock rests on its only time.
    unregister();
    clock.registerTimeRange({ end: 42, start: 42 });
    expect(clock.getSnapshot()).toMatchObject({ activeTime: 42, hasPlayableRange: false, time: 42 });
    expect(frames.pending).toBe(false);
  });

  test("a non-finite seek is ignored", () => {
    const onTimeChange = vi.fn();
    const clock = createMapScopedTimelineClock({ onTimeChange, timeRange: { end: 100, start: 0 } });

    clock.seek(40);
    clock.seek(Number.NaN);
    clock.seek(Number.POSITIVE_INFINITY);

    expect(clock.getSnapshot().time).toBe(40);
    expect(onTimeChange.mock.calls).toEqual([[40]]);

    // Finite out-of-range seeks clamp to the range.
    clock.seek(1e12);
    expect(clock.getSnapshot().time).toBe(100);
    clock.seek(-5);
    expect(clock.getSnapshot().time).toBe(0);
  });

  /** A scheduler whose cancelled frames still fire, like a callback already queued elsewhere. */
  function createLateFrameScheduler() {
    let queued: Array<(timestamp: number) => void> = [];
    let requests = 0;

    return {
      flush(timestamp: number) {
        const callbacks = queued;

        queued = [];
        callbacks.forEach((callback) => callback(timestamp));
      },
      get requests() {
        return requests;
      },
      scheduler: {
        cancelFrame: () => {},
        requestFrame: (callback: (timestamp: number) => void) => {
          queued.push(callback);
          requests += 1;
          return requests;
        },
      },
    };
  }

  test("a frame from before a pause never advances the time or starts a second loop", () => {
    const late = createLateFrameScheduler();
    const clock = createMapScopedTimelineClock({
      playbackRate: 1,
      scheduler: late.scheduler,
      timeRange: { end: 100, start: 0 },
    });

    clock.play();
    late.flush(0);
    late.flush(1_000);
    expect(clock.getSnapshot().time).toBe(1);

    // Pause and resume while a frame is still queued, then seek backward.
    clock.pause();
    clock.play();
    clock.seek(0.25);
    late.flush(2_000);
    expect(clock.getSnapshot().time).toBe(0.25);

    const requestsBefore = late.requests;

    late.flush(3_000);
    late.flush(4_000);
    late.flush(5_000);

    // One request per frame, and the time advanced once per frame from the seeked time.
    expect(late.requests - requestsBefore).toBe(3);
    expect(clock.getSnapshot().time).toBe(3.25);

    clock.dispose();
    late.flush(60_000);
    expect(clock.getSnapshot()).toMatchObject({ isPlaying: false, time: 3.25 });
    expect(late.requests - requestsBefore).toBe(3);

    // A disposed clock keeps its time and stays usable.
    clock.play();
    late.flush(61_000);
    late.flush(62_000);
    expect(clock.getSnapshot().time).toBe(4.25);
  });

  test("replacing the scheduler moves the one frame loop to it", () => {
    const first = createManualTimelineScheduler();
    const second = createManualTimelineScheduler();
    const clock = createMapScopedTimelineClock({
      playbackRate: 1,
      scheduler: first.scheduler,
      timeRange: { end: 100, start: 0 },
    });

    clock.play();
    first.frame(0);
    first.frame(1_000);
    clock.setOptions({ scheduler: second.scheduler });

    expect(first.pending).toBe(false);
    expect(second.pending).toBe(true);

    second.frame(5_000);
    second.frame(6_000);
    expect(clock.getSnapshot().time).toBe(2);
    expect(first.pending).toBe(false);
  });

  test("with application-controlled time, the latest supplied time wins over older requests", () => {
    const frames = createManualTimelineScheduler();
    const requested: number[] = [];
    const clock = createMapScopedTimelineClock({
      onTimeChange: (time) => requested.push(time),
      playbackRate: 1,
      scheduler: frames.scheduler,
      timeRange: { end: 100, start: 0 },
    });

    clock.setControlledTime(10);
    clock.seek(30);
    clock.seek(60);
    expect(requested).toEqual([30, 60]);
    // Requests alone change nothing.
    expect(clock.getSnapshot().time).toBe(10);

    // The application answers the newer request first; the older answer arriving later is
    // simply the application's newest time, and playback continues from it.
    clock.setControlledTime(60);
    clock.setControlledTime(30);
    expect(clock.getSnapshot().time).toBe(30);

    clock.play();
    frames.frame(0);
    frames.frame(2_000);
    expect(requested.at(-1)).toBe(32);
    expect(clock.getSnapshot().time).toBe(30);
  });
});
