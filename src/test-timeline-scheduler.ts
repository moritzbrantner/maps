import type { MapScopedTimelineScheduler } from "./map-scoped-timeline";

/** A deterministic frame scheduler: each `frame(ms)` runs the pending callback once. */
export function createManualTimelineScheduler() {
  let pending: ((timestamp: number) => void) | null = null;
  let requests = 0;
  const scheduler: MapScopedTimelineScheduler = {
    cancelFrame: () => {
      pending = null;
    },
    requestFrame: (callback) => {
      pending = callback;
      requests += 1;
      return requests;
    },
  };

  return {
    frame(timestamp: number) {
      const callback = pending;
      pending = null;
      callback?.(timestamp);
    },
    get pending() {
      return pending !== null;
    },
    get requests() {
      return requests;
    },
    scheduler,
  };
}
