import { describe, expect, test } from "vitest";

import {
  createTemporalGeoJsonPlaybackIndex,
  createTemporalMapPlaybackIndex,
  getTemporalGeoJsonFeatureCollectionAtTime,
  getTemporalGeoJsonTimeRange,
  getTemporalMapPointsAtTime,
  getTemporalMapTimeRange,
  type TemporalGeoJsonTrack,
  type TemporalMapTrack,
} from ".";
import { sampleTemporalGeoJsonNaively, sampleTemporalPointsNaively } from "./test-temporal-oracle";

/**
 * #172 Correct: deterministic multi-step sequences over the temporal edge policy. The prepared
 * playback indexes and the one-shot samplers are compared with the independent reference
 * samplers in `test-temporal-oracle.ts` at every step.
 */

// Forward, exact keyframes, just around a duplicate time, past both ends, then backward jumps,
// repeats and invalid times in between: an index must not carry anything from step to step.
const SEQUENCE = [
  -10, 0, 10, 25, 30, 39.999, 40, 40.001, 50, 60, 70, 80, 90, 100, 110, 55, 40, 0, 100, 30, 30,
  Number.NaN, 20, Number.POSITIVE_INFINITY, 65, Number.NEGATIVE_INFINITY, 50, 99.5, 0.5, 85,
];

/** Rounds every number so independently computed samples compare without float noise. */
function rounded<T>(value: T): T {
  if (typeof value === "number") {
    return (Number(value.toFixed(9)) + 0) as T;
  }

  if (Array.isArray(value)) {
    return value.map(rounded) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rounded(entry)]),
    ) as T;
  }

  return value;
}

const POINT_TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 10, longitude: 20, metrics: { load: 2 }, properties: { phase: "out" }, time: 0 },
      { latitude: 30, longitude: 60, metrics: { load: 6, stops: 4 }, properties: { phase: "back" }, time: 100 },
    ],
    id: "steady",
    label: "Steady",
    metrics: { capacity: 9 },
    properties: { fleet: "north" },
  },
  {
    // Keyframes are declared out of order.
    frames: [
      { latitude: 0, longitude: 80, time: 90 },
      { label: "Early", latitude: 5, longitude: 5, time: 10 },
      { latitude: 40, longitude: 40, time: 50 },
    ],
    id: "unsorted",
  },
  {
    // Two keyframes share time 40: an instantaneous jump.
    frames: [
      { latitude: 0, longitude: 0, time: 0 },
      { latitude: 10, longitude: 10, time: 40 },
      { latitude: -20, longitude: 50, time: 40 },
      { latitude: -20, longitude: 90, time: 80 },
    ],
    id: "duplicate",
  },
  {
    // Hidden from 30, admitted again at 50, removed for good at 70.
    frames: [
      { latitude: 1, longitude: 1, time: 0 },
      { latitude: 2, longitude: 2, time: 30, visible: false },
      { latitude: 3, longitude: 3, time: 50 },
      { latitude: 4, longitude: 4, time: 70, visible: false },
    ],
    id: "gap",
  },
  { frames: [{ latitude: 7, longitude: 7, time: 25 }], id: "single" },
  { frames: [], id: "empty" },
  {
    frames: [
      { latitude: 1, longitude: 1, time: Number.NaN },
      { latitude: 11, longitude: 12, time: 10 },
      { latitude: Number.POSITIVE_INFINITY, longitude: 50, time: 50 },
      { latitude: 50, longitude: Number.NaN, time: 60 },
      { latitude: 19, longitude: 28, time: 90 },
      { latitude: 0, longitude: 0, time: Number.POSITIVE_INFINITY },
    ],
    id: "invalid",
  },
  {
    frames: [{ latitude: Number.NaN, longitude: 0, time: 0 }],
    id: "all-invalid",
  },
  {
    // No id: the track's position in the source identifies it.
    frames: [
      { latitude: -5, longitude: -5, time: 20 },
      { latitude: -6, longitude: -8, time: 60 },
    ],
  },
  {
    // Eastward across the antimeridian, supplied as unwrapped longitudes.
    frames: [
      { latitude: 0, longitude: 170, time: 0 },
      { latitude: 0, longitude: 190, time: 100 },
    ],
    id: "antimeridian-unwrapped",
  },
  {
    // Wrapped longitudes are taken as supplied: this track travels west through 0°.
    frames: [
      { latitude: 0, longitude: 170, time: 0 },
      { latitude: 0, longitude: -170, time: 100 },
    ],
    id: "antimeridian-wrapped",
  },
];

function pointById(points: ReturnType<typeof getTemporalMapPointsAtTime>, id: string) {
  return points.find((point) => point.id === id) ?? null;
}

describe("temporal point edge sequences (#172)", () => {
  test("the prepared index and the one-shot sampler match the reference at every step", () => {
    const index = createTemporalMapPlaybackIndex(POINT_TRACKS);

    for (const time of SEQUENCE) {
      const expected = rounded(sampleTemporalPointsNaively(POINT_TRACKS, time));

      expect(rounded(index.getPointsAtTime(time)), `index at ${time}`).toEqual(expected);
      expect(rounded(getTemporalMapPointsAtTime(POINT_TRACKS, time)), `one-shot at ${time}`).toEqual(expected);
    }
  });

  test("a sample depends only on its time, not on the steps before it", () => {
    const index = createTemporalMapPlaybackIndex(POINT_TRACKS);

    for (const time of SEQUENCE) {
      expect(index.getPointsAtTime(time)).toEqual(
        createTemporalMapPlaybackIndex(POINT_TRACKS).getPointsAtTime(time),
      );
    }
  });

  test("endpoints and exact keyframes return the declared keyframe", () => {
    const index = createTemporalMapPlaybackIndex(POINT_TRACKS);

    expect(pointById(index.getPointsAtTime(0), "steady")).toEqual({
      id: "steady",
      label: "Steady",
      latitude: 10,
      longitude: 20,
      metrics: { capacity: 9, load: 2 },
      properties: { fleet: "north", phase: "out" },
    });
    expect(pointById(index.getPointsAtTime(100), "steady")).toMatchObject({
      latitude: 30,
      longitude: 60,
      metrics: { capacity: 9, load: 6, stops: 4 },
      properties: { fleet: "north", phase: "back" },
    });
    // Before the first keyframe the track is absent; after the last it holds.
    expect(pointById(index.getPointsAtTime(-0.001), "steady")).toBeNull();
    expect(pointById(index.getPointsAtTime(1e9), "steady")).toMatchObject({ latitude: 30, longitude: 60 });
    // Out-of-order keyframes are sampled in time order.
    expect(pointById(index.getPointsAtTime(50), "unsorted")).toMatchObject({ latitude: 40, longitude: 40 });
    expect(pointById(index.getPointsAtTime(30), "unsorted")).toMatchObject({
      label: "Early",
      latitude: 22.5,
      longitude: 22.5,
    });
  });

  test("a duplicate time is an instantaneous jump to the keyframe declared last", () => {
    const index = createTemporalMapPlaybackIndex(POINT_TRACKS);

    expect(pointById(index.getPointsAtTime(20), "duplicate")).toMatchObject({ latitude: 5, longitude: 5 });
    expect(pointById(index.getPointsAtTime(40), "duplicate")).toMatchObject({ latitude: -20, longitude: 50 });
    expect(pointById(index.getPointsAtTime(60), "duplicate")).toMatchObject({ latitude: -20, longitude: 70 });
  });

  test("empty, single-keyframe and invalid tracks follow one policy", () => {
    const index = createTemporalMapPlaybackIndex(POINT_TRACKS);
    const idsAt = (time: number) => index.getPointsAtTime(time).map((point) => point.id);

    expect(idsAt(24.999)).not.toContain("single");
    expect(pointById(index.getPointsAtTime(25), "single")).toMatchObject({ latitude: 7, longitude: 7 });
    expect(pointById(index.getPointsAtTime(100), "single")).toMatchObject({ latitude: 7, longitude: 7 });

    for (const time of SEQUENCE) {
      expect(idsAt(time)).not.toContain("empty");
      expect(idsAt(time)).not.toContain("all-invalid");
    }

    // Invalid keyframes are dropped, so the track moves straight between its valid ones.
    expect(pointById(index.getPointsAtTime(50), "invalid")).toMatchObject({ latitude: 15, longitude: 20 });
    // A track without an id keeps its source position as identity while others come and go.
    expect(idsAt(40)).toContain("8");
    expect(idsAt(10)).not.toContain("8");

    // Invalid sample times never produce features.
    expect(index.getPointsAtTime(Number.NaN)).toEqual([]);
    expect(index.getPointsAtTime(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  test("an invisible keyframe opens a gap that closes at the next visible keyframe", () => {
    const index = createTemporalMapPlaybackIndex(POINT_TRACKS);
    const visibleAt = (time: number) => pointById(index.getPointsAtTime(time), "gap") !== null;

    expect([0, 29.999, 30, 40, 49.999, 50, 60, 69.999, 70, 100].map(visibleAt)).toEqual([
      true, true, false, false, false, true, true, true, false, false,
    ]);
    // It approaches the invisible keyframe before the gap and reappears on the visible one.
    expect(pointById(index.getPointsAtTime(15), "gap")).toMatchObject({ latitude: 1.5, longitude: 1.5 });
    expect(pointById(index.getPointsAtTime(50), "gap")).toMatchObject({ latitude: 3, longitude: 3 });
  });

  test("longitudes interpolate as supplied across the antimeridian", () => {
    const index = createTemporalMapPlaybackIndex(POINT_TRACKS);
    const longitudeAt = (id: string, time: number) => pointById(index.getPointsAtTime(time), id)?.longitude;

    expect([25, 50, 75].map((time) => longitudeAt("antimeridian-unwrapped", time))).toEqual([175, 180, 185]);
    expect([25, 50, 75].map((time) => longitudeAt("antimeridian-wrapped", time))).toEqual([85, 0, -85]);
  });

  test("the time range spans valid keyframes only, visible or not", () => {
    expect(getTemporalMapTimeRange(POINT_TRACKS)).toEqual({ end: 100, start: 0 });
    expect(createTemporalMapPlaybackIndex(POINT_TRACKS).getTimeRange()).toEqual({ end: 100, start: 0 });
    expect(createTemporalMapPlaybackIndex([POINT_TRACKS[3]!]).getTimeRange()).toEqual({ end: 70, start: 0 });
    expect(createTemporalMapPlaybackIndex([POINT_TRACKS[4]!]).getTimeRange()).toEqual({ end: 25, start: 25 });
    expect(createTemporalMapPlaybackIndex([POINT_TRACKS[6]!]).getTimeRange()).toEqual({ end: 90, start: 10 });
    expect(createTemporalMapPlaybackIndex([POINT_TRACKS[5]!, POINT_TRACKS[7]!]).getTimeRange()).toBeNull();
    expect(createTemporalMapPlaybackIndex([]).getTimeRange()).toBeNull();
  });
});

function square(west: number, south: number, size: number): [number, number][][] {
  return [
    [
      [west, south],
      [west + size, south],
      [west + size, south + size],
      [west, south + size],
      [west, south],
    ],
  ];
}

const GEOJSON_TRACKS: TemporalGeoJsonTrack[] = [
  {
    frames: [
      { geometry: { coordinates: square(0, 0, 2), type: "Polygon" }, metrics: { area: 4 }, time: 0 },
      { geometry: { coordinates: square(10, 10, 6), type: "Polygon" }, metrics: { area: 36 }, time: 100 },
    ],
    id: "region",
    label: "Region",
    properties: { owner: "a" },
  },
  {
    // Declared out of order, with two keyframes at time 40.
    frames: [
      { geometry: { coordinates: [[20, 0], [30, 10]], type: "LineString" }, time: 80 },
      { geometry: { coordinates: [[0, 0], [10, 0]], type: "LineString" }, time: 0 },
      { geometry: { coordinates: [[0, 10], [10, 10]], type: "LineString" }, time: 40 },
      { geometry: { coordinates: [[0, -10], [10, -10]], type: "LineString" }, time: 40 },
    ],
    id: "route",
  },
  {
    // A point that turns into a line, then gains a vertex: both transitions hold.
    frames: [
      { geometry: { coordinates: [5, 5], type: "Point" }, time: 0 },
      { geometry: { coordinates: [15, 5], type: "Point" }, time: 30 },
      { geometry: { coordinates: [[15, 5], [25, 5]], type: "LineString" }, time: 60 },
      { geometry: { coordinates: [[15, 5], [20, 9], [25, 5]], type: "LineString" }, time: 90 },
    ],
    id: "transition",
  },
  {
    frames: [
      { geometry: { coordinates: [1, 1], type: "Point" }, time: 0 },
      { geometry: { coordinates: [2, 2], type: "Point" }, time: 30, visible: false },
      { geometry: { coordinates: [3, 3], type: "Point" }, time: 50 },
      { geometry: { coordinates: [4, 4], type: "Point" }, time: 70, visible: false },
    ],
    id: "gap",
  },
  { frames: [{ geometry: { coordinates: square(-30, -30, 1), type: "Polygon" }, time: 25 }], id: "single" },
  { frames: [], id: "empty" },
  {
    frames: [
      { geometry: { coordinates: [0, 0], type: "Point" }, time: Number.NaN },
      { geometry: { coordinates: [40, 40], type: "Point" }, time: 10 },
      { geometry: { coordinates: [60, 60], type: "Point" }, time: 90 },
    ],
    id: "invalid-time",
  },
  {
    // A region carried east across the antimeridian with unwrapped longitudes.
    frames: [
      { geometry: { coordinates: square(170, 0, 4), type: "Polygon" }, time: 0 },
      { geometry: { coordinates: square(184, 0, 4), type: "Polygon" }, time: 100 },
    ],
    id: "antimeridian",
  },
];

function featureById(collection: ReturnType<typeof getTemporalGeoJsonFeatureCollectionAtTime>, id: string) {
  return collection.features.find((feature) => feature.id === id) ?? null;
}

describe("temporal GeoJSON edge sequences (#172)", () => {
  test("the prepared index and the one-shot sampler match the reference at every step", () => {
    const index = createTemporalGeoJsonPlaybackIndex(GEOJSON_TRACKS);

    for (const time of SEQUENCE) {
      const expected = rounded(sampleTemporalGeoJsonNaively(GEOJSON_TRACKS, time));

      expect(rounded(index.getFeatureCollectionAtTime(time).features), `index at ${time}`).toEqual(expected);
      expect(
        rounded(getTemporalGeoJsonFeatureCollectionAtTime(GEOJSON_TRACKS, time).features),
        `one-shot at ${time}`,
      ).toEqual(expected);
    }
  });

  test("a sample depends only on its time and never aliases the source or an earlier sample", () => {
    const index = createTemporalGeoJsonPlaybackIndex(GEOJSON_TRACKS);
    const source = structuredClone(GEOJSON_TRACKS);

    for (const time of SEQUENCE) {
      const sample = index.getFeatureCollectionAtTime(time);
      const fresh = createTemporalGeoJsonPlaybackIndex(GEOJSON_TRACKS).getFeatureCollectionAtTime(time);

      expect(sample).toEqual(fresh);

      // A consumer editing a sample must not change the source or the next sample.
      for (const feature of sample.features) {
        (feature.geometry.coordinates as unknown[]).length = 0;
        feature.properties.metrics.tampered = 1;
      }

      expect(index.getFeatureCollectionAtTime(time)).toEqual(fresh);
    }

    expect(GEOJSON_TRACKS).toEqual(source);
  });

  test("geometry transitions interpolate matching layouts and hold everything else", () => {
    const index = createTemporalGeoJsonPlaybackIndex(GEOJSON_TRACKS);
    const geometryAt = (id: string, time: number) =>
      featureById(index.getFeatureCollectionAtTime(time), id)?.geometry ?? null;

    expect(geometryAt("region", 0)).toEqual({ coordinates: square(0, 0, 2), type: "Polygon" });
    expect(geometryAt("region", 50)).toEqual({ coordinates: square(5, 5, 4), type: "Polygon" });
    expect(geometryAt("region", 100)).toEqual({ coordinates: square(10, 10, 6), type: "Polygon" });
    expect(geometryAt("region", 500)).toEqual({ coordinates: square(10, 10, 6), type: "Polygon" });

    // Point → Point moves; Point → LineString and a changed vertex count hold the earlier shape.
    expect(geometryAt("transition", 15)).toEqual({ coordinates: [10, 5], type: "Point" });
    expect(geometryAt("transition", 45)).toEqual({ coordinates: [15, 5], type: "Point" });
    expect(geometryAt("transition", 60)).toEqual({ coordinates: [[15, 5], [25, 5]], type: "LineString" });
    expect(geometryAt("transition", 75)).toEqual({ coordinates: [[15, 5], [25, 5]], type: "LineString" });
    expect(geometryAt("transition", 90)).toEqual({
      coordinates: [[15, 5], [20, 9], [25, 5]],
      type: "LineString",
    });

    // A duplicate time jumps to the keyframe declared last, then moves on from it.
    expect(geometryAt("route", 20)).toEqual({ coordinates: [[0, 5], [10, 5]], type: "LineString" });
    expect(geometryAt("route", 40)).toEqual({ coordinates: [[0, -10], [10, -10]], type: "LineString" });
    expect(geometryAt("route", 60)).toEqual({ coordinates: [[10, -5], [20, 0]], type: "LineString" });

    // Unwrapped longitudes carry a region across the antimeridian without tearing it.
    expect(geometryAt("antimeridian", 50)).toEqual({ coordinates: square(177, 0, 4), type: "Polygon" });
  });

  test("admission, removal, gaps and degenerate tracks match the point policy", () => {
    const index = createTemporalGeoJsonPlaybackIndex(GEOJSON_TRACKS);
    const idsAt = (time: number) => index.getFeatureCollectionAtTime(time).features.map((feature) => feature.id);
    const visibleAt = (id: string, time: number) => idsAt(time).includes(id);

    expect([0, 29.999, 30, 49.999, 50, 69.999, 70, 100].map((time) => visibleAt("gap", time))).toEqual([
      true, true, false, false, true, true, false, false,
    ]);
    expect([24.999, 25, 100].map((time) => visibleAt("single", time))).toEqual([false, true, true]);
    expect([9.999, 10, 100].map((time) => visibleAt("invalid-time", time))).toEqual([false, true, true]);
    expect(SEQUENCE.some((time) => visibleAt("empty", time))).toBe(false);
    // Features keep the source order of their tracks.
    expect(idsAt(55)).toEqual(["region", "route", "transition", "gap", "single", "invalid-time", "antimeridian"]);
    expect(index.getFeatureCollectionAtTime(Number.NaN).features).toEqual([]);

    expect(getTemporalGeoJsonTimeRange(GEOJSON_TRACKS)).toEqual({ end: 100, start: 0 });
    expect(index.getTimeRange()).toEqual({ end: 100, start: 0 });
    expect(createTemporalGeoJsonPlaybackIndex([GEOJSON_TRACKS[5]!]).getTimeRange()).toBeNull();
  });
});
