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
