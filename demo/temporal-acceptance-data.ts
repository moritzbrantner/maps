import type { TemporalMapTrack } from "../src/temporal-points";

/** Moving tracks (#172): positions are linear in time between these keyframes. */
export const TEMPORAL_ACCEPTANCE_TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 52.2, longitude: 11.6, time: 0 },
      { latitude: 52.8, longitude: 14.4, time: 100 },
    ],
    id: "courier-north",
    label: "Courier north",
  },
  {
    frames: [
      { latitude: 50.8, longitude: 14.6, time: 0 },
      { latitude: 51.0, longitude: 11.8, time: 100 },
    ],
    id: "courier-south",
    label: "Courier south",
  },
];

/**
 * A replacement source (#172 phase B): `courier-north` survives on a new route and a shorter
 * time range, `courier-south` leaves and `courier-east` is admitted.
 */
export const TEMPORAL_ACCEPTANCE_REPLACEMENT_TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 53.2, longitude: 14.8, time: 20 },
      { latitude: 53.4, longitude: 11.2, time: 80 },
    ],
    id: "courier-north",
    label: "Courier north",
  },
  {
    frames: [
      { latitude: 50.6, longitude: 11.4, time: 20 },
      { latitude: 50.4, longitude: 14.9, time: 80 },
    ],
    id: "courier-east",
    label: "Courier east",
  },
];

/** Crosses the antimeridian eastward; the longitudes are supplied unwrapped (174° → 186°). */
export const TEMPORAL_ACCEPTANCE_ANTIMERIDIAN_TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 10, longitude: 174, time: 0 },
      { latitude: 10, longitude: 186, time: 100 },
    ],
    id: "ferry-east",
    label: "Ferry east",
  },
];

/**
 * Temporal clustering and heat (#172 phase D): three couriers converge on (13, 52) at time 50
 * and separate again; `courier-late` is admitted at time 60. At zoom 6 the converged couriers
 * form one cluster and the separated ones do not.
 */
export const TEMPORAL_COMPOSITION_TRACKS: TemporalMapTrack[] = [
  {
    frames: [
      { latitude: 52, longitude: 10, metrics: { cargo: 1 }, time: 0 },
      { latitude: 52, longitude: 16, metrics: { cargo: 1 }, time: 100 },
    ],
    id: "courier-west",
    label: "Courier west",
  },
  {
    frames: [
      { latitude: 52, longitude: 16, metrics: { cargo: 2 }, time: 0 },
      { latitude: 52, longitude: 10, metrics: { cargo: 2 }, time: 100 },
    ],
    id: "courier-east",
    label: "Courier east",
  },
  {
    frames: [
      { latitude: 50.5, longitude: 13, metrics: { cargo: 4 }, time: 0 },
      { latitude: 53.5, longitude: 13, metrics: { cargo: 4 }, time: 100 },
    ],
    id: "courier-south",
    label: "Courier south",
  },
  {
    frames: [
      { latitude: 50.8, longitude: 10.5, metrics: { cargo: 8 }, time: 60 },
      { latitude: 50.8, longitude: 11.5, metrics: { cargo: 8 }, time: 100 },
    ],
    id: "courier-late",
    label: "Courier late",
  },
];
