"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  createGeoJsonOverlayFeatureCollection,
  type GeoJsonMapSource,
  type GeoJsonOverlayMode,
} from "./geojson-source";
import type { MapScopedTimelineClock } from "./map-scoped-timeline";
import {
  useBoundMapScopedTimeline,
  type MapScopedTimelineCompatibilityProps,
} from "./map-scoped-timeline-react";
import { mergeTemporalMapTimeRanges } from "./temporal-core";
import { createTemporalMapPlaybackIndex, type TemporalMapTrack } from "./temporal-points";
import {
  ensureMapsTemporalWasm,
  getMapsTemporalRuntimeVersion,
  subscribeMapsTemporalRuntime,
} from "./temporal-points-wasm";
import { createTemporalMapTracksFromGeoJson, type TemporalGeoJsonTrackOptions } from "./temporal-geojson";
import {
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
  type TemporalGeoJsonGeometryTrackOptions,
  type TemporalGeoJsonPlaybackIndexOptions,
} from "./temporal-geojson-geometries";

export type TemporalMapDataProps<TProperties extends Record<string, unknown>> = {
  geoJson?: GeoJsonMapSource<TProperties>;
  geoJsonOverlay?: GeoJsonOverlayMode;
  geoJsonOverlayTrackOptions?: TemporalGeoJsonGeometryTrackOptions<TProperties, TProperties>;
  geoJsonPlaybackOptions?: TemporalGeoJsonPlaybackIndexOptions;
  geoJsonTrackOptions?: TemporalGeoJsonTrackOptions<TProperties, TProperties>;
  timeline?: MapScopedTimelineClock;
  tracks?: readonly TemporalMapTrack<TProperties>[];
};

/**
 * @internal The shared state of temporal Convenience Maps: data preparation is memoized on the
 * data alone, and sampling reads only the Map-Scoped Timeline's `activeTime`.
 */
export function useTemporalMapState<TProperties extends Record<string, unknown>>(
  {
    geoJson,
    geoJsonOverlay,
    geoJsonOverlayTrackOptions,
    geoJsonPlaybackOptions,
    geoJsonTrackOptions,
    timeline,
    tracks,
  }: TemporalMapDataProps<TProperties>,
  compatibility: MapScopedTimelineCompatibilityProps,
) {
  const resolvedTracks = useMemo(
    () =>
      tracks ??
      (geoJson
        ? createTemporalMapTracksFromGeoJson(
            geoJson as Parameters<typeof createTemporalMapTracksFromGeoJson<TProperties, TProperties>>[0],
            geoJsonTrackOptions,
          )
        : []),
    [geoJson, geoJsonTrackOptions, tracks],
  );
  // Rust samples moving tracks once its runtime is ready; until then the TypeScript reference
  // samples the same positions, so the rebuild on a runtime change is not observable.
  const temporalRuntimeVersion = useSyncExternalStore(
    subscribeMapsTemporalRuntime,
    getMapsTemporalRuntimeVersion,
    getMapsTemporalRuntimeVersion,
  );
  useEffect(() => {
    void ensureMapsTemporalWasm();
  }, []);
  const playbackIndex = useMemo(
    // The runtime version selects the sampling authority.
    () => createTemporalMapPlaybackIndex(resolvedTracks),
    [resolvedTracks, temporalRuntimeVersion],
  );
  const overlaySource = useMemo(
    () =>
      geoJson
        ? createGeoJsonOverlayFeatureCollection(geoJson, {
            mode: geoJsonOverlay,
            target: "point",
          })
        : null,
    [geoJson, geoJsonOverlay],
  );
  const overlayPlaybackIndex = useMemo(() => {
    if (!overlaySource || overlaySource.features.length === 0) {
      return null;
    }

    const overlayTracks = createTemporalGeoJsonTracksFromGeoJson(
      overlaySource,
      geoJsonOverlayTrackOptions ??
        (geoJsonTrackOptions as unknown as TemporalGeoJsonGeometryTrackOptions<TProperties, TProperties> | undefined),
    );

    return overlayTracks.length === 0
      ? null
      : createTemporalGeoJsonPlaybackIndex(overlayTracks, geoJsonPlaybackOptions);
  }, [geoJsonOverlayTrackOptions, geoJsonPlaybackOptions, geoJsonTrackOptions, overlaySource]);
  const timeRange = useMemo(
    () =>
      mergeTemporalMapTimeRanges(playbackIndex.getTimeRange(), overlayPlaybackIndex?.getTimeRange()),
    [overlayPlaybackIndex, playbackIndex],
  );
  const { clock, snapshot } = useBoundMapScopedTimeline(timeline, timeRange, compatibility);
  const { activeTime } = snapshot;
  const hasData = timeRange !== null;
  const points = useMemo(
    () => (hasData ? playbackIndex.getPointsAtTime(activeTime) : []),
    [activeTime, hasData, playbackIndex],
  );
  const geoJsonOverlayCollection = useMemo(
    () => overlayPlaybackIndex?.getFeatureCollectionAtTime(activeTime) ?? null,
    [activeTime, overlayPlaybackIndex],
  );

  return { clock, geoJsonOverlayCollection, points, resolvedTracks, snapshot };
}
