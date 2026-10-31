import type { MapPoint, TemporalGeoJsonGeometryFeatureCollection } from "@moritzbrantner/maps";

import type { DemoPointGeoJsonProperties, DemoPointProperties } from "../types";

const demoPointFeatureCollection: TemporalGeoJsonGeometryFeatureCollection<DemoPointGeoJsonProperties> =
  {
    features: [
      pointFeature("berlin", "Berlin", "DACH", 52.52, 13.405, 940),
      pointFeature("hamburg", "Hamburg", "DACH", 53.551, 9.9937, 420),
      pointFeature("munich", "Munich", "DACH", 48.1351, 11.582, 610),
      pointFeature("cologne", "Cologne", "DACH", 50.9375, 6.9603, 350),
      pointFeature("zurich", "Zurich", "DACH", 47.3769, 8.5417, 520),
      pointFeature("vienna", "Vienna", "DACH", 48.2082, 16.3738, 560),
      pointFeature("paris", "Paris", "West", 48.8566, 2.3522, 880),
      pointFeature("london", "London", "West", 51.5072, -0.1276, 910),
      pointFeature("amsterdam", "Amsterdam", "West", 52.3676, 4.9041, 470),
      pointFeature("brussels", "Brussels", "West", 50.8503, 4.3517, 300),
      pointFeature("madrid", "Madrid", "South", 40.4168, -3.7038, 760),
      pointFeature("barcelona", "Barcelona", "South", 41.3874, 2.1686, 690),
      pointFeature("milan", "Milan", "South", 45.4642, 9.19, 580),
      pointFeature("rome", "Rome", "South", 41.9028, 12.4964, 640),
      pointFeature("warsaw", "Warsaw", "East", 52.2297, 21.0122, 430),
      pointFeature("prague", "Prague", "East", 50.0755, 14.4378, 390),
      pointFeature("copenhagen", "Copenhagen", "North", 55.6761, 12.5683, 330),
      pointFeature("stockholm", "Stockholm", "North", 59.3293, 18.0686, 370),
      pointFeature("oslo", "Oslo", "North", 59.9139, 10.7522, 280),
      pointFeature("helsinki", "Helsinki", "North", 60.1699, 24.9384, 260),
    ],
    type: "FeatureCollection",
  };

export const demoPointHubs = createDemoPointsFromGeoJson(demoPointFeatureCollection);
export const demoTemperaturePoints: Array<MapPoint<DemoPointProperties>> = [
  // Open-Meteo Historical Weather API, daily mean 2m temperature, 2025-07-15 UTC.
  temperaturePoint("reykjavik", "Reykjavik", "North", 64.1466, -21.9426, 14.3),
  temperaturePoint("dublin", "Dublin", "West", 53.3498, -6.2603, 15.8),
  temperaturePoint("belfast", "Belfast", "West", 54.5973, -5.9301, 14.9),
  temperaturePoint("glasgow", "Glasgow", "West", 55.8642, -4.2518, 13.9),
  temperaturePoint("london", "London", "West", 51.5072, -0.1276, 18.5),
  temperaturePoint("manchester", "Manchester", "West", 53.4808, -2.2426, 15.6),
  temperaturePoint("amsterdam", "Amsterdam", "West", 52.3676, 4.9041, 18.7),
  temperaturePoint("brussels", "Brussels", "West", 50.8503, 4.3517, 19.3),
  temperaturePoint("luxembourg", "Luxembourg", "West", 49.6116, 6.1319, 18.6),
  temperaturePoint("paris", "Paris", "West", 48.8566, 2.3522, 20.9),
  temperaturePoint("strasbourg", "Strasbourg", "West", 48.5734, 7.7521, 21.3),
  temperaturePoint("nantes", "Nantes", "West", 47.2184, -1.5536, 19.4),
  temperaturePoint("bordeaux", "Bordeaux", "West", 44.8378, -0.5792, 22.1),
  temperaturePoint("lyon", "Lyon", "West", 45.764, 4.8357, 22.6),
  temperaturePoint("marseille", "Marseille", "South", 43.2965, 5.3698, 26.8),
  temperaturePoint("nice", "Nice", "South", 43.7102, 7.262, 23.7),
  temperaturePoint("porto", "Porto", "South", 41.1579, -8.6291, 23.4),
  temperaturePoint("lisbon", "Lisbon", "South", 38.7223, -9.1393, 25.9),
  temperaturePoint("madrid", "Madrid", "South", 40.4168, -3.7038, 30.4),
  temperaturePoint("barcelona", "Barcelona", "South", 41.3874, 2.1686, 25.7),
  temperaturePoint("valencia", "Valencia", "South", 39.4699, -0.3763, 27.1),
  temperaturePoint("seville", "Seville", "South", 37.3891, -5.9845, 31.2),
  temperaturePoint("milan", "Milan", "South", 45.4642, 9.19, 27.3),
  temperaturePoint("venice", "Venice", "South", 45.4408, 12.3155, 25.1),
  temperaturePoint("rome", "Rome", "South", 41.9028, 12.4964, 27.7),
  temperaturePoint("naples", "Naples", "South", 40.8518, 14.2681, 27.3),
  temperaturePoint("palermo", "Palermo", "South", 38.1157, 13.3615, 27.4),
  temperaturePoint("zurich", "Zurich", "DACH", 47.3769, 8.5417, 19.7),
  temperaturePoint("geneva", "Geneva", "DACH", 46.2044, 6.1432, 21.4),
  temperaturePoint("vienna", "Vienna", "DACH", 48.2082, 16.3738, 23.8),
  temperaturePoint("innsbruck", "Innsbruck", "DACH", 47.2692, 11.4041, 19.8),
  temperaturePoint("munich", "Munich", "DACH", 48.1351, 11.582, 18.5),
  temperaturePoint("berlin", "Berlin", "DACH", 52.52, 13.405, 18.6),
  temperaturePoint("hamburg", "Hamburg", "DACH", 53.5511, 9.9937, 17.6),
  temperaturePoint("copenhagen", "Copenhagen", "North", 55.6761, 12.5683, 17.7),
  temperaturePoint("oslo", "Oslo", "North", 59.9139, 10.7522, 20.5),
  temperaturePoint("bergen", "Bergen", "North", 60.3913, 5.3221, 19.1),
  temperaturePoint("stockholm", "Stockholm", "North", 59.3293, 18.0686, 18.7),
  temperaturePoint("gothenburg", "Gothenburg", "North", 57.7089, 11.9746, 18.7),
  temperaturePoint("helsinki", "Helsinki", "North", 60.1699, 24.9384, 21.3),
  temperaturePoint("tallinn", "Tallinn", "North", 59.437, 24.7536, 18.7),
  temperaturePoint("riga", "Riga", "North", 56.9496, 24.1052, 19.2),
  temperaturePoint("vilnius", "Vilnius", "East", 54.6872, 25.2797, 18.9),
  temperaturePoint("warsaw", "Warsaw", "East", 52.2297, 21.0122, 20.9),
  temperaturePoint("krakow", "Krakow", "East", 50.0647, 19.945, 21.2),
  temperaturePoint("prague", "Prague", "East", 50.0755, 14.4378, 20.8),
  temperaturePoint("bratislava", "Bratislava", "East", 48.1486, 17.1077, 25),
  temperaturePoint("budapest", "Budapest", "East", 47.4979, 19.0402, 26.2),
  temperaturePoint("ljubljana", "Ljubljana", "South", 46.0569, 14.5058, 23),
  temperaturePoint("zagreb", "Zagreb", "South", 45.815, 15.9819, 24.9),
  temperaturePoint("belgrade", "Belgrade", "South", 44.7866, 20.4489, 25.4),
  temperaturePoint("sarajevo", "Sarajevo", "South", 43.8563, 18.4131, 22.7),
  temperaturePoint("podgorica", "Podgorica", "South", 42.4304, 19.2594, 29),
  temperaturePoint("tirana", "Tirana", "South", 41.3275, 19.8187, 26.8),
  temperaturePoint("skopje", "Skopje", "South", 41.9981, 21.4254, 27.5),
  temperaturePoint("sofia", "Sofia", "South", 42.6977, 23.3219, 24.1),
  temperaturePoint("thessaloniki", "Thessaloniki", "South", 40.6401, 22.9444, 30.7),
  temperaturePoint("athens", "Athens", "South", 37.9838, 23.7275, 30.8),
  temperaturePoint("istanbul", "Istanbul", "South", 41.0082, 28.9784, 26.9),
  temperaturePoint("izmir", "Izmir", "South", 38.4237, 27.1428, 32.5),
  temperaturePoint("bucharest", "Bucharest", "East", 44.4268, 26.1025, 29),
  temperaturePoint("cluj", "Cluj-Napoca", "East", 46.7712, 23.6236, 23.6),
  temperaturePoint("chisinau", "Chisinau", "East", 47.0105, 28.8638, 25.4),
  temperaturePoint("lviv", "Lviv", "East", 49.8397, 24.0297, 21.1),
  temperaturePoint("kyiv", "Kyiv", "East", 50.4501, 30.5234, 26),
  temperaturePoint("minsk", "Minsk", "East", 53.9006, 27.559, 19.6),
  temperaturePoint("valletta", "Valletta", "South", 35.8989, 14.5146, 28.2),
];
export const demoTemperatureDomainBounds = [-25, 34, 35, 66] as const;
export const demoTemperatureValueDomain = [12, 34] as const;
export const demoTemperatureFieldColorRamp = [
  [0, "#1d4ed8"],
  [0.22, "#38bdf8"],
  [0.42, "#22c55e"],
  [0.62, "#fde047"],
  [0.8, "#fb923c"],
  [1, "#dc2626"],
] as const;
export const demoPoints = createDenseDemoPoints(demoPointHubs);

export const demoRegions = ["DACH", "West", "South", "East", "North"];

function pointFeature(
  id: string,
  city: string,
  region: string,
  latitude: number,
  longitude: number,
  demand: number,
): TemporalGeoJsonGeometryFeatureCollection<DemoPointGeoJsonProperties>["features"][number] {
  return {
    geometry: {
      coordinates: [longitude, latitude],
      type: "Point",
    },
    id,
    properties: {
      city,
      demand,
      label: city,
      region,
    },
    type: "Feature",
  };
}

function createDemoPointsFromGeoJson(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoPointGeoJsonProperties>,
): Array<MapPoint<DemoPointProperties>> {
  return collection.features.flatMap((feature, index) => {
    if (feature.geometry?.type !== "Point") {
      return [];
    }

    const [longitude, latitude] = feature.geometry.coordinates;
    const id = String(feature.id ?? feature.properties?.label ?? `point-${index}`);
    const label = feature.properties?.label ?? id;
    const region = feature.properties?.region ?? "Other";
    const city = feature.properties?.city ?? label;
    const demand = feature.properties?.demand ?? 1;

    return [point(id, label, region, latitude, longitude, demand, city)];
  });
}

export function point(
  id: string,
  city: string,
  region: string,
  latitude: number,
  longitude: number,
  demand: number,
  propertyCity = city,
): MapPoint<DemoPointProperties> {
  return {
    id,
    label: city,
    latitude,
    longitude,
    metrics: { demand },
    properties: { city: propertyCity, region },
  };
}

function temperaturePoint(
  id: string,
  city: string,
  region: string,
  latitude: number,
  longitude: number,
  temperature: number,
): MapPoint<DemoPointProperties> {
  return {
    id: `temperature-${id}`,
    label: city,
    latitude,
    longitude,
    metrics: { temperature },
    properties: { city, region },
  };
}

function createDenseDemoPoints(
  hubs: Array<MapPoint<DemoPointProperties>>,
): Array<MapPoint<DemoPointProperties>> {
  return hubs.flatMap((hub) => [
    hub,
    ...Array.from({ length: 18 }, (_, index) => {
      const ring = Math.floor(index / 6) + 1;
      const step = index % 6;
      const angle = ((step * 60 + ring * 17) * Math.PI) / 180;
      const radius = 0.12 * ring + (step % 3) * 0.025;
      const latitude = hub.latitude + Math.sin(angle) * radius;
      const longitudeScale = Math.max(Math.cos((hub.latitude * Math.PI) / 180), 0.35);
      const longitude = hub.longitude + (Math.cos(angle) * radius) / longitudeScale;
      const demand = Math.max(12, Math.round((hub.metrics?.demand ?? 120) * (0.16 + ring * 0.035)));
      const placeNumber = String(index + 1).padStart(2, "0");

      return point(
        `${hub.id}-area-${placeNumber}`,
        `${hub.properties?.city ?? hub.label} area ${placeNumber}`,
        hub.properties?.region ?? "Other",
        Number(latitude.toFixed(4)),
        Number(longitude.toFixed(4)),
        demand,
      );
    }),
  ]);
}
