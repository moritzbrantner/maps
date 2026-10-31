import type {
  MapViewState,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
  TemporalMapTrack,
} from "@moritzbrantner/maps";

import type { DemoGeoJsonProperties, DemoTimelineProperties, DemoTimelineStop } from "../types";

export const demoTimelineViewState: MapViewState = {
  center: [8.8, 51.0],
  zoom: 4.2,
};

export const demoTracks: Array<TemporalMapTrack<DemoTimelineProperties>> = [
  routeTrack("north-sea-freight", "North sea freight", [
    timelineStop(0, "London", 51.5072, -0.1276, 70, 2, "loading"),
    timelineStop(30, "Amsterdam", 52.3676, 4.9041, 110, 5, "handoff"),
    timelineStop(60, "Hamburg", 53.551, 9.9937, 150, 7, "in-transit"),
    timelineStop(90, "Copenhagen", 55.6761, 12.5683, 130, 4, "handoff"),
    timelineStop(120, "Stockholm", 59.3293, 18.0686, 90, 1, "arrived"),
  ]),
  routeTrack("alpine-express", "Alpine express", [
    timelineStop(0, "Milan", 45.4642, 9.19, 80, 1, "loading"),
    timelineStop(30, "Zurich", 47.3769, 8.5417, 120, 3, "handoff"),
    timelineStop(60, "Munich", 48.1351, 11.582, 180, 8, "in-transit"),
    timelineStop(90, "Vienna", 48.2082, 16.3738, 140, 4, "handoff"),
    timelineStop(120, "Prague", 50.0755, 14.4378, 100, 2, "arrived"),
  ]),
  routeTrack("iberia-connector", "Iberia connector", [
    timelineStop(0, "Lisbon", 38.7223, -9.1393, 95, 0, "loading"),
    timelineStop(30, "Madrid", 40.4168, -3.7038, 130, 2, "handoff"),
    timelineStop(60, "Barcelona", 41.3874, 2.1686, 165, 6, "in-transit"),
    timelineStop(90, "Marseille", 43.2965, 5.3698, 125, 3, "handoff"),
    timelineStop(120, "Paris", 48.8566, 2.3522, 150, 1, "arrived"),
  ]),
  routeTrack("baltic-relay", "Baltic relay", [
    timelineStop(0, "Warsaw", 52.2297, 21.0122, 76, 2, "loading"),
    timelineStop(30, "Gdansk", 54.352, 18.6466, 92, 3, "handoff"),
    timelineStop(60, "Vilnius", 54.6872, 25.2797, 118, 5, "in-transit"),
    timelineStop(90, "Riga", 56.9496, 24.1052, 108, 4, "handoff"),
    timelineStop(120, "Helsinki", 60.1699, 24.9384, 82, 2, "arrived"),
  ]),
  routeTrack("adriatic-service", "Adriatic service", [
    timelineStop(0, "Rome", 41.9028, 12.4964, 88, 1, "loading"),
    timelineStop(30, "Bologna", 44.4949, 11.3426, 102, 3, "handoff"),
    timelineStop(60, "Venice", 45.4408, 12.3155, 135, 6, "in-transit"),
    timelineStop(90, "Ljubljana", 46.0569, 14.5058, 118, 4, "handoff"),
    timelineStop(120, "Budapest", 47.4979, 19.0402, 96, 2, "arrived"),
  ]),
];

export const demoTimelineKeyframeCount = demoTracks.reduce(
  (total, item) => total + item.frames.length,
  0,
);

export const demoTimelineGeoJsonCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> =
  {
    features: [
      timelineGeoJsonFeature("timeline-alpine-zone", "zone", "Alpine service zone", 0, {
        coordinates: [
          [
            [6.4, 45.6],
            [12.2, 45.6],
            [12.2, 48.6],
            [6.4, 48.6],
            [6.4, 45.6],
          ],
        ],
        type: "Polygon",
      }),
      timelineGeoJsonFeature("timeline-alpine-zone", "zone", "Alpine service zone", 60, {
        coordinates: [
          [
            [5.8, 45.4],
            [13.0, 45.7],
            [12.5, 49.0],
            [6.1, 48.8],
            [5.8, 45.4],
          ],
        ],
        type: "Polygon",
      }),
      timelineGeoJsonFeature("timeline-alpine-zone", "zone", "Alpine service zone", 120, {
        coordinates: [
          [
            [7.2, 45.2],
            [14.4, 45.4],
            [14.0, 48.9],
            [7.7, 49.0],
            [7.2, 45.2],
          ],
        ],
        type: "Polygon",
      }),
      timelineGeoJsonFeature("timeline-checkpoint", "checkpoint", "Moving checkpoint", 0, {
        coordinates: [2.3522, 48.8566],
        type: "Point",
      }),
      timelineGeoJsonFeature("timeline-checkpoint", "checkpoint", "Moving checkpoint", 60, {
        coordinates: [4.3517, 50.8503],
        type: "Point",
      }),
      timelineGeoJsonFeature("timeline-checkpoint", "checkpoint", "Moving checkpoint", 120, {
        coordinates: [4.9041, 52.3676],
        type: "Point",
      }),
      timelineGeoJsonFeature("timeline-relay-pair", "relay-pair", "Atlantic relay pair", 0, {
        coordinates: [
          [-9.1393, 38.7223],
          [-3.7038, 40.4168],
        ],
        type: "MultiPoint",
      }),
      timelineGeoJsonFeature("timeline-relay-pair", "relay-pair", "Atlantic relay pair", 60, {
        coordinates: [
          [-8.6291, 41.1579],
          [2.1686, 41.3874],
        ],
        type: "MultiPoint",
      }),
      timelineGeoJsonFeature("timeline-relay-pair", "relay-pair", "Atlantic relay pair", 120, {
        coordinates: [
          [-1.5536, 47.2184],
          [2.3522, 48.8566],
        ],
        type: "MultiPoint",
      }),
      timelineGeoJsonFeature("timeline-nordic-corridor", "corridor", "Nordic winter corridor", 0, {
        coordinates: [
          [2.3522, 48.8566],
          [4.9041, 52.3676],
          [9.9937, 53.551],
        ],
        type: "LineString",
      }),
      timelineGeoJsonFeature("timeline-nordic-corridor", "corridor", "Nordic winter corridor", 60, {
        coordinates: [
          [4.9041, 52.3676],
          [9.9937, 53.551],
          [12.5683, 55.6761],
          [18.0686, 59.3293],
        ],
        type: "LineString",
      }),
      timelineGeoJsonFeature(
        "timeline-nordic-corridor",
        "corridor",
        "Nordic winter corridor",
        120,
        {
          coordinates: [
            [9.9937, 53.551],
            [12.5683, 55.6761],
            [18.0686, 59.3293],
            [24.9384, 60.1699],
          ],
          type: "LineString",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-baltic-branches",
        "branch-corridors",
        "Baltic branch corridors",
        0,
        {
          coordinates: [
            [
              [14.4378, 50.0755],
              [21.0122, 52.2297],
            ],
            [
              [16.3738, 48.2082],
              [19.0402, 47.4979],
            ],
          ],
          type: "MultiLineString",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-baltic-branches",
        "branch-corridors",
        "Baltic branch corridors",
        60,
        {
          coordinates: [
            [
              [21.0122, 52.2297],
              [25.2797, 54.6872],
            ],
            [
              [19.0402, 47.4979],
              [24.1052, 56.9496],
            ],
          ],
          type: "MultiLineString",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-baltic-branches",
        "branch-corridors",
        "Baltic branch corridors",
        120,
        {
          coordinates: [
            [
              [25.2797, 54.6872],
              [24.9384, 60.1699],
            ],
            [
              [24.1052, 56.9496],
              [18.0686, 59.3293],
            ],
          ],
          type: "MultiLineString",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-iberia-window",
        "operating-area",
        "Iberian operating window",
        0,
        {
          coordinates: [
            [
              [
                [-9.6, 37.4],
                [-3.0, 37.7],
                [-3.3, 41.2],
                [-9.4, 41.0],
                [-9.6, 37.4],
              ],
            ],
            [
              [
                [-1.2, 40.1],
                [3.0, 40.1],
                [2.7, 42.8],
                [-0.8, 42.6],
                [-1.2, 40.1],
              ],
            ],
          ],
          type: "MultiPolygon",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-iberia-window",
        "operating-area",
        "Iberian operating window",
        70,
        {
          coordinates: [
            [
              [
                [-8.8, 37.2],
                [-2.5, 38.1],
                [-2.8, 41.6],
                [-8.7, 40.9],
                [-8.8, 37.2],
              ],
            ],
            [
              [
                [0.0, 40.0],
                [3.6, 40.5],
                [3.3, 43.2],
                [0.2, 42.7],
                [0.0, 40.0],
              ],
            ],
          ],
          type: "MultiPolygon",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-iberia-window",
        "operating-area",
        "Iberian operating window",
        120,
        {
          coordinates: [
            [
              [
                [-7.8, 37.0],
                [-1.6, 38.4],
                [-2.1, 42.2],
                [-7.8, 41.4],
                [-7.8, 37.0],
              ],
            ],
            [
              [
                [0.8, 40.1],
                [4.4, 40.9],
                [4.1, 43.7],
                [0.9, 43.1],
                [0.8, 40.1],
              ],
            ],
          ],
          type: "MultiPolygon",
        },
      ),
      timelineGeoJsonFeature("timeline-mobile-depots", "checkpoint", "Mobile depots", 0, {
        coordinates: [
          [13.405, 52.52],
          [11.582, 48.1351],
          [16.3738, 48.2082],
        ],
        type: "MultiPoint",
      }),
      timelineGeoJsonFeature("timeline-mobile-depots", "checkpoint", "Mobile depots", 60, {
        coordinates: [
          [9.9937, 53.551],
          [8.5417, 47.3769],
          [14.4378, 50.0755],
        ],
        type: "MultiPoint",
      }),
      timelineGeoJsonFeature("timeline-mobile-depots", "checkpoint", "Mobile depots", 120, {
        coordinates: [
          [12.5683, 55.6761],
          [9.19, 45.4642],
          [19.0402, 47.4979],
        ],
        type: "MultiPoint",
      }),
      timelineGeoJsonFeature("timeline-rhine-spline", "corridor", "Rhine service spline", 0, {
        coordinates: [
          [7.5886, 47.5596],
          [7.4653, 50.0014],
          [6.9603, 50.9375],
        ],
        type: "LineString",
      }),
      timelineGeoJsonFeature("timeline-rhine-spline", "corridor", "Rhine service spline", 60, {
        coordinates: [
          [6.1432, 46.2044],
          [7.7521, 48.5734],
          [6.9603, 50.9375],
          [4.9041, 52.3676],
        ],
        type: "LineString",
      }),
      timelineGeoJsonFeature("timeline-rhine-spline", "corridor", "Rhine service spline", 120, {
        coordinates: [
          [5.3698, 43.2965],
          [4.8357, 45.764],
          [2.3522, 48.8566],
          [4.3517, 50.8503],
          [4.9041, 52.3676],
        ],
        type: "LineString",
      }),
      timelineGeoJsonFeature(
        "timeline-central-nested-zone",
        "operating-area",
        "Central nested service zone",
        0,
        {
          coordinates: [
            [
              [10.0, 48.0],
              [15.0, 48.2],
              [15.4, 51.5],
              [9.6, 51.2],
              [10.0, 48.0],
            ],
            [
              [11.6, 49.1],
              [13.0, 49.1],
              [13.1, 50.0],
              [11.7, 49.9],
              [11.6, 49.1],
            ],
          ],
          type: "Polygon",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-central-nested-zone",
        "operating-area",
        "Central nested service zone",
        60,
        {
          coordinates: [
            [
              [9.1, 47.6],
              [15.7, 48.0],
              [15.2, 52.0],
              [9.4, 51.4],
              [9.1, 47.6],
            ],
            [
              [11.1, 49.0],
              [13.4, 49.3],
              [12.9, 50.4],
              [11.2, 50.0],
              [11.1, 49.0],
            ],
          ],
          type: "Polygon",
        },
      ),
      timelineGeoJsonFeature(
        "timeline-central-nested-zone",
        "operating-area",
        "Central nested service zone",
        120,
        {
          coordinates: [
            [
              [8.8, 47.1],
              [16.4, 47.8],
              [15.6, 52.4],
              [9.1, 51.8],
              [8.8, 47.1],
            ],
            [
              [10.9, 48.9],
              [13.8, 49.4],
              [13.2, 50.7],
              [11.0, 50.2],
              [10.9, 48.9],
            ],
          ],
          type: "Polygon",
        },
      ),
    ],
    type: "FeatureCollection",
  };
export const demoTimelineGeographyCount = new Set(
  demoTimelineGeoJsonCollection.features.map((feature) => feature.properties?.trackId),
).size;

function timelineGeoJsonFeature(
  trackId: string,
  kind: string,
  label: string,
  time: number,
  geometry: TemporalGeoJsonSupportedGeometry,
  visible = true,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>["features"][number] {
  return {
    geometry,
    properties: {
      kind,
      label,
      time,
      trackId,
      visible,
    },
    type: "Feature",
  };
}

function timelineStop(
  time: number,
  city: string,
  latitude: number,
  longitude: number,
  demand: number,
  delayMinutes: number,
  status: DemoTimelineProperties["status"],
): DemoTimelineStop {
  return {
    city,
    demand,
    delayMinutes,
    latitude,
    longitude,
    status,
    time,
  };
}

function routeTrack(
  id: string,
  label: string,
  stops: DemoTimelineStop[],
): TemporalMapTrack<DemoTimelineProperties> {
  return {
    id,
    label,
    properties: {
      corridor: label,
      status: stops[0]?.status ?? "loading",
    },
    frames: stops.map((stop) => ({
      label: `${stop.city} ${getDemoTimelineStatusLabel(stop.status).toLowerCase()}`,
      latitude: stop.latitude,
      longitude: stop.longitude,
      metrics: {
        delayMinutes: stop.delayMinutes,
        demand: stop.demand,
      },
      properties: {
        corridor: label,
        status: stop.status,
      },
      time: stop.time,
    })),
  };
}

function getDemoTimelineStatusLabel(status: DemoTimelineProperties["status"]) {
  switch (status) {
    case "loading":
      return "Loading";
    case "in-transit":
      return "In transit";
    case "handoff":
      return "Handoff";
    case "arrived":
      return "Arrived";
  }
}

export function formatDemoTimelineTime(time: number) {
  const totalMinutes = Math.max(0, Math.round(time));
  const hours = 8 + Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
