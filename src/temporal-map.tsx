"use client";

import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import { Button } from "@moritzbrantner/ui";

import { ClusteredMap, type ClusteredMapProps } from "./clustered-map";
import {
  getTemporalMapPointsAtTime,
  getTemporalMapTimeRange,
  snapTemporalMapTime,
  type TemporalMapTimeRange,
  type TemporalMapTrack,
} from "./temporal-points";

export type TemporalClusteredMapProps<TProperties = Record<string, unknown>> = Omit<
  ClusteredMapProps<TProperties>,
  "points"
> & {
  autoPlay?: boolean;
  currentTime?: number;
  defaultTime?: number;
  formatTimeLabel?: (time: number) => string;
  loopPlayback?: boolean;
  onTimeChange?: (time: number) => void;
  playbackRate?: number;
  showPlaybackControls?: boolean;
  timeStep?: number | "any";
  timelineLabel?: string;
  tracks: readonly TemporalMapTrack<TProperties>[];
};

const defaultNumberFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
});
const defaultDateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function TemporalClusteredMap<TProperties = Record<string, unknown>>({
  autoPlay = false,
  className,
  currentTime,
  defaultTime,
  formatTimeLabel = defaultFormatTimeLabel,
  loopPlayback = true,
  mapLabel = "Interactive timeline map",
  onTimeChange,
  playbackRate,
  showPlaybackControls = true,
  style,
  timeStep = "any",
  timelineLabel = "Timeline",
  tracks,
  ...mapProps
}: TemporalClusteredMapProps<TProperties>) {
  const timeRange = useMemo(() => getTemporalMapTimeRange(tracks), [tracks]);
  const [uncontrolledTime, setUncontrolledTime] = useState(() =>
    getInitialTime(defaultTime, timeRange),
  );
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const resolvedTime = currentTime ?? uncontrolledTime;
  const clampedTime = timeRange ? clampTime(resolvedTime, timeRange) : 0;
  const activeTime = useMemo(
    () => (timeRange ? snapTemporalMapTime(clampedTime, timeRange, timeStep) : clampedTime),
    [clampedTime, timeRange, timeStep],
  );
  const currentTimeRef = useRef(clampedTime);
  const lastReportedTimeRef = useRef<number | null>(null);
  const hasPlayableRange = Boolean(timeRange && timeRange.end > timeRange.start);
  const effectivePlaybackRate = useMemo(() => {
    if (Number.isFinite(playbackRate) && (playbackRate ?? 0) > 0) {
      return playbackRate!;
    }

    if (!timeRange) {
      return 1;
    }

    const span = timeRange.end - timeRange.start;

    return span > 0 ? span / 18 : 1;
  }, [playbackRate, timeRange]);
  const points = useMemo(
    () => (timeRange ? getTemporalMapPointsAtTime(tracks, activeTime) : []),
    [activeTime, timeRange, tracks],
  );

  currentTimeRef.current = clampedTime;

  const commitTime = useEffectEvent((nextTime: number) => {
    if (!timeRange) {
      return;
    }

    const clampedNextTime = clampTime(nextTime, timeRange);

    currentTimeRef.current = clampedNextTime;

    if (currentTime === undefined) {
      setUncontrolledTime(clampedNextTime);
    }

    const reportedTime = snapTemporalMapTime(clampedNextTime, timeRange, timeStep);

    if (lastReportedTimeRef.current === reportedTime) {
      return;
    }

    lastReportedTimeRef.current = reportedTime;
    startTransition(() => {
      onTimeChange?.(reportedTime);
    });
  });

  const handleSliderChange = useEffectEvent((event: ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.target.value);

    if (!Number.isFinite(nextTime)) {
      return;
    }

    setIsPlaying(false);
    commitTime(nextTime);
  });

  useEffect(() => {
    setIsPlaying(autoPlay);
  }, [autoPlay]);

  useEffect(() => {
    if (!timeRange || currentTime !== undefined) {
      return;
    }

    setUncontrolledTime((value) => clampTime(value, timeRange));
  }, [currentTime, timeRange]);

  useEffect(() => {
    if (!isPlaying || !timeRange || !hasPlayableRange) {
      return;
    }

    let animationFrameId = 0;
    let previousTimestamp: number | null = null;

    const tick = (timestamp: number) => {
      if (previousTimestamp === null) {
        previousTimestamp = timestamp;
        animationFrameId = requestAnimationFrame(tick);
        return;
      }

      const elapsedSeconds = (timestamp - previousTimestamp) / 1000;

      previousTimestamp = timestamp;

      let nextTime = currentTimeRef.current + elapsedSeconds * effectivePlaybackRate;

      if (nextTime >= timeRange.end) {
        if (!loopPlayback) {
          commitTime(timeRange.end);
          setIsPlaying(false);
          return;
        }

        const span = timeRange.end - timeRange.start;

        nextTime =
          span > 0 ? timeRange.start + ((nextTime - timeRange.start) % span) : timeRange.end;
      }

      commitTime(nextTime);
      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [commitTime, effectivePlaybackRate, hasPlayableRange, isPlaying, loopPlayback, timeRange]);

  return (
    <div className={joinClassNames("mb-temporal-map", className)}>
      <ClusteredMap
        {...mapProps}
        className="mb-temporal-map__surface"
        mapLabel={mapLabel}
        points={points}
        style={style}
      />
      {showPlaybackControls ? (
        <div className="mb-temporal-map__timeline" aria-label={timelineLabel}>
          <Button
            type="button"
            className="mb-temporal-map__playback-toggle"
            disabled={!hasPlayableRange}
            onClick={() => {
              setIsPlaying((value) => !value);
            }}
          >
            {isPlaying ? "Pause" : "Play"}
          </Button>
          <div className="mb-temporal-map__axis">
            <span className="mb-temporal-map__axis-boundary">
              {timeRange ? formatTimeLabel(timeRange.start) : "\u2014"}
            </span>
            <input
              aria-label={timelineLabel}
              className="mb-temporal-map__slider"
              disabled={!timeRange}
              max={timeRange?.end ?? 0}
              min={timeRange?.start ?? 0}
              onChange={handleSliderChange}
              step={timeStep}
              type="range"
              value={activeTime}
            />
            <span className="mb-temporal-map__axis-boundary">
              {timeRange ? formatTimeLabel(timeRange.end) : "\u2014"}
            </span>
          </div>
          <output className="mb-temporal-map__current-time" aria-live="polite">
            {timeRange ? formatTimeLabel(activeTime) : "No time data"}
          </output>
        </div>
      ) : null}
    </div>
  );
}

function getInitialTime(defaultTime: number | undefined, timeRange: TemporalMapTimeRange | null) {
  if (!timeRange) {
    return 0;
  }

  return clampTime(defaultTime ?? timeRange.start, timeRange);
}

function clampTime(time: number, timeRange: TemporalMapTimeRange) {
  if (!Number.isFinite(time)) {
    return timeRange.start;
  }

  return Math.min(Math.max(time, timeRange.start), timeRange.end);
}

function defaultFormatTimeLabel(time: number) {
  if (Math.abs(time) >= 1_000_000_000) {
    return defaultDateTimeFormatter.format(new Date(time));
  }

  return defaultNumberFormatter.format(time);
}

function joinClassNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}
