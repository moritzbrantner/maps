"use client";

import { useMemo, type ChangeEvent } from "react";

import type { TemporalMapTimeRange } from "./temporal-points";

export type TemporalPlaybackControlsProps = {
  activeTime: number;
  formatTimeLabel: (time: number) => string;
  hasPlayableRange: boolean;
  isPlaying: boolean;
  onSeek: (time: number) => void;
  onTogglePlayback: () => void;
  timeRange: TemporalMapTimeRange | null;
  timeStep: number | "any";
  timelineLabel: string;
};

export function TemporalPlaybackControls({
  activeTime,
  formatTimeLabel,
  hasPlayableRange,
  isPlaying,
  onSeek,
  onTogglePlayback,
  timeRange,
  timeStep,
  timelineLabel,
}: TemporalPlaybackControlsProps) {
  const seekIncrement = useMemo(() => getSeekIncrement(timeRange, timeStep), [timeRange, timeStep]);
  const canSeek = Boolean(timeRange);
  const canSeekBackward = Boolean(timeRange && activeTime > timeRange.start);
  const canSeekForward = Boolean(timeRange && activeTime < timeRange.end);

  const seekToStart = () => {
    if (!timeRange) {
      return;
    }

    onSeek(timeRange.start);
  };

  const seekBackward = () => {
    if (!timeRange) {
      return;
    }

    onSeek(Math.max(timeRange.start, activeTime - seekIncrement));
  };

  const seekForward = () => {
    if (!timeRange) {
      return;
    }

    onSeek(Math.min(timeRange.end, activeTime + seekIncrement));
  };

  const seekToEnd = () => {
    if (!timeRange) {
      return;
    }

    onSeek(timeRange.end);
  };

  const handleSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.target.value);

    if (!Number.isFinite(nextTime)) {
      return;
    }

    onSeek(nextTime);
  };

  return (
    <div className="mb-temporal-map__timeline" role="group" aria-label={timelineLabel}>
      <div className="mb-temporal-map__timeline-header">
        <span className="mb-temporal-map__timeline-label">{timelineLabel}</span>
        <output className="mb-temporal-map__current-time" aria-live="polite">
          {timeRange ? formatTimeLabel(activeTime) : "No time data"}
        </output>
      </div>
      <div className="mb-temporal-map__controls" role="toolbar" aria-label={`${timelineLabel} playback controls`}>
        <button
          type="button"
          className="mb-temporal-map__control-button"
          disabled={!canSeekBackward}
          onClick={seekToStart}
          aria-label="Jump to start"
        >
          Start
        </button>
        <button
          type="button"
          className="mb-temporal-map__control-button"
          disabled={!canSeekBackward}
          onClick={seekBackward}
          aria-label="Previous time step"
        >
          Back
        </button>
        <button
          type="button"
          className="mb-temporal-map__playback-toggle"
          disabled={!hasPlayableRange}
          onClick={onTogglePlayback}
          aria-pressed={isPlaying}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="mb-temporal-map__control-button"
          disabled={!canSeekForward}
          onClick={seekForward}
          aria-label="Next time step"
        >
          Next
        </button>
        <button
          type="button"
          className="mb-temporal-map__control-button"
          disabled={!canSeekForward}
          onClick={seekToEnd}
          aria-label="Jump to end"
        >
          End
        </button>
      </div>
      <div className="mb-temporal-map__axis">
        <span className="mb-temporal-map__axis-boundary">
          {timeRange ? formatTimeLabel(timeRange.start) : "-"}
        </span>
        <input
          aria-label={timelineLabel}
          className="mb-temporal-map__slider"
          disabled={!canSeek}
          max={timeRange?.end ?? 0}
          min={timeRange?.start ?? 0}
          onChange={handleSliderChange}
          step={timeStep}
          type="range"
          value={activeTime}
        />
        <span className="mb-temporal-map__axis-boundary">
          {timeRange ? formatTimeLabel(timeRange.end) : "-"}
        </span>
      </div>
    </div>
  );
}

function getSeekIncrement(timeRange: TemporalMapTimeRange | null, timeStep: number | "any") {
  if (typeof timeStep === "number" && Number.isFinite(timeStep) && timeStep > 0) {
    return timeStep;
  }

  if (!timeRange || timeRange.end <= timeRange.start) {
    return 1;
  }

  return Math.max((timeRange.end - timeRange.start) / 100, 1);
}
