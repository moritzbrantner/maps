"use client";

import { useMemo } from "react";

import {
  getHeatMapMaxWeight,
  HeatMap,
  type HeatMapProps,
  type HeatMapWeightOptions,
} from "./heat-map";
import type { GeoJsonLayerProps } from "./geojson-layer";
import type { MapScopedTimelineClock } from "./map-scoped-timeline";
import { BoundTimelineControls } from "./map-scoped-timeline-react";
import { useTemporalMapState, type TemporalMapDataProps } from "./temporal-map-state";
import type { TemporalMapTrack } from "./temporal-points";

export type TemporalHeatMapProps<TProperties extends Record<string, unknown> = Record<string, unknown>> = Omit<
  HeatMapProps<TProperties>,
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
    preserveTemporalScale?: boolean;
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

export function TemporalHeatMap<TProperties extends Record<string, unknown> = Record<string, unknown>>({
  autoPlay,
  className,
  currentTime,
  defaultTime,
  filterPoint,
  formatTimeLabel = defaultFormatTimeLabel,
  geoJson,
  geoJsonOverlay,
  geoJsonOverlayProps,
  geoJsonPlaybackOptions,
  geoJsonTrackOptions,
  geoJsonOverlayTrackOptions,
  getWeight,
  loopPlayback,
  mapLabel = "Interactive temporal heat map",
  maxWeight,
  onTimeChange,
  playbackRate,
  preserveTemporalScale = true,
  showPlaybackControls = true,
  style,
  timeline,
  timeStep,
  timelineLabel = "Timeline",
  tracks,
  weightMetric,
  ...mapProps
}: TemporalHeatMapProps<TProperties>) {
  const { clock, geoJsonOverlayCollection, points, resolvedTracks, snapshot } = useTemporalMapState(
    { geoJson, geoJsonOverlay, geoJsonOverlayTrackOptions, geoJsonPlaybackOptions, geoJsonTrackOptions, timeline, tracks },
    { autoPlay, currentTime, defaultTime, loopPlayback, onTimeChange, playbackRate, timeStep },
  );
  const temporalMaxWeight = useMemo(() => {
    if (!preserveTemporalScale || maxWeight !== undefined) {
      return undefined;
    }

    return getTemporalHeatMapMaxWeight(resolvedTracks, {
      filterPoint,
      getWeight,
      weightMetric,
    });
  }, [filterPoint, getWeight, maxWeight, preserveTemporalScale, resolvedTracks, weightMetric]);

  return (
    <div className={joinClassNames("mb-temporal-map", className)}>
      <HeatMap
        {...mapProps}
        className="mb-temporal-map__surface"
        filterPoint={filterPoint}
        geoJsonOverlayCollection={geoJsonOverlayCollection ?? undefined}
        geoJsonOverlayProps={geoJsonOverlayProps}
        getWeight={getWeight}
        mapLabel={mapLabel}
        maxWeight={maxWeight ?? temporalMaxWeight}
        points={points}
        style={style}
        weightMetric={weightMetric}
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

export function getTemporalHeatMapMaxWeight<TProperties extends Record<string, unknown> = Record<string, unknown>>(
  tracks: readonly TemporalMapTrack<TProperties>[],
  options: Omit<HeatMapWeightOptions<TProperties>, "maxWeight"> = {},
) {
  return Math.max(
    0,
    ...tracks.flatMap((track, trackIndex) =>
      track.frames
        .filter((frame) => frame.visible !== false)
        .map((frame) =>
          getHeatMapMaxWeight(
            [
              {
                id: track.id ?? trackIndex,
                label: frame.label ?? track.label ?? "",
                latitude: frame.latitude,
                longitude: frame.longitude,
                metrics: {
                  ...track.metrics,
                  ...frame.metrics,
                },
                properties: {
                  ...(track.properties as Record<string, unknown> | undefined),
                  ...(frame.properties as Record<string, unknown> | undefined),
                } as TProperties,
              },
            ],
            options,
          ),
        ),
    ),
  );
}

function defaultFormatTimeLabel(value: number) {
  if (Math.abs(value) > 10_000_000_000) {
    return defaultDateTimeFormatter.format(new Date(value));
  }

  return defaultNumberFormatter.format(value);
}

function joinClassNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}
