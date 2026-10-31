/**
 * Wheel zoom for the first-party runtime, ported from MapLibre GL JS 6.15
 * `ScrollZoomHandler` (src/ui/handler/scroll_zoom.ts) so the same wheel input lands on
 * the same camera as the MapLibre oracle (#311).
 *
 * - Wheel vs trackpad detection: a pixel delta that is a multiple of 4.000244140625 is a
 *   mouse wheel, |delta| < 4 a trackpad; otherwise the first event of a gesture waits up
 *   to 40 ms and the second event decides by delta × time.
 * - Deltas accumulate until the next frame, which turns them into a scale through a
 *   sigmoid (`2 / (1 + exp(-|delta| × rate))`, rate 1/450 for multi-notch wheel deltas
 *   and 1/100 otherwise), so one frame zooms by at most a factor of two.
 * - The target zoom builds on the previous target until the gesture has been idle for
 *   200 ms after it finished easing.
 * - Wheel gestures ease towards the target over 200 ms after the last event with a
 *   bezier that stays continuous with the previous ease; trackpad gestures jump.
 * - The zoom stays anchored at the pointer position from the gesture's first event.
 *
 * MapLibre also snaps wheel targets to `zoomSnap`; Maps has no zoom snap (MapLibre's
 * default is 0, which disables it), so there is nothing to snap.
 */
import unitBezier from "@mapbox/unitbezier";

const WHEEL_ZOOM_DELTA = 4.000244140625;
const DEFAULT_ZOOM_RATE = 1 / 100;
const WHEEL_ZOOM_RATE = 1 / 450;
const MAX_SCALE_PER_FRAME = 2;
const WHEEL_EVENT_TIME_DIFF_ADJUSTMENT = 5;
const EASE_DURATION_MS = 200;
const FINISH_DELAY_MS = 200;
const NEW_GESTURE_GAP_MS = 400;
const SINGLE_EVENT_DELAY_MS = 40;
const DOM_DELTA_LINE = 1;
const LINE_HEIGHT_PX = 40;

const defaultEasing = unitBezier(0.25, 0.1, 0.25, 1);

export type MapsScrollZoomWheel = {
  deltaMode: number;
  deltaY: number;
  shiftKey: boolean;
  /** Pointer position in viewport CSS pixels. */
  x: number;
  y: number;
};

export type MapsScrollZoomStep = {
  around: { x: number; y: number };
  /** Zoom change to apply this frame around `around`. */
  zoomDelta: number;
  /** The ease has not finished; call `frame` again on the next animation frame. */
  needsFrame: boolean;
};

export type MapsScrollZoomClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type MapsScrollZoom = {
  /** Feeds one wheel event. */
  wheel(event: MapsScrollZoomWheel): void;
  /**
   * Runs one animation frame against the current camera zoom. `constrain` clamps a
   * target zoom to the camera's limits. Returns null when there is nothing to do.
   */
  frame(zoom: number, constrain: (zoom: number) => number): MapsScrollZoomStep | null;
  /** Drops the gesture and its timers. */
  reset(): void;
};

const browserClock: MapsScrollZoomClock = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
};

/** `requestFrame` asks the host to call `frame` on the next animation frame. */
export function createMapsScrollZoom(
  requestFrame: () => void,
  clock: MapsScrollZoomClock = browserClock,
): MapsScrollZoom {
  let active = false;
  let type: "wheel" | "trackpad" | null = null;
  let lastValue = 0;
  let lastWheelEventTime: number | undefined;
  let singleEventTimeout: unknown = null;
  let finishTimeout: unknown = null;
  let delta = 0;
  let around = { x: 0, y: 0 };
  let startZoom: number | undefined;
  let targetZoom: number | undefined;
  let lastExpectedZoom: number | undefined;
  let easing: ((t: number) => number) | undefined;
  let prevEase: { start: number; duration: number; easing: (t: number) => number } | undefined;
  let needsRerender = false;

  function isActive() {
    return active || finishTimeout !== null;
  }

  function start(x: number, y: number) {
    if (!delta) return;
    needsRerender = false;
    active = true;
    if (finishTimeout !== null) {
      clock.clearTimeout(finishTimeout);
      finishTimeout = null;
    }
    around = { x, y };
    if (!needsRerender) {
      needsRerender = true;
      requestFrame();
    }
  }

  function smoothOutEasing(duration: number) {
    let next = defaultEasing;
    if (prevEase) {
      const current = prevEase;
      const t = (clock.now() - current.start) / current.duration;
      const speed = current.easing(t + 0.01) - current.easing(t);
      // MapLibre's "quick hack to make new bezier that is continuous with last".
      const x = (0.27 / Math.sqrt(speed * speed + 0.0001)) * 0.01;
      const y = Math.sqrt(0.27 * 0.27 - x * x);
      next = unitBezier(x, y, 0.25, 1);
    }
    prevEase = { duration, easing: next, start: clock.now() };
    return next;
  }

  return {
    frame(zoom, constrain) {
      if (!needsRerender) return null;
      needsRerender = false;
      if (!isActive()) return null;

      if (lastExpectedZoom !== undefined) {
        const externalZoomChange = zoom - lastExpectedZoom;
        if (startZoom !== undefined) startZoom += externalZoomChange;
        if (targetZoom !== undefined) targetZoom += externalZoomChange;
      }

      if (delta !== 0) {
        const zoomRate =
          type === "wheel" && Math.abs(delta) > WHEEL_ZOOM_DELTA
            ? WHEEL_ZOOM_RATE
            : DEFAULT_ZOOM_RATE;
        let scale = MAX_SCALE_PER_FRAME / (1 + Math.exp(-Math.abs(delta * zoomRate)));
        if (delta < 0 && scale !== 0) scale = 1 / scale;
        const fromZoom = targetZoom ?? zoom;
        targetZoom = constrain(fromZoom + Math.log2(scale));
        if (type === "wheel") {
          startZoom = zoom;
          easing = smoothOutEasing(EASE_DURATION_MS);
        }
        delta = 0;
      }

      const target = targetZoom ?? zoom;
      let finished = false;
      let nextZoom: number;
      // MapLibre tests `startZoom` for truthiness, so a wheel gesture starting at zoom 0 jumps.
      if (type === "wheel" && startZoom && easing) {
        const sinceLastWheel = clock.now() - (lastWheelEventTime ?? 0);
        const t = Math.min(
          (sinceLastWheel + WHEEL_EVENT_TIME_DIFF_ADJUSTMENT) / EASE_DURATION_MS,
          1,
        );
        const k = easing(t);
        nextZoom = startZoom * (1 - k) + target * k;
        if (t < 1) needsRerender = true;
        else finished = true;
      } else {
        nextZoom = target;
        finished = true;
      }

      active = true;
      if (finished) {
        active = false;
        finishTimeout = clock.setTimeout(() => {
          finishTimeout = null;
          targetZoom = undefined;
          lastExpectedZoom = undefined;
        }, FINISH_DELAY_MS);
      }
      lastExpectedZoom = nextZoom;
      return { around, needsFrame: !finished, zoomDelta: nextZoom - zoom };
    },

    reset() {
      active = false;
      needsRerender = false;
      delta = 0;
      targetZoom = undefined;
      lastExpectedZoom = undefined;
      if (finishTimeout !== null) clock.clearTimeout(finishTimeout);
      if (singleEventTimeout !== null) clock.clearTimeout(singleEventTimeout);
      finishTimeout = null;
      singleEventTimeout = null;
    },

    wheel(event) {
      let value = event.deltaMode === DOM_DELTA_LINE ? event.deltaY * LINE_HEIGHT_PX : event.deltaY;
      const currentTime = clock.now();
      const timeDelta = currentTime - (lastWheelEventTime ?? 0);
      lastWheelEventTime = currentTime;

      if (value !== 0 && value % WHEEL_ZOOM_DELTA === 0) {
        type = "wheel";
      } else if (value !== 0 && Math.abs(value) < 4) {
        type = "trackpad";
      } else if (timeDelta > NEW_GESTURE_GAP_MS) {
        // Likely a new gesture: wait briefly in case this is a single wheel notch.
        type = null;
        lastValue = value;
        const { x, y } = event;
        singleEventTimeout = clock.setTimeout(() => {
          singleEventTimeout = null;
          type = "wheel";
          delta -= lastValue;
          if (!active) start(x, y);
        }, SINGLE_EVENT_DELAY_MS);
      } else if (!type) {
        type = Math.abs(timeDelta * value) < 200 ? "trackpad" : "wheel";
        // Fold the delayed first event into this one.
        if (singleEventTimeout !== null) {
          clock.clearTimeout(singleEventTimeout);
          singleEventTimeout = null;
          value += lastValue;
        }
      }

      if (event.shiftKey && value) value /= 4;

      if (type) {
        delta -= value;
        if (!active) start(event.x, event.y);
      }
    },
  };
}
