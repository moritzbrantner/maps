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
  getMapsTemporalWasmRuntime,
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
  // Only the installed runtime selects the authority: status changes that leave it in place
  // (idle → loading → unavailable) must not re-prepare the tracks (#172 phase E).
  const temporalRuntime = useSyncExternalStore(
    subscribeMapsTemporalRuntime,
    getMapsTemporalWasmRuntime,
    getMapsTemporalWasmRuntime,
  );
  useEffect(() => {
    void ensureMapsTemporalWasm();
  }, []);
  const playbackIndex = useMemo(
    // The installed runtime selects the sampling authority.
    () => createTemporalMapPlaybackIndex(resolvedTracks),
    [resolvedTracks, temporalRuntime],
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
  // A shared clock has no time range until this map's range is registered (after the first
  // render, e.g. on a remount); its `activeTime` is then a placeholder, not the map-scoped
  // time, so nothing is sampled until the clock has a range (#172 phase E).
  const sampledTime =
    timeRange !== null && snapshot.timeRange !== null ? snapshot.activeTime : null;
  const points = useMemo(
    () => (sampledTime === null ? [] : playbackIndex.getPointsAtTime(sampledTime)),
    [playbackIndex, sampledTime],
  );
  const geoJsonOverlayCollection = useMemo(
    () =>
      sampledTime === null
        ? null
        : (overlayPlaybackIndex?.getFeatureCollectionAtTime(sampledTime) ?? null),
    [overlayPlaybackIndex, sampledTime],
  );

  return { clock, geoJsonOverlayCollection, points, resolvedTracks, snapshot };
}
