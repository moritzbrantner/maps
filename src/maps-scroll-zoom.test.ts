import { describe, expect, test } from "vitest";

import { createMapsScrollZoom, type MapsScrollZoomClock } from "./maps-scroll-zoom";

function fakeClock() {
  let time = 1000;
  let timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  const clock: MapsScrollZoomClock = {
    clearTimeout: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    now: () => time,
    setTimeout: (callback, ms) => {
      timers.push({ at: time + ms, callback, id: nextId });
      return nextId++;
    },
  };
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      time = due.at;
      timers = timers.filter((timer) => timer !== due);
      due.callback();
    }
    time = end;
  };
  return { advance, clock };
}

/** Drives wheel ticks and 16 ms frames until the gesture settles; returns the final zoom. */
function run(ticks: number[], startZoom: number, deltaMode = 0, tickGapMs = 40) {
  const { advance, clock } = fakeClock();
  let frameRequested = false;
  const scroll = createMapsScrollZoom(() => (frameRequested = true), clock);
  let zoom = startZoom;
  const frame = () => {
    if (!frameRequested) return;
    frameRequested = false;
    const step = scroll.frame(zoom, (value) => Math.min(Math.max(value, 0), 22));
    if (!step) return;
    expect(step.around).toEqual({ x: 10, y: 20 });
    zoom += step.zoomDelta;
    if (step.needsFrame) frameRequested = true;
  };
  for (const deltaY of ticks) {
    scroll.wheel({ deltaMode, deltaY, shiftKey: false, x: 10, y: 20 });
    for (let elapsed = 0; elapsed < tickGapMs; elapsed += 16) {
      advance(Math.min(16, tickGapMs - elapsed));
      frame();
    }
  }
  for (let elapsed = 0; elapsed < 1000; elapsed += 16) {
    advance(16);
    frame();
  }
  return zoom;
}

describe("MapLibre scroll zoom port", () => {
  test("a single mouse notch zooms by MapLibre's sigmoid at the wheel rate", () => {
    // 120 px is not a multiple of 4.000244140625, so the first event waits 40 ms and is
    // then treated as a wheel; |delta| > 4.0002 selects the 1/450 rate.
    const expected = Math.log2(2 / (1 + Math.exp(-120 / 450)));
    expect(run([-120], 5)).toBeCloseTo(5 + expected, 10);
    expect(run([120], 5)).toBeCloseTo(5 - expected, 10);
  });

  test("successive notches build on the previous target", () => {
    const perNotch = Math.log2(2 / (1 + Math.exp(-120 / 450)));
    expect(run([-120, -120, -120], 5)).toBeCloseTo(5 + 3 * perNotch, 10);
  });

  test("small deltas are trackpad scrolls at the default rate and jump", () => {
    const { clock } = fakeClock();
    const scroll = createMapsScrollZoom(() => {}, clock);
    scroll.wheel({ deltaMode: 0, deltaY: -2, shiftKey: false, x: 0, y: 0 });
    const step = scroll.frame(5, (value) => value);
    expect(step?.needsFrame).toBe(false);
    expect(step?.zoomDelta).toBeCloseTo(Math.log2(2 / (1 + Math.exp(-2 / 100))), 12);
  });

  test("line deltas count 40 px per line and the target is constrained", () => {
    expect(run([-3], 5, 1)).toBeCloseTo(run([-120], 5), 12);
    expect(run([-1200], 21.95)).toBe(22);
  });
});
