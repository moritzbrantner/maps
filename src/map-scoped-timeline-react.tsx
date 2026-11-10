"use client";

import { startTransition, useEffect, useState, useSyncExternalStore } from "react";

import {
  createMapScopedTimelineClockInternals,
  type MapScopedTimelineClock,
  type MapScopedTimelineSnapshot,
} from "./map-scoped-timeline";
import { TemporalPlaybackControls } from "./temporal-controls";
import type { TemporalMapTimeRange } from "./temporal-core";

/** Subscribes a component to a Map-Scoped Timeline clock. */
export function useMapScopedTimelineSnapshot(clock: MapScopedTimelineClock): MapScopedTimelineSnapshot {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}

/** The pre-clock component props, kept as a compatibility wrapper over a component-owned clock. */
export type MapScopedTimelineCompatibilityProps = {
  autoPlay?: boolean;
  currentTime?: number;
  defaultTime?: number;
  loopPlayback?: boolean;
  onTimeChange?: (time: number) => void;
  playbackRate?: number;
  timeStep?: number | "any";
};

/**
 * @internal Binds a temporal Convenience Map to its Map-Scoped Timeline: the application's
 * `timeline` clock when supplied, otherwise one clock owned by the component and configured
 * from its compatibility props. Either way the data's time range is registered with the clock
 * and the component never runs a frame loop of its own.
 */
export function useBoundMapScopedTimeline(
  timeline: MapScopedTimelineClock | undefined,
  timeRange: TemporalMapTimeRange | null,
  {
    autoPlay = false,
    currentTime,
    defaultTime,
    loopPlayback = true,
    onTimeChange,
    playbackRate,
    timeStep = "any",
  }: MapScopedTimelineCompatibilityProps,
) {
  const [owned] = useState(() =>
    createMapScopedTimelineClockInternals({ defaultTime, timeRange }),
  );
  const clock = timeline ?? owned.clock;

  if (!timeline) {
    // Idempotent and silent: the same render samples the props' time and range.
    owned.configure(
      {
        defaultTime,
        loop: loopPlayback,
        onTimeChange: onTimeChange
          ? (time) => {
              startTransition(() => {
                onTimeChange(time);
              });
            }
          : undefined,
        playbackRate,
        timeRange,
        timeStep,
      },
      currentTime,
    );
  }

  useEffect(() => {
    if (timeline) {
      return;
    }

    owned.reconcileFrames();
  });

  useEffect(() => {
    if (timeline) {
      return;
    }

    if (autoPlay) {
      owned.clock.play();
    } else {
      owned.clock.pause();
    }

    return () => {
      owned.suspendFrames();
    };
  }, [autoPlay, owned, timeline]);

  const rangeStart = timeRange?.start;
  const rangeEnd = timeRange?.end;

  useEffect(() => {
    if (!timeline || rangeStart === undefined || rangeEnd === undefined) {
      return;
    }

    return timeline.registerTimeRange({ end: rangeEnd, start: rangeStart });
  }, [rangeEnd, rangeStart, timeline]);

  const snapshot = useMapScopedTimelineSnapshot(clock);

  return { clock, snapshot };
}

export type MapScopedTimelineControlsProps = {
  formatTimeLabel?: (time: number) => string;
  timeline: MapScopedTimelineClock;
  timelineLabel?: string;
};

/** Play/pause and seek controls for a Map-Scoped Timeline clock shared by several Map Views. */
export function MapScopedTimelineControls({
  formatTimeLabel = defaultFormatTimeLabel,
  timeline,
  timelineLabel = "Timeline",
}: MapScopedTimelineControlsProps) {
  const snapshot = useMapScopedTimelineSnapshot(timeline);

  return <BoundTimelineControls clock={timeline} formatTimeLabel={formatTimeLabel} snapshot={snapshot} timelineLabel={timelineLabel} />;
}

/** @internal */
export function BoundTimelineControls({
  clock,
  formatTimeLabel,
  snapshot,
  timelineLabel,
}: {
  clock: MapScopedTimelineClock;
  formatTimeLabel: (time: number) => string;
  snapshot: MapScopedTimelineSnapshot;
  timelineLabel: string;
}) {
  return (
    <TemporalPlaybackControls
      activeTime={snapshot.activeTime}
      formatTimeLabel={formatTimeLabel}
      hasPlayableRange={snapshot.hasPlayableRange}
      isPlaying={snapshot.isPlaying}
      onSeek={(time) => {
        clock.pause();
        clock.seek(time);
      }}
      onTogglePlayback={clock.togglePlayback}
      timeRange={snapshot.timeRange}
      timeStep={snapshot.timeStep}
      timelineLabel={timelineLabel}
    />
  );
}

const defaultNumberFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
});
const defaultDateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function defaultFormatTimeLabel(time: number) {
  if (Math.abs(time) >= 1_000_000_000) {
    return defaultDateTimeFormatter.format(new Date(time));
  }

  return defaultNumberFormatter.format(time);
}
