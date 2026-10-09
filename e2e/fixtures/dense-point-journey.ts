// The deterministic dense-point camera journey (#155, #197). One definition serves the
// retained-point acceptance spec (O(1) counters) and the comparative interaction lab
// (Maps retained path against MapLibre and Leaflet), so both measure the same workload.

export type DensePoint = { id: string; latitude: number; longitude: number };

export type DensePointCamera = {
  bearing: number;
  center: [number, number];
  pitch: number;
  zoom: number;
};

/** Where every dense-point journey starts: central Europe, inside the point spread. */
export const DENSE_POINT_VIEW: DensePointCamera = {
  bearing: 0,
  center: [12, 50],
  pitch: 0,
  zoom: 5,
};

/** Camera steps per point count; SwiftShader rasterizes 100k instances slowly. */
export const DENSE_POINT_JOURNEY_STEPS = { 10_000: 40, 100_000: 12 } as const;

export function densePointJourneySteps(count: number): number {
  return (DENSE_POINT_JOURNEY_STEPS as Record<number, number>)[count] ?? 40;
}

/** Deterministic spread over Europe: a large static dataset, not a visual pattern. */
export function densePoints(count: number): DensePoint[] {
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  return Array.from({ length: count }, (_, index) => ({
    id: `d-${index}`,
    latitude: 40 + random() * 20,
    longitude: -5 + random() * 35,
  }));
}

/**
 * Pan, zoom, bearing and pitch changes over the dense area. `pitched: false` keeps every
 * step flat (for retained shapes, which stay on unpitched cameras).
 */
export function densePointJourney(
  steps: number,
  { pitched = true }: { pitched?: boolean } = {},
): DensePointCamera[] {
  return Array.from({ length: steps }, (_, step) => ({
    bearing: (step * 7) % 60,
    center: [12 + Math.sin(step / 6) * 3, 50 + Math.cos(step / 6) * 2],
    pitch: pitched ? (step * 3) % 40 : 0,
    zoom: 5 + (step % 10) * 0.4,
  }));
}
