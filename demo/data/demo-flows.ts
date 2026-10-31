import type { MapFlow, TemporalGeoJsonGeometryFeatureCollection } from "@moritzbrantner/maps";

import type { DemoFlowGeoJsonProperties } from "../types";

const demoFlowFeatureCollection: TemporalGeoJsonGeometryFeatureCollection<DemoFlowGeoJsonProperties> =
  {
    features: [
      flowFeature("berlin-paris", "Berlin to Paris", [13.405, 52.52], [2.3522, 48.8566], 180),
      flowFeature("berlin-london", "Berlin to London", [13.405, 52.52], [-0.1276, 51.5072], 145),
      flowFeature(
        "hamburg-stockholm",
        "Hamburg to Stockholm",
        [9.9937, 53.551],
        [18.0686, 59.3293],
        82,
      ),
      flowFeature("munich-milan", "Munich to Milan", [11.582, 48.1351], [9.19, 45.4642], 120),
      flowFeature("vienna-prague", "Vienna to Prague", [16.3738, 48.2082], [14.4378, 50.0755], 96),
      flowFeature(
        "madrid-barcelona",
        "Madrid to Barcelona",
        [-3.7038, 40.4168],
        [2.1686, 41.3874],
        165,
      ),
      flowFeature(
        "amsterdam-brussels",
        "Amsterdam to Brussels",
        [4.9041, 52.3676],
        [4.3517, 50.8503],
        74,
      ),
    ],
    type: "FeatureCollection",
  };

export const demoFlows = createDemoFlowsFromGeoJson(demoFlowFeatureCollection);

function flow(
  id: string,
  label: string,
  from: [longitude: number, latitude: number],
  to: [longitude: number, latitude: number],
  trips: number,
): MapFlow {
  return {
    from,
    id,
    label,
    metrics: { trips },
    to,
  };
}

function flowFeature(
  id: string,
  label: string,
  from: [longitude: number, latitude: number],
  to: [longitude: number, latitude: number],
  trips: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoFlowGeoJsonProperties>["features"][number] {
  return {
    geometry: {
      coordinates: [from, to],
      type: "LineString",
    },
    id,
    properties: {
      label,
      trips,
    },
    type: "Feature",
  };
}

function createDemoFlowsFromGeoJson(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoFlowGeoJsonProperties>,
): MapFlow[] {
  return collection.features.flatMap((feature, index) => {
    if (feature.geometry?.type !== "LineString" || feature.geometry.coordinates.length < 2) {
      return [];
    }

    const coordinates = feature.geometry.coordinates;
    const id = String(feature.id ?? feature.properties?.label ?? `flow-${index}`);
    const from = coordinates[0]!;
    const to = coordinates.at(-1)!;

    return [flow(id, feature.properties?.label ?? id, from, to, feature.properties?.trips ?? 1)];
  });
}
