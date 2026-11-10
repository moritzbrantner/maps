"use client";

import { ClusteredMap, type ClusteredMapProps } from "./clustered-map";
import type { GeoJsonLayerProps } from "./geojson-layer";
import type { MapScopedTimelineClock } from "./map-scoped-timeline";
import { BoundTimelineControls } from "./map-scoped-timeline-react";
import { useTemporalMapState, type TemporalMapDataProps } from "./temporal-map-state";

export type TemporalClusteredMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = Omit<
  ClusteredMapProps<TProperties>,
  "points"
> &
  TemporalMapDataProps<TProperties> & {
    /** Compatibility: ignored when `timeline` is supplied. */
    autoPlay?: boolean;
    /** Compatibility: application-controlled time; ignored when `timeline` is supplied. */
    currentTime?: number;
    /** Compatibility: ignored when `timeline` is supplied. */
    defaultTime?: number;
    formatTimeLabel?: (time: number) => string;
    geoJsonOverlayProps?: Omit<GeoJsonLayerProps<TProperties>, "featureCollection">;
    /** Compatibility: ignored when `timeline` is supplied. */
    loopPlayback?: boolean;
    /** Compatibility: ignored when `timeline` is supplied. */
    onTimeChange?: (time: number) => void;
    /** Compatibility: ignored when `timeline` is supplied. */
    playbackRate?: number;
    showPlaybackControls?: boolean;
    /**
     * The Map-Scoped Timeline clock this map samples. Share one clock between maps, or drive it
     * from application time; without one the map owns a clock built from the compatibility props.
     */
    timeline?: MapScopedTimelineClock;
    /** Compatibility: ignored when `timeline` is supplied. */
    timeStep?: number | "any";
    timelineLabel?: string;
  };

const defaultNumberFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
});
const defaultDateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function TemporalClusteredMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  autoPlay,
  className,
  currentTime,
  defaultTime,
  formatTimeLabel = defaultFormatTimeLabel,
  geoJson,
  geoJsonOverlay,
  geoJsonOverlayProps,
  geoJsonPlaybackOptions,
  geoJsonTrackOptions,
  geoJsonOverlayTrackOptions,
  loopPlayback,
  mapLabel = "Interactive timeline map",
  onTimeChange,
  playbackRate,
  showPlaybackControls = true,
  style,
  timeline,
  timeStep,
  timelineLabel = "Timeline",
  tracks,
  ...mapProps
}: TemporalClusteredMapProps<TProperties>) {
  const { clock, geoJsonOverlayCollection, points, snapshot } = useTemporalMapState(
    { geoJson, geoJsonOverlay, geoJsonOverlayTrackOptions, geoJsonPlaybackOptions, geoJsonTrackOptions, timeline, tracks },
    { autoPlay, currentTime, defaultTime, loopPlayback, onTimeChange, playbackRate, timeStep },
  );

  return (
    <div className={joinClassNames("mb-temporal-map", className)}>
      <ClusteredMap
        {...mapProps}
        className="mb-temporal-map__surface"
        geoJsonOverlayCollection={geoJsonOverlayCollection ?? undefined}
        geoJsonOverlayProps={geoJsonOverlayProps}
        mapLabel={mapLabel}
        points={points}
        style={style}
      />
      {showPlaybackControls ? (
        <BoundTimelineControls
          clock={clock}
          formatTimeLabel={formatTimeLabel}
          snapshot={snapshot}
          timelineLabel={timelineLabel}
        />
      ) : null}
    </div>
  );
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
