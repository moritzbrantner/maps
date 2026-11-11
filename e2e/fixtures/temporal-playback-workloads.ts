import type { TemporalMapTrack } from "../../src/temporal-points";

/**
 * Deterministic workload of `temporal-playback-journey-v1` (#172 phase E): moving point tracks
 * over Europe on one Map-Scoped Timeline, with the admission, removal and gap cases the
 * temporal semantics cover. One generator keeps the journey fixture and its browser spec on
 * identical inputs.
 */
export const TEMPORAL_JOURNEY_TRACK_COUNT = 2_000;
export const TEMPORAL_JOURNEY_KEYFRAMES = 24;
export const TEMPORAL_JOURNEY_TIME_RANGE = { end: 1_000, start: 0 } as const;

export type TemporalJourneyTrackProperties = { fleet: string };

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * `europe-courier-tracks-v1`: `count` tracks of `keyframes` keyframes each, spread by a
 * phyllotaxis around (10° E, 50° N). Every tenth track is admitted late, every tenth (offset
 * five) is removed early with an invisible final keyframe, and every seventh has a gap (an
 * invisible keyframe in the middle). `variant` turns every heading, so a replacement source
 * moves every surviving track onto a new route with new keyframe objects.
 */
export function createEuropeCourierTracks(
  count = TEMPORAL_JOURNEY_TRACK_COUNT,
  keyframes = TEMPORAL_JOURNEY_KEYFRAMES,
  variant = 0,
): TemporalMapTrack<TemporalJourneyTrackProperties>[] {
  const { end, start } = TEMPORAL_JOURNEY_TIME_RANGE;
  const tracks: TemporalMapTrack<TemporalJourneyTrackProperties>[] = [];

  for (let index = 0; index < count; index += 1) {
    const radius = Math.sqrt((index + 0.5) / count);
    const angle = index * GOLDEN_ANGLE;
    const longitude = 10 + Math.cos(angle) * radius * 14;
    const latitude = 50 + Math.sin(angle) * radius * 7;
    const heading = angle * 0.37 + variant * 0.9;
    const speed = 0.02 + (index % 13) * 0.004;
    const admitted = index % 10 === 0 ? 150 + (index % 7) * 50 : start;
    const removed = index % 10 === 5 ? 600 + (index % 9) * 40 : end;
    const step = (removed - admitted) / (keyframes - 1);
    const frames = [];

    for (let frame = 0; frame < keyframes; frame += 1) {
      const time = admitted + frame * step;
      const progress = time - admitted;
      const turn = heading + Math.sin(progress / 140 + index) * 0.6;
      frames.push({
        latitude: latitude + Math.sin(turn) * speed * progress * 0.05,
        longitude: longitude + Math.cos(turn) * speed * progress * 0.08,
        time,
        visible:
          (removed < end && frame === keyframes - 1) ||
          (index % 7 === 3 && frame === Math.floor(keyframes / 2))
            ? false
            : undefined,
      });
    }

    tracks.push({
      frames,
      id: `courier-${index}`,
      label: `Courier ${index}`,
      properties: { fleet: `fleet-${index % 6}` },
    });
  }

  return tracks;
}

/** Static regions: a 6 × 8 grid of polygons over the tracks, kept by identity. */
export function createStaticRegionGrid(): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];

  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const west = -4 + column * 3.6;
      const south = 43 + row * 2.4;
      features.push({
        geometry: {
          coordinates: [
            [
              [west, south],
              [west + 3.2, south],
              [west + 3.2, south + 2.1],
              [west, south + 2.1],
              [west, south],
            ],
          ],
          type: "Polygon",
        },
        id: `region-${row}-${column}`,
        properties: {},
        type: "Feature",
      });
    }
  }

  return { features, type: "FeatureCollection" };
}
