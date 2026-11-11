/**
 * Representative heat/scalar workloads shared by the canonical kernel scenarios
 * (`heat-map-density-index-v1`, `scalar-field-grid-v1`, run by
 * `scripts/engine-kernel-scenarios.mjs`) and the full-map journey that mounts the same data
 * in a Map View (`heat-scalar-journey-v1`, #171 phase 5). One generator per workload keeps the
 * kernel and the journey on the same inputs.
 */

export type HeatScalarWorkloadPoint = {
  id: string;
  latitude: number;
  longitude: number;
  metrics: Record<string, number>;
};

/** `berlin-phyllotaxis-demand-v1`: a phyllotaxis spiral of demand weights 1 to 17 around Berlin. */
export function createBerlinPhyllotaxisDemandPoints(
  count: number,
): HeatScalarWorkloadPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963229728653;
    const radius = Math.sqrt(index / count);

    return {
      id: `point-${index}`,
      latitude: 52.52 + Math.sin(angle) * radius * 4,
      longitude: 13.405 + Math.cos(angle) * radius * 6,
      metrics: {
        demand: 1 + (index % 17),
      },
    };
  });
}

/** `europe-temperature-observations-v1`: ten capital-city temperature observations. */
export function createEuropeTemperatureObservations(): HeatScalarWorkloadPoint[] {
  return [
    temperaturePoint("reykjavik", 64.1466, -21.9426, 14.3),
    temperaturePoint("dublin", 53.3498, -6.2603, 15.8),
    temperaturePoint("london", 51.5072, -0.1276, 18.5),
    temperaturePoint("paris", 48.8566, 2.3522, 20.9),
    temperaturePoint("berlin", 52.52, 13.405, 21.5),
    temperaturePoint("madrid", 40.4168, -3.7038, 28.6),
    temperaturePoint("rome", 41.9028, 12.4964, 29.4),
    temperaturePoint("warsaw", 52.2297, 21.0122, 22.4),
    temperaturePoint("athens", 37.9838, 23.7275, 31.2),
    temperaturePoint("stockholm", 59.3293, 18.0686, 17.1),
  ];
}

function temperaturePoint(
  id: string,
  latitude: number,
  longitude: number,
  temperature: number,
): HeatScalarWorkloadPoint {
  return {
    id,
    latitude,
    longitude,
    metrics: {
      temperature,
    },
  };
}
