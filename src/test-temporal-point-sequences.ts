import type { TemporalMapTrack } from "./temporal-points";

/**
 * #172 Correct: the deterministic point-track edge sequence, shared by the unit tests and the
 * browser parity check of the Rust/WASM sampler against `test-temporal-oracle.ts`.
 */


// Forward, exact keyframes, just around a duplicate time, past both ends, then backward jumps,
// repeats and invalid times in between: an index must not carry anything from step to step.
export const TEMPORAL_EDGE_SEQUENCE = [
  -10, 0, 10, 25, 30, 39.999, 40, 40.001, 50, 60, 70, 80, 90, 100, 110, 55, 40, 0, 100, 30, 30,
  Number.NaN, 20, Number.POSITIVE_INFINITY, 65, Number.NEGATIVE_INFINITY, 50, 99.5, 0.5, 85,
];

export const TEMPORAL_EDGE_POINT_TRACKS: TemporalMapTrack[] = [
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

/**
 * Rounds every number (and orders object keys) so independently computed samples compare
 * without float noise.
 */
export function canonicalTemporalSample<T>(value: T): T {
  if (typeof value === "number") {
    return (Number(value.toFixed(9)) + 0) as T;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalTemporalSample) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalTemporalSample(entry)]),
    ) as T;
  }

  return value;
}
