import {
  clampTemporalMapTime,
  mergeTemporalMapTimeRanges,
  snapTemporalMapTime,
  type TemporalMapTimeRange,
} from "./temporal-core";

/** Schedules the clock's single frame loop; defaults to `requestAnimationFrame`. */
export type MapScopedTimelineScheduler = {
  cancelFrame(handle: number): void;
  requestFrame(callback: (timestampMs: number) => void): number;
};

export type MapScopedTimelineOptions = {
  /** Initial time; defaults to the start of the time range. */
  defaultTime?: number;
  /** Restart from the range start after reaching its end. Defaults to `true`. */
  loop?: boolean;
  /**
   * Called with the snapped time whenever a seek or playback frame changes it. With
   * application-controlled time this is a request: the application supplies the next time.
   */
  onTimeChange?: (time: number) => void;
  /** Time units per second of playback. Defaults to the range span divided by 18. */
  playbackRate?: number;
  scheduler?: MapScopedTimelineScheduler;
  /** An explicit time range. Without one, the clock merges the ranges its consumers register. */
  timeRange?: TemporalMapTimeRange | null;
  /** Step the sampled `activeTime` snaps to, or `"any"`. Defaults to `"any"`. */
  timeStep?: number | "any";
};

export type MapScopedTimelineSnapshot = {
  /** The snapped time every Map Layer samples. */
  activeTime: number;
  hasPlayableRange: boolean;
  isPlaying: boolean;
  /** The authoritative, range-clamped time. */
  time: number;
  timeRange: TemporalMapTimeRange | null;
  timeStep: number | "any";
};

/**
 * The one authoritative time of a Map-Scoped Timeline. Every temporal Map Layer samples its
 * snapshot instead of keeping its own clock, and a single frame loop advances it while playing.
 */
export type MapScopedTimelineClock = {
  /** Stops the frame loop and pauses; the time is kept and the clock stays usable. */
  dispose(): void;
  getSnapshot(): MapScopedTimelineSnapshot;
  pause(): void;
  play(): void;
  /**
   * Adds a consumer's time range to the merged map-scoped range. Returns the unregister
   * function. Ignored while an explicit `timeRange` option is set.
   */
  registerTimeRange(timeRange: TemporalMapTimeRange | null): () => void;
  /**
   * Moves to `time` (clamped to the range) without changing the playback state. A non-finite
   * `time` is ignored.
   */
  seek(time: number): void;
  /**
   * Makes the application the owner of the time. While defined, the snapshot reports it and
   * seeks or playback frames only request changes through `onTimeChange`; `undefined` returns
   * ownership to the clock.
   */
  setControlledTime(time: number | undefined): void;
  setOptions(options: Partial<MapScopedTimelineOptions>): void;
  subscribe(listener: () => void): () => void;
  togglePlayback(): void;
};

type ClockState = {
  controlledTime: number | undefined;
  isPlaying: boolean;
  options: MapScopedTimelineOptions;
  registeredRanges: Map<number, TemporalMapTimeRange | null>;
  /**
   * The last requested uncontrolled time, or the base playback advances from while time is
   * controlled. It is kept as requested: the time range clamps only what the snapshot reports,
   * so a consumer replacing its registered range cannot lose the time in between.
   */
  time: number | null;
};

/** @internal Component-owned clocks configure from props during render without notifying. */
export type MapScopedTimelineClockInternals = {
  clock: MapScopedTimelineClock;
  configure(options: MapScopedTimelineOptions, controlledTime: number | undefined): void;
  /** Starts or stops the frame loop to match the current state. */
  reconcileFrames(): void;
  suspendFrames(): void;
};

export function createMapScopedTimelineClock(
  options: MapScopedTimelineOptions = {},
): MapScopedTimelineClock {
  return createMapScopedTimelineClockInternals(options).clock;
}

/** @internal */
export function createMapScopedTimelineClockInternals(
  initialOptions: MapScopedTimelineOptions = {},
): MapScopedTimelineClockInternals {
  const state: ClockState = {
    controlledTime: undefined,
    isPlaying: false,
    options: { ...initialOptions },
    registeredRanges: new Map(),
    time: null,
  };
  const listeners = new Set<() => void>();
  let nextRegistration = 0;
  let frameHandle: number | null = null;
  // The scheduler that issued `frameHandle`, and the `scheduler` option it was resolved from.
  let frameScheduler: MapScopedTimelineScheduler | null = null;
  let frameSchedulerOption: MapScopedTimelineScheduler | undefined;
  // Identifies the one live frame request; a callback from any earlier request is stale.
  let frameToken = 0;
  let previousTimestamp: number | null = null;
  let lastReportedTime: number | null = null;
  let snapshot = computeSnapshot();

  function getTimeRange() {
    if (state.options.timeRange !== undefined) {
      return state.options.timeRange;
    }

    return mergeTemporalMapTimeRanges(...state.registeredRanges.values());
  }

  function getBaseTime(timeRange: TemporalMapTimeRange) {
    if (state.time === null) {
      state.time = clampTemporalMapTime(state.options.defaultTime ?? timeRange.start, timeRange);
    }

    return clampTemporalMapTime(state.time, timeRange);
  }

  function computeSnapshot(): MapScopedTimelineSnapshot {
    const timeRange = getTimeRange();
    const timeStep = state.options.timeStep ?? "any";
    const isPlaying = state.isPlaying;

    if (!timeRange) {
      return { activeTime: 0, hasPlayableRange: false, isPlaying, time: 0, timeRange: null, timeStep };
    }

    const time =
      state.controlledTime === undefined
        ? getBaseTime(timeRange)
        : clampTemporalMapTime(state.controlledTime, timeRange);

    return {
      activeTime: snapTemporalMapTime(time, timeRange, timeStep),
      hasPlayableRange: timeRange.end > timeRange.start,
      isPlaying,
      time,
      timeRange,
      timeStep,
    };
  }

  function refreshSnapshot() {
    const next = computeSnapshot();

    if (snapshotsEqual(snapshot, next)) {
      return false;
    }

    snapshot = next;
    return true;
  }

  function update(notify = true) {
    const changed = refreshSnapshot();

    reconcileFrames();

    if (changed && notify) {
      for (const listener of [...listeners]) {
        listener();
      }
    }
  }

  function commitTime(nextTime: number) {
    const timeRange = getTimeRange();

    if (!timeRange) {
      return;
    }

    const clampedTime = clampTemporalMapTime(nextTime, timeRange);

    state.time = clampedTime;
    update();

    const reportedTime = snapTemporalMapTime(clampedTime, timeRange, state.options.timeStep);

    if (lastReportedTime !== reportedTime) {
      lastReportedTime = reportedTime;
      state.options.onTimeChange?.(reportedTime);
    }
  }

  function getScheduler(): MapScopedTimelineScheduler | null {
    if (state.options.scheduler) {
      return state.options.scheduler;
    }

    if (typeof requestAnimationFrame !== "function") {
      return null;
    }

    return {
      cancelFrame: (handle) => cancelAnimationFrame(handle),
      requestFrame: (callback) => requestAnimationFrame(callback),
    };
  }

  function suspendFrames() {
    if (frameHandle !== null) {
      frameScheduler?.cancelFrame(frameHandle);
    }

    frameHandle = null;
    frameScheduler = null;
    frameToken += 1;
    previousTimestamp = null;
  }

  function reconcileFrames() {
    if (!state.isPlaying || !snapshot.hasPlayableRange) {
      suspendFrames();
      return;
    }

    if (frameHandle !== null && frameSchedulerOption !== state.options.scheduler) {
      // The scheduler was replaced: the pending frame belongs to the previous one.
      suspendFrames();
    }

    if (frameHandle === null) {
      const scheduler = getScheduler();
      const token = ++frameToken;

      frameScheduler = scheduler;
      frameSchedulerOption = state.options.scheduler;
      frameHandle =
        scheduler?.requestFrame((timestamp) => {
          // A frame that was cancelled or superseded must not advance or restart the loop.
          if (token === frameToken) {
            tick(timestamp);
          }
        }) ?? null;
    }
  }

  function tick(timestamp: number) {
    frameHandle = null;
    const timeRange = getTimeRange();

    if (!state.isPlaying || !timeRange) {
      return;
    }

    if (previousTimestamp === null) {
      previousTimestamp = timestamp;
      reconcileFrames();
      return;
    }

    const elapsedSeconds = Math.max(0, (timestamp - previousTimestamp) / 1000);

    previousTimestamp = timestamp;

    const span = timeRange.end - timeRange.start;
    const rate =
      Number.isFinite(state.options.playbackRate) && (state.options.playbackRate ?? 0) > 0
        ? state.options.playbackRate!
        : span > 0
          ? span / 18
          : 1;
    let nextTime = getBaseTime(timeRange) + elapsedSeconds * rate;

    if (nextTime >= timeRange.end) {
      if (state.options.loop === false) {
        state.isPlaying = false;
        commitTime(timeRange.end);
        return;
      }

      nextTime = span > 0 ? timeRange.start + ((nextTime - timeRange.start) % span) : timeRange.end;
    }

    commitTime(nextTime);
  }

  const clock: MapScopedTimelineClock = {
    dispose() {
      state.isPlaying = false;
      suspendFrames();
      update();
    },
    getSnapshot: () => snapshot,
    pause() {
      state.isPlaying = false;
      update();
    },
    play() {
      state.isPlaying = true;
      update();
    },
    registerTimeRange(timeRange) {
      const registration = nextRegistration++;

      state.registeredRanges.set(registration, timeRange);
      update();

      return () => {
        if (state.registeredRanges.delete(registration)) {
          update();
        }
      };
    },
    seek(time) {
      if (Number.isFinite(time)) {
        commitTime(time);
      }
    },
    setControlledTime(time) {
      state.controlledTime = time;

      if (time !== undefined) {
        state.time = time;
      }

      update();
    },
    setOptions(options) {
      state.options = { ...state.options, ...options };
      update();
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    togglePlayback() {
      state.isPlaying = !state.isPlaying;
      update();
    },
  };

  return {
    clock,
    configure(options, controlledTime) {
      state.options = { ...options };
      state.controlledTime = controlledTime;

      if (controlledTime !== undefined) {
        state.time = controlledTime;
      }

      refreshSnapshot();
    },
    reconcileFrames,
    suspendFrames,
  };
}

function snapshotsEqual(left: MapScopedTimelineSnapshot, right: MapScopedTimelineSnapshot) {
  return (
    left.activeTime === right.activeTime &&
    left.hasPlayableRange === right.hasPlayableRange &&
    left.isPlaying === right.isPlaying &&
    left.time === right.time &&
    left.timeStep === right.timeStep &&
    left.timeRange?.start === right.timeRange?.start &&
    left.timeRange?.end === right.timeRange?.end
  );
}
