import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  NativeSelect,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@moritzbrantner/ui";
import {
  BubbleMap,
  BeeLineMeasurementLayer,
  BubbleLayer,
  ClusterLayer,
  ClusteredMap,
  EditableGeoJsonMap,
  FlowLayer,
  FlowMap,
  type GeoJsonLayerFeature,
  GeoJsonLayer,
  HeatLayer,
  HeatMap,
  MapView,
  PointMap,
  PointLayer,
  TemporalClusteredMap,
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
  getBoundsFromGeoJson,
  getTemporalGeoJsonFeatureCollectionAtTime,
  type MapBeeLineMeasurement,
  type MapBeeLineMeasurementResult,
  type MapFlow,
  type MapPoint,
  type HeatFieldRenderMode,
  type PointMapFeature,
  type MapViewState,
  type GeoJsonEditMode,
  type GeoJsonEditorSelection,
  type GeoJsonPolygonConstraint,
  createGeoJsonTransitionPlan,
  constrainGeoJsonGeometryToPolygon,
  interpolateGeoJsonTransitionPlan,
  type GeoJsonTopologyStrategy,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonInterpolationStrategy,
  type TemporalGeoJsonSupportedGeometry,
  type TemporalMapTrack,
  moveGeoJsonGeometry,
} from "@moritzbrantner/maps";
import {
  FlowVolumeLegend,
  renderDemoFlowPopup,
  renderDemoFlowTooltip,
} from "./components/FlowVolumeLegend";
import { demoMapStyle } from "./data/map-style";
import { formatTemperatureValue, getHeatLayerColorRamp } from "./lib/format";
import type {
  DemoDataset,
  DemoFlowGeoJsonProperties,
  DemoGeoJsonProperties,
  DemoInterpolationExample,
  DemoInterpolationGeometryPair,
  DemoInterpolationHandle,
  DemoLayerConfig,
  DemoLayerKind,
  DemoPointGeoJsonProperties,
  DemoPointProperties,
  DemoTimelineProperties,
  DemoTimelineStop,
  DemoView,
  EditablePointContext,
} from "./types";

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

const demoPointHubs = createDemoPointsFromGeoJson(demoPointFeatureCollection);
const demoTemperaturePoints: Array<MapPoint<DemoPointProperties>> = [
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
const demoTemperatureDomainBounds = [-25, 34, 35, 66] as const;
const demoTemperatureValueDomain = [12, 34] as const;
const demoTemperatureFieldColorRamp = [
  [0, "#1d4ed8"],
  [0.22, "#38bdf8"],
  [0.42, "#22c55e"],
  [0.62, "#fde047"],
  [0.8, "#fb923c"],
  [1, "#dc2626"],
] as const;
const demoPoints = createDenseDemoPoints(demoPointHubs);

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

const demoFlows = createDemoFlowsFromGeoJson(demoFlowFeatureCollection);

const demoTimelineViewState: MapViewState = {
  center: [8.8, 51.0],
  zoom: 4.2,
};

const demoTracks: Array<TemporalMapTrack<DemoTimelineProperties>> = [
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

const demoTimelineKeyframeCount = demoTracks.reduce((total, item) => total + item.frames.length, 0);

const demoTimelineGeoJsonCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> =
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
const demoTimelineGeographyCount = new Set(
  demoTimelineGeoJsonCollection.features.map((feature) => feature.properties?.trackId),
).size;

const demoGeoJsonCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> = {
  features: [
    geoJsonFeature("geojson-point", "Point", "Paris checkpoint", {
      coordinates: [2.3522, 48.8566],
      type: "Point",
    }),
    geoJsonFeature("geojson-line", "LineString", "Rhine freight corridor", {
      coordinates: [
        [7.5886, 47.5596],
        [7.4653, 50.0014],
        [6.9603, 50.9375],
        [6.7735, 51.2277],
      ],
      type: "LineString",
    }),
    geoJsonFeature("geojson-multiline", "MultiLineString", "Nordic connectors", {
      coordinates: [
        [
          [10.7522, 59.9139],
          [12.5683, 55.6761],
        ],
        [
          [18.0686, 59.3293],
          [24.9384, 60.1699],
        ],
      ],
      type: "MultiLineString",
    }),
    geoJsonFeature("geojson-polygon", "Polygon", "Alpine service zone", {
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
    geoJsonFeature("geojson-multipolygon", "MultiPolygon", "Iberian operating areas", {
      coordinates: [
        [
          [
            [-4.4, 39.5],
            [-2.8, 39.5],
            [-2.8, 41.1],
            [-4.4, 41.1],
            [-4.4, 39.5],
          ],
        ],
        [
          [
            [1.5, 40.8],
            [2.9, 40.8],
            [2.9, 42.0],
            [1.5, 42.0],
            [1.5, 40.8],
          ],
        ],
      ],
      type: "MultiPolygon",
    }),
  ],
  type: "FeatureCollection",
};

const views: Array<{ id: DemoView; label: string }> = [
  { id: "clusters", label: "Clusters" },
  { id: "points", label: "Points" },
  { id: "heat", label: "Heat" },
  { id: "flows", label: "Flows" },
  { id: "composed", label: "Composed" },
  { id: "temporal", label: "Timeline" },
  { id: "interpolation", label: "Interpolation" },
  { id: "globe", label: "Globe" },
  { id: "geojson", label: "GeoJSON" },
  { id: "editor", label: "Editor" },
];

const demoInterpolationStrategies: Array<{
  description: string;
  id: TemporalGeoJsonInterpolationStrategy;
  label: string;
}> = [
  {
    description:
      "Pairs existing coordinates one-for-one and falls back to hold when counts differ.",
    id: "compatible",
    label: "Compatible",
  },
  {
    description: "Samples lines and rings into evenly spaced coordinates before blending.",
    id: "resample",
    label: "Resample",
  },
  {
    description: "Builds a shared polygon vertex set so changing outlines keep sharper corners.",
    id: "vertex-union",
    label: "Vertex union",
  },
  {
    description: "Samples polygon rings radially around the centroid for more organic morphs.",
    id: "centroid-radial",
    label: "Centroid radial",
  },
  {
    description: "Displays the previous keyframe until the next one takes over.",
    id: "hold",
    label: "Hold",
  },
];

const demoTopologyStrategies: Array<{
  id: Exclude<GeoJsonTopologyStrategy, "bounds">;
  label: string;
}> = [
  { id: "area-overlap", label: "Area overlap" },
  { id: "voronoi-partition", label: "Voronoi partition" },
];

const demoInterpolationExamples = createDemoInterpolationExamples();
const demoInterpolationLandmassConstraint = {
  coordinates: [
    [
      [-10.2, 36.5],
      [-5.5, 36.5],
      [-2.5, 38.0],
      [1.0, 40.5],
      [5.5, 43.4],
      [10.6, 44.2],
      [17.6, 47.8],
      [24.8, 53.5],
      [21.0, 59.5],
      [12.0, 61.2],
      [3.8, 57.8],
      [-1.5, 54.8],
      [-6.5, 50.7],
      [-9.8, 45.2],
      [-10.2, 36.5],
    ],
  ],
  type: "Polygon",
} satisfies Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>;
const demoInterpolationLandmassCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> =
  {
    features: [
      {
        geometry: demoInterpolationLandmassConstraint,
        properties: {
          kind: "interpolation-constraint",
          label: "Landmass constraint",
          time: 0,
          trackId: "interpolation-constraint",
        },
        type: "Feature",
      },
    ],
    type: "FeatureCollection",
  };

const editorModes: Array<{ id: GeoJsonEditMode; label: string }> = [
  { id: "select", label: "Select" },
  { id: "draw-point", label: "Point" },
  { id: "draw-line", label: "Line" },
  { id: "draw-polygon", label: "Polygon" },
  { id: "move", label: "Move" },
  { id: "reshape", label: "Reshape" },
  { id: "delete", label: "Delete" },
];

const layerKinds: Array<{ id: DemoLayerKind; label: string }> = [
  { id: "points", label: "Points" },
  { id: "bubbles", label: "Bubbles" },
  { id: "heat", label: "Heat" },
  { id: "flows", label: "Flows" },
  { id: "clusters", label: "Clusters" },
];

const layerColors = ["#0f172a", "#0f766e", "#2563eb", "#b45309", "#be123c"];

const initialLayers: DemoLayerConfig[] = [
  {
    color: "#0f766e",
    enabled: true,
    id: "layer-heat-1",
    kind: "heat",
    name: "Heat 1",
  },
  {
    color: "#b45309",
    enabled: true,
    id: "layer-flows-1",
    kind: "flows",
    name: "Flows 1",
  },
  {
    color: "#0f172a",
    enabled: true,
    id: "layer-points-1",
    kind: "points",
    name: "Points 1",
  },
];

const demoRegions = ["DACH", "West", "South", "East", "North"];

const emptyGeoJsonEditorSelection: GeoJsonEditorSelection = {
  featureIds: [],
  primaryFeatureId: null,
  vertexHandle: null,
};

export function App() {
  const datasetQuery = useQuery({
    initialData: createDemoDataset,
    queryFn: loadDemoDataset,
    queryKey: ["maps-demo-dataset"],
    staleTime: Infinity,
  });
  const [view, setView] = useState<DemoView>("clusters");
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [heatFieldRenderMode, setHeatFieldRenderMode] =
    useState<HeatFieldRenderMode>("raster-contours");
  const [heatFieldContourLineWidth, setHeatFieldContourLineWidth] = useState(1.25);
  const [showHeatDataPoints, setShowHeatDataPoints] = useState(false);
  const [layers, setLayers] = useState<DemoLayerConfig[]>(initialLayers);
  const [measurements, setMeasurements] = useState<MapBeeLineMeasurement[]>([]);
  const [editablePoints, setEditablePoints] =
    useState<Array<MapPoint<DemoPointProperties>>>(demoPointHubs);
  const [editableGeoJson, setEditableGeoJson] = useState(demoGeoJsonCollection);
  const [editMode, setEditMode] = useState<GeoJsonEditMode>("select");
  const [geoJsonSelection, setGeoJsonSelection] = useState<GeoJsonEditorSelection>(
    emptyGeoJsonEditorSelection,
  );
  const selectedGeoJsonId = geoJsonSelection.primaryFeatureId;
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [temporalTime, setTemporalTime] = useState(0);
  const [viewport, setViewport] = useState<MapViewState>({
    center: [13.405, 52.52],
    zoom: 5,
  });
  const dataset = datasetQuery.data;
  const visiblePoints = useMemo(
    () =>
      selectedRegion === "all"
        ? dataset.points
        : dataset.points.filter((item) => item.properties?.region === selectedRegion),
    [dataset.points, selectedRegion],
  );
  const visibleEditablePoints = useMemo(
    () =>
      selectedRegion === "all"
        ? editablePoints
        : editablePoints.filter((item) => item.properties?.region === selectedRegion),
    [editablePoints, selectedRegion],
  );
  const activeInspectorPoints = view === "points" ? visibleEditablePoints : visiblePoints;
  const addLayer = (kind: DemoLayerKind) => {
    setLayers((current) => {
      const nextNumber = current.filter((layer) => layer.kind === kind).length + 1;
      const color = layerColors[current.length % layerColors.length];

      return [
        ...current,
        {
          color,
          enabled: true,
          id: `layer-${kind}-${Date.now()}-${current.length}`,
          kind,
          name: `${getLayerKindLabel(kind)} ${nextNumber}`,
        },
      ];
    });
  };
  const updateLayer = (id: string, patch: Partial<DemoLayerConfig>) => {
    setLayers((current) =>
      current.map((layer) =>
        layer.id === id
          ? {
              ...layer,
              ...patch,
              name:
                patch.kind && patch.kind !== layer.kind
                  ? getLayerKindLabel(patch.kind)
                  : layer.name,
            }
          : layer,
      ),
    );
  };
  const removeLayer = (id: string) => {
    setLayers((current) => current.filter((layer) => layer.id !== id));
  };
  const createEditablePoint = (coordinates: [longitude: number, latitude: number]) => {
    const id = `custom-${Date.now()}`;

    setEditablePoints((current) => [
      ...current,
      point(
        id,
        `Custom point ${current.filter((item) => String(item.id).startsWith("custom-")).length + 1}`,
        selectedRegion === "all" ? "DACH" : selectedRegion,
        Number(coordinates[1].toFixed(4)),
        Number(coordinates[0].toFixed(4)),
        120,
      ),
    ]);
    setSelectedPointId(id);
  };
  const moveEditablePoint = (
    feature: PointMapFeature<DemoPointProperties>,
    coordinates: [longitude: number, latitude: number],
  ) => {
    setEditablePoints((current) =>
      current.map((item) =>
        String(item.id) === feature.point.id
          ? {
              ...item,
              latitude: Number(coordinates[1].toFixed(4)),
              longitude: Number(coordinates[0].toFixed(4)),
            }
          : item,
      ),
    );
  };
  const deleteEditablePoint = (feature: PointMapFeature<DemoPointProperties>) => {
    setEditablePoints((current) => current.filter((item) => String(item.id) !== feature.point.id));
    setSelectedPointId((current) => (current === feature.point.id ? null : current));
  };
  const editablePointContext: EditablePointContext = {
    onCreatePoint: createEditablePoint,
    onDeletePoint: deleteEditablePoint,
    onMovePoint: moveEditablePoint,
    onSelectPoint: (feature) => setSelectedPointId(feature?.point.id ?? null),
    points: visibleEditablePoints,
    selectedPointId,
  };
  const selectedGeoJsonFeature = useMemo(
    () => getDemoGeoJsonFeature(editableGeoJson, selectedGeoJsonId),
    [editableGeoJson, selectedGeoJsonId],
  );
  const selectedGeoJsonLabel = selectedGeoJsonFeature
    ? getDemoGeoJsonLabel(selectedGeoJsonFeature)
    : "";
  const selectedGeoJsonType = selectedGeoJsonFeature?.geometry.type ?? null;
  const selectedGeoJsonCanReshape = selectedGeoJsonType !== null && selectedGeoJsonType !== "Point";
  const selectedGeoJsonFeatures = useMemo(
    () =>
      geoJsonSelection.featureIds.flatMap((featureId) => {
        const feature = getDemoGeoJsonFeature(editableGeoJson, featureId);

        return feature ? [feature] : [];
      }),
    [editableGeoJson, geoJsonSelection.featureIds],
  );
  const selectedGeoJsonGroupIds = useMemo(
    () => [...new Set(selectedGeoJsonFeatures.flatMap((feature) => getDemoGroupId(feature) ?? []))],
    [selectedGeoJsonFeatures],
  );
  const renameSelectedGeoJsonFeature = (label: string) => {
    if (!selectedGeoJsonId) {
      return;
    }

    setEditableGeoJson((current) =>
      updateDemoGeoJsonFeature(current, selectedGeoJsonId, (feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          label,
        },
      })),
    );
  };
  const deleteSelectedGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length === 0) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);

    setEditableGeoJson((current) => ({
      ...current,
      features: current.features.filter(
        (feature, index) => !selectedIds.has(getDemoFeatureId(feature, index)),
      ),
    }));
    setGeoJsonSelection(emptyGeoJsonEditorSelection);
    setEditMode("select");
  };
  const duplicateSelectedGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length === 0) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);
    const nextGroupId = geoJsonSelection.featureIds.length > 1 ? `demo-group-${Date.now()}` : null;
    const nextIds: string[] = [];

    setEditableGeoJson((current) => {
      const duplicates = current.features.flatMap((feature, index) => {
        const featureId = getDemoFeatureId(feature, index);

        if (!selectedIds.has(featureId)) {
          return [];
        }

        const nextId = `${featureId}-copy-${Date.now()}-${nextIds.length + 1}`;

        nextIds.push(nextId);

        return [createDemoGeoJsonDuplicate(feature, nextId, nextGroupId)];
      });

      return {
        ...current,
        features: [...current.features, ...duplicates],
      };
    });
    setGeoJsonSelection({
      featureIds: nextIds,
      primaryFeatureId: nextIds[0] ?? null,
      vertexHandle: null,
    });
    setEditMode("move");
  };
  const groupSelectedDemoGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length < 2) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);
    const groupId = `demo-group-${Date.now()}`;

    setEditableGeoJson((current) => ({
      ...current,
      features: current.features.map((feature, index) =>
        selectedIds.has(getDemoFeatureId(feature, index))
          ? setDemoGroupId(feature, groupId)
          : feature,
      ),
    }));
  };
  const ungroupSelectedDemoGeoJsonFeatures = () => {
    if (geoJsonSelection.featureIds.length === 0) {
      return;
    }

    const selectedIds = new Set(geoJsonSelection.featureIds);
    const groupIds = new Set(selectedGeoJsonGroupIds);

    setEditableGeoJson((current) => ({
      ...current,
      features: current.features.map((feature, index) => {
        const featureId = getDemoFeatureId(feature, index);
        const groupId = getDemoGroupId(feature);

        return selectedIds.has(featureId) || (groupId !== null && groupIds.has(groupId))
          ? setDemoGroupId(feature, null)
          : feature;
      }),
    }));
  };

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-[1480px] gap-4 p-4 text-foreground md:gap-5 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">@moritzbrantner/maps</Badge>
            <Badge variant={datasetQuery.isFetching ? "outline" : "default"}>
              {datasetQuery.isFetching ? "Updating" : "Ready"}
            </Badge>
          </div>
          <h1 className="m-0 text-3xl font-semibold tracking-normal text-foreground md:text-4xl">
            Interactive map component workbench
          </h1>
        </div>
        <div className="flex flex-wrap items-end gap-2" aria-label="Demo controls">
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span>Region</span>
            <NativeSelect
              value={selectedRegion}
              onChange={(event) => setSelectedRegion(event.target.value)}
            >
              <option value="all">All regions</option>
              {dataset.regions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </NativeSelect>
          </label>
          <Button
            variant={isMeasuring ? "default" : "outline"}
            type="button"
            aria-pressed={isMeasuring}
            onClick={() => setIsMeasuring((value) => !value)}
          >
            {isMeasuring ? "Measuring" : "Measure"}
          </Button>
          <Button variant="secondary" type="button" onClick={() => setMeasurements([])}>
            Clear
          </Button>
        </div>
      </header>

      <Tabs value={view} onValueChange={(value) => setView(value as DemoView)}>
        <TabsList className="flex h-auto flex-wrap justify-start" aria-label="Map examples">
          {views.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <section className="demo-stage">
        <div className="demo-map-frame">
          {renderMap(
            view,
            visiblePoints,
            measurements,
            setMeasurements,
            isMeasuring,
            setViewport,
            layers,
            editablePointContext,
            editableGeoJson,
            setEditableGeoJson,
            editMode,
            setEditMode,
            geoJsonSelection,
            setGeoJsonSelection,
            heatFieldRenderMode,
            heatFieldContourLineWidth,
            showHeatDataPoints,
            selectedFlowId,
            setSelectedFlowId,
            temporalTime,
            setTemporalTime,
          )}
        </div>
        <aside aria-label="Current dataset">
          <Card className="gap-4">
            <CardHeader>
              <CardTitle>Dataset</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid gap-3 [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-3 [&>div]:border-b [&>div]:border-border [&>div]:pb-3 [&>div:last-child]:border-b-0 [&>div:last-child]:pb-0 [&_dd]:m-0 [&_dd]:font-semibold [&_dd]:tabular-nums [&_dt]:text-sm [&_dt]:font-medium [&_dt]:text-muted-foreground">
                <div>
                  <dt>Viewport</dt>
                  <dd>
                    {viewport.center[0].toFixed(2)}, {viewport.center[1].toFixed(2)} /{" "}
                    {viewport.zoom.toFixed(1)}
                  </dd>
                </div>
                <div>
                  <dt>Points</dt>
                  <dd>{activeInspectorPoints.length}</dd>
                </div>
                <div>
                  <dt>Demand</dt>
                  <dd>
                    {activeInspectorPoints.reduce(
                      (total, item) => total + (item.metrics?.demand ?? 0),
                      0,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Measurements</dt>
                  <dd>{measurements.length}</dd>
                </div>
              </dl>
              {view === "composed" ? (
                <div className="demo-layer-manager" aria-label="Layer manager">
                  <div className="demo-layer-manager__header">
                    <h2>Layers</h2>
                    <div className="demo-layer-add">
                      {layerKinds.map((kind) => (
                        <Button
                          className="h-8"
                          key={kind.id}
                          size="sm"
                          variant="secondary"
                          type="button"
                          onClick={() => addLayer(kind.id)}
                        >
                          + {kind.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="demo-layer-list">
                    {layers.map((layer) => (
                      <div className="demo-layer-row" key={layer.id}>
                        <label className="demo-layer-toggle">
                          <input
                            checked={layer.enabled}
                            type="checkbox"
                            onChange={(event) =>
                              updateLayer(layer.id, { enabled: event.target.checked })
                            }
                          />
                          <span>{layer.name}</span>
                        </label>
                        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                          <span>Type</span>
                          <NativeSelect
                            size="sm"
                            value={layer.kind}
                            onChange={(event) =>
                              updateLayer(layer.id, { kind: event.target.value as DemoLayerKind })
                            }
                          >
                            {layerKinds.map((kind) => (
                              <option key={kind.id} value={kind.id}>
                                {kind.label}
                              </option>
                            ))}
                          </NativeSelect>
                        </label>
                        <div className="demo-layer-colors" aria-label={`${layer.name} color`}>
                          {layerColors.map((color) => (
                            <button
                              aria-pressed={layer.color === color}
                              className="demo-color-swatch"
                              key={color}
                              style={{ background: color }}
                              title={color}
                              type="button"
                              onClick={() => updateLayer(layer.id, { color })}
                            />
                          ))}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          type="button"
                          onClick={() => removeLayer(layer.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {view === "heat" ? (
                <div className="demo-layer-manager" aria-label="Heat map controls">
                  <div className="demo-layer-manager__header">
                    <h2>Heat map</h2>
                  </div>
                  <div className="demo-editor-mode-grid" aria-label="Heat map render mode">
                    <Button
                      aria-pressed={heatFieldRenderMode === "raster"}
                      size="sm"
                      variant={heatFieldRenderMode === "raster" ? "default" : "secondary"}
                      type="button"
                      onClick={() => setHeatFieldRenderMode("raster")}
                    >
                      Colors
                    </Button>
                    <Button
                      aria-pressed={heatFieldRenderMode === "raster-contours"}
                      size="sm"
                      variant={heatFieldRenderMode === "raster-contours" ? "default" : "secondary"}
                      type="button"
                      onClick={() => setHeatFieldRenderMode("raster-contours")}
                    >
                      Both
                    </Button>
                    <Button
                      aria-pressed={heatFieldRenderMode === "contours"}
                      size="sm"
                      variant={heatFieldRenderMode === "contours" ? "default" : "secondary"}
                      type="button"
                      onClick={() => setHeatFieldRenderMode("contours")}
                    >
                      Level lines
                    </Button>
                  </div>
                  <label className="demo-layer-slider">
                    <span>Line thickness</span>
                    <output>{heatFieldContourLineWidth.toFixed(2)} px</output>
                    <input
                      aria-label="Level line thickness"
                      max="4"
                      min="0.5"
                      step="0.25"
                      type="range"
                      value={heatFieldContourLineWidth}
                      onChange={(event) =>
                        setHeatFieldContourLineWidth(Number(event.currentTarget.value))
                      }
                    />
                  </label>
                  <label className="demo-layer-toggle">
                    <input
                      checked={showHeatDataPoints}
                      type="checkbox"
                      onChange={(event) => setShowHeatDataPoints(event.target.checked)}
                    />
                    <span>Show data points</span>
                  </label>
                </div>
              ) : null}
              {view === "flows" ? <FlowVolumeLegend flows={demoFlows} /> : null}
              {view === "temporal" ? (
                <div className="demo-layer-manager" aria-label="Timeline route summary">
                  <div className="demo-layer-manager__header">
                    <h2>Timeline</h2>
                  </div>
                  <dl className="demo-editor-facts">
                    <div>
                      <dt>Routes</dt>
                      <dd>{demoTracks.length}</dd>
                    </div>
                    <div>
                      <dt>Geographies</dt>
                      <dd>{demoTimelineGeographyCount}</dd>
                    </div>
                    <div>
                      <dt>Range</dt>
                      <dd>08:00-10:00</dd>
                    </div>
                    <div>
                      <dt>Keyframes</dt>
                      <dd>{demoTimelineKeyframeCount}</dd>
                    </div>
                  </dl>
                </div>
              ) : null}
              {view === "editor" ? (
                <div className="demo-layer-manager" aria-label="GeoJSON editor controls">
                  <div className="demo-layer-manager__header">
                    <h2>Editor</h2>
                  </div>
                  <div className="demo-editor-section" aria-label="Add GeoJSON element">
                    <div className="demo-editor-section__header">
                      <h3>Add element</h3>
                      <Badge variant={editMode.startsWith("draw-") ? "default" : "secondary"}>
                        {editMode.startsWith("draw-") ? "Preview" : "Idle"}
                      </Badge>
                    </div>
                    <div className="demo-editor-mode-grid">
                      {editorModes.map((mode) => (
                        <Button
                          aria-pressed={editMode === mode.id}
                          key={mode.id}
                          size="sm"
                          title={getEditorModeShortcut(mode.id)}
                          variant={editMode === mode.id ? "default" : "secondary"}
                          type="button"
                          onClick={() => setEditMode(mode.id)}
                        >
                          {mode.label}
                        </Button>
                      ))}
                    </div>
                    <dl className="demo-editor-facts">
                      <div>
                        <dt>Mode</dt>
                        <dd>{editMode}</dd>
                      </div>
                      <div>
                        <dt>Features</dt>
                        <dd>{editableGeoJson.features.length}</dd>
                      </div>
                      <div>
                        <dt>Selection</dt>
                        <dd>{geoJsonSelection.featureIds.length}</dd>
                      </div>
                    </dl>
                    <div className="demo-editor-shortcuts" aria-label="Editor shortcuts">
                      <kbd>Shift</kbd>
                      <span>multi-select</span>
                      <kbd>Alt</kbd>
                      <span>select group</span>
                      <kbd>Del</kbd>
                      <span>delete</span>
                    </div>
                  </div>
                  <div className="demo-editor-section" aria-label="Selected GeoJSON element">
                    <div className="demo-editor-section__header">
                      <h3>
                        {geoJsonSelection.featureIds.length > 1
                          ? `${geoJsonSelection.featureIds.length} selected`
                          : "Selected element"}
                      </h3>
                      <Badge variant={selectedGeoJsonFeature ? "default" : "outline"}>
                        {selectedGeoJsonType ?? "None"}
                      </Badge>
                    </div>
                    {selectedGeoJsonFeature ? (
                      <>
                        <label className="demo-editor-label">
                          <span>Name</span>
                          <input
                            value={selectedGeoJsonLabel}
                            onChange={(event) => renameSelectedGeoJsonFeature(event.target.value)}
                          />
                        </label>
                        <dl className="demo-editor-facts">
                          <div>
                            <dt>ID</dt>
                            <dd>{selectedGeoJsonId}</dd>
                          </div>
                          <div>
                            <dt>Group</dt>
                            <dd>{selectedGeoJsonGroupIds.join(", ") || "None"}</dd>
                          </div>
                          <div>
                            <dt>Vertices</dt>
                            <dd>{countDemoGeometryPositions(selectedGeoJsonFeature.geometry)}</dd>
                          </div>
                          <div>
                            <dt>Parts</dt>
                            <dd>{countDemoGeometryParts(selectedGeoJsonFeature.geometry)}</dd>
                          </div>
                        </dl>
                        <div className="demo-editor-action-grid">
                          <Button
                            size="sm"
                            variant={editMode === "move" ? "default" : "secondary"}
                            type="button"
                            onClick={() => setEditMode("move")}
                          >
                            Move
                          </Button>
                          {selectedGeoJsonCanReshape ? (
                            <Button
                              size="sm"
                              variant={editMode === "reshape" ? "default" : "secondary"}
                              type="button"
                              onClick={() => setEditMode("reshape")}
                            >
                              Reshape
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="secondary"
                            type="button"
                            onClick={duplicateSelectedGeoJsonFeatures}
                          >
                            Duplicate
                          </Button>
                          <Button
                            disabled={geoJsonSelection.featureIds.length < 2}
                            size="sm"
                            variant="secondary"
                            type="button"
                            onClick={groupSelectedDemoGeoJsonFeatures}
                          >
                            Group
                          </Button>
                          <Button
                            disabled={selectedGeoJsonGroupIds.length === 0}
                            size="sm"
                            variant="secondary"
                            type="button"
                            onClick={ungroupSelectedDemoGeoJsonFeatures}
                          >
                            Ungroup
                          </Button>
                          <Button
                            size="sm"
                            variant={editMode === "delete" ? "default" : "outline"}
                            type="button"
                            onClick={deleteSelectedGeoJsonFeatures}
                          >
                            Delete
                          </Button>
                          {editMode === "reshape" && geoJsonSelection.vertexHandle ? (
                            <Button
                              size="sm"
                              variant="outline"
                              type="button"
                              onClick={() =>
                                setGeoJsonSelection({
                                  ...geoJsonSelection,
                                  vertexHandle: null,
                                })
                              }
                            >
                              Clear node
                            </Button>
                          ) : null}
                        </div>
                        {editMode === "reshape" ? (
                          <p className="demo-editor-hint">
                            Click midpoint handles to add nodes. Select a node and press Delete to
                            remove it.
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <div className="demo-editor-empty">
                        <p>No element selected</p>
                        <Button
                          size="sm"
                          variant={editMode === "select" ? "default" : "secondary"}
                          type="button"
                          onClick={() => setEditMode("select")}
                        >
                          Select element
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </section>
    </main>
  );
}

async function loadDemoDataset(): Promise<DemoDataset> {
  return createDemoDataset();
}

function createDemoDataset(): DemoDataset {
  return {
    points: demoPoints,
    regions: demoRegions,
  };
}

function renderMap(
  view: DemoView,
  points: Array<MapPoint<DemoPointProperties>>,
  measurements: MapBeeLineMeasurement[],
  setMeasurements: Dispatch<SetStateAction<MapBeeLineMeasurement[]>>,
  isMeasuring: boolean,
  setViewport: Dispatch<SetStateAction<MapViewState>>,
  layers: DemoLayerConfig[],
  editablePoints: EditablePointContext,
  editableGeoJson: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  setEditableGeoJson: Dispatch<
    SetStateAction<TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>>
  >,
  editMode: GeoJsonEditMode,
  setEditMode: Dispatch<SetStateAction<GeoJsonEditMode>>,
  geoJsonSelection: GeoJsonEditorSelection,
  setGeoJsonSelection: Dispatch<SetStateAction<GeoJsonEditorSelection>>,
  heatFieldRenderMode: HeatFieldRenderMode,
  heatFieldContourLineWidth: number,
  showHeatDataPoints: boolean,
  selectedFlowId: string | null,
  setSelectedFlowId: Dispatch<SetStateAction<string | null>>,
  temporalTime: number,
  setTemporalTime: Dispatch<SetStateAction<number>>,
) {
  const sharedMeasurementProps = {
    measurementMode: isMeasuring ? ("bee-line" as const) : ("none" as const),
    measurements,
    onMeasurementCreate: (measurement: MapBeeLineMeasurementResult) => {
      setMeasurements((current) => [
        ...current,
        {
          ...measurement,
          id: `measure-${current.length + 1}`,
        },
      ]);
    },
  };

  switch (view) {
    case "points":
      return (
        <PointMap
          {...sharedMeasurementProps}
          draggable
          fitToData={false}
          initialViewState={{ center: [9.8, 50.8], zoom: 5 }}
          mapStyle={demoMapStyle}
          onFeatureDragEnd={editablePoints.onMovePoint}
          onFeatureSelect={editablePoints.onSelectPoint}
          onMapContextMenu={() => {
            editablePoints.onSelectPoint(null);
          }}
          onViewStateChange={setViewport}
          points={editablePoints.points}
          pointColor="#115e59"
          renderFeatureContextMenu={(feature, context) => (
            <div className="demo-context-menu">
              <button
                type="button"
                onClick={() => {
                  editablePoints.onDeletePoint(feature);
                  context.close();
                }}
              >
                Delete point
              </button>
            </div>
          )}
          renderFeaturePopup={(feature) => (
            <div className="demo-popup">
              <strong>{feature.point.label}</strong>
              <span>{feature.point.metrics.demand ?? 0} demand</span>
            </div>
          )}
          renderFeatureTooltip={(feature) => feature.point.label}
          renderMapContextMenu={(context) => (
            <div className="demo-context-menu">
              <button
                type="button"
                onClick={() => {
                  editablePoints.onCreatePoint(context.coordinates);
                  context.close();
                }}
              >
                Create point
              </button>
            </div>
          )}
          selectedFeatureId={editablePoints.selectedPointId}
          style={{ minHeight: 620 }}
        />
      );
    case "heat":
      return (
        <HeatMap
          {...sharedMeasurementProps}
          domainBounds={demoTemperatureDomainBounds}
          fieldAsyncRender
          fieldColumns={320}
          fieldColorRamp={demoTemperatureFieldColorRamp}
          fieldRows={200}
          fieldRenderMode={heatFieldRenderMode}
          fieldValueDomain={demoTemperatureValueDomain}
          fieldContourColor="#111827"
          fieldContourLevels={11}
          fieldContourLineWidth={heatFieldContourLineWidth}
          fieldContourValueFormat={formatTemperatureValue}
          heatmapSurfaceMode="field"
          interpolationK={10}
          interpolationPower={2}
          mapLabel="Europe temperature surface"
          mapStyle={demoMapStyle}
          maxBounds={demoTemperatureDomainBounds}
          maxZoom={6}
          onViewStateChange={setViewport}
          points={demoTemperaturePoints}
          showDataPoints={showHeatDataPoints}
          dataPointColor="#111827"
          dataPointRadius={4}
          dataPointValueFormat={formatTemperatureValue}
          style={{ minHeight: 620 }}
          valueMetric="temperature"
        />
      );
    case "flows":
      return (
        <FlowMap
          {...sharedMeasurementProps}
          flowColor="#b45309"
          flowShape={{ type: "s-curve", bend: 0.34, direction: "auto", segments: 40 }}
          flows={demoFlows}
          mapStyle={demoMapStyle}
          maxWidth={18}
          onFeatureSelect={(feature) => setSelectedFlowId(feature?.flow.id ?? null)}
          onViewStateChange={setViewport}
          renderFeaturePopup={renderDemoFlowPopup}
          renderFeatureTooltip={renderDemoFlowTooltip}
          selectedFeatureId={selectedFlowId}
          showDirection
          showEndpoints
          weightMetric="trips"
          style={{ minHeight: 620 }}
        />
      );
    case "composed":
      return (
        <MapView
          defaultViewState={{ center: [9.8, 50.8], zoom: 5 }}
          mapStyle={demoMapStyle}
          onViewStateChange={setViewport}
          style={{ minHeight: 620 }}
        >
          {layers
            .filter((layer) => layer.enabled)
            .map((layer) => renderComposedLayer(layer, points))}
          <BeeLineMeasurementLayer {...sharedMeasurementProps} layerId="composed-measurements" />
        </MapView>
      );
    case "temporal":
      return (
        <TemporalClusteredMap
          autoPlay
          fitToData={false}
          formatTimeLabel={formatDemoTimelineTime}
          geoJson={demoTimelineGeoJsonCollection}
          geoJsonOverlay="all"
          geoJsonOverlayProps={{
            getFeatureStyle: getDemoTimelineGeographyStyle,
            renderFeaturePopup: (feature) => renderDemoTimelineGeoJsonPopup(feature, temporalTime),
            renderFeatureTooltip: renderDemoTimelineGeoJsonTooltip,
          }}
          geoJsonPlaybackOptions={{
            minResampleCoordinates: 28,
            strategy: "resample",
          }}
          initialViewState={demoTimelineViewState}
          loopPlayback
          mapLabel="European logistics timeline"
          mapStyle={demoMapStyle}
          onTimeChange={setTemporalTime}
          onViewStateChange={setViewport}
          playbackRate={6}
          timelineLabel="Shipment timeline"
          tracks={demoTracks}
          style={{ minHeight: 560 }}
          timeStep={1}
        />
      );
    case "interpolation":
      return <GeoJsonInterpolationWorkbench />;
    case "globe":
      return (
        <BubbleMap
          {...sharedMeasurementProps}
          bubbleColor="#0f766e"
          mapDisplay="globe"
          mapStyle={demoMapStyle}
          onViewStateChange={setViewport}
          points={points}
          renderFeatureTooltip={(feature) => feature.point.label}
          style={{ minHeight: 620 }}
          weightMetric="demand"
        />
      );
    case "geojson":
      return <GeoJsonGeometryExample />;
    case "editor":
      return (
        <EditableGeoJsonMap
          editMode={editMode}
          fitToData={false}
          geoJson={editableGeoJson}
          getFeatureId={getDemoFeatureId}
          initialViewState={{ center: [8.4, 50.4], zoom: 4.4 }}
          mapStyle={demoMapStyle}
          onEditModeChange={setEditMode}
          onEditorSelectionChange={setGeoJsonSelection}
          onFeatureCollectionChange={(next) => setEditableGeoJson(next)}
          selection={geoJsonSelection}
          createFeatureProperties={(geometryType) => ({
            kind: geometryType,
            label: `New ${geometryType}`,
            time: 0,
            trackId: `editor-${Date.now()}`,
          })}
          onMapContextMenu={() => {
            setEditMode("draw-point");
          }}
          style={{ minHeight: 620 }}
        />
      );
    case "clusters":
    default:
      return (
        <ClusteredMap
          {...sharedMeasurementProps}
          clusterRadius={76}
          mapStyle={demoMapStyle}
          onViewStateChange={setViewport}
          points={points}
          renderFeaturePopup={(feature) =>
            feature.kind === "cluster" ? `${feature.pointCount} locations` : feature.point.label
          }
          renderFeatureTooltip={(feature) =>
            feature.kind === "cluster" ? feature.pointCountAbbreviated : feature.point.label
          }
          style={{ minHeight: 620 }}
        />
      );
  }
}

function getDemoGeoJsonFeature(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  featureId: string | null,
) {
  if (!featureId) {
    return null;
  }

  return (
    collection.features.find((feature, index) => getDemoFeatureId(feature, index) === featureId) ??
    null
  );
}

function getDemoFeatureId(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  index: number,
) {
  return String(feature.id ?? `feature-${index}`);
}

function getDemoGeoJsonLabel(feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>) {
  return String(feature.properties?.label ?? feature.id ?? feature.geometry.type);
}

function getEditorModeShortcut(mode: GeoJsonEditMode) {
  switch (mode) {
    case "select":
      return "V";
    case "draw-point":
      return "P";
    case "draw-line":
      return "L";
    case "draw-polygon":
      return "G";
    case "move":
      return "M";
    case "reshape":
      return "R";
    case "delete":
      return "Delete";
    default:
      return "";
  }
}

function getDemoGroupId(feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>) {
  return feature.properties?.groupId ?? null;
}

function setDemoGroupId(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  groupId: string | null,
): TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties> {
  const properties = {
    ...feature.properties,
  };

  if (groupId) {
    properties.groupId = groupId;
  } else {
    delete properties.groupId;
  }

  return {
    ...feature,
    properties,
  };
}

function updateDemoGeoJsonFeature(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  featureId: string,
  update: (
    feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  ) => TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
) {
  return {
    ...collection,
    features: collection.features.map((feature, index) =>
      getDemoFeatureId(feature, index) === featureId ? update(feature) : feature,
    ),
  };
}

function createDemoGeoJsonDuplicate(
  feature: TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties>,
  id: string,
  groupId: string | null = null,
): TemporalGeoJsonGeometryFeature<DemoGeoJsonProperties> {
  return {
    ...feature,
    geometry: moveGeoJsonGeometry(feature.geometry, 0.45, 0.28),
    id,
    properties: {
      ...feature.properties,
      groupId: groupId ?? undefined,
      label: `${getDemoGeoJsonLabel(feature)} copy`,
      trackId: id,
    },
  };
}

function countDemoGeometryPositions(geometry: TemporalGeoJsonSupportedGeometry) {
  switch (geometry.type) {
    case "Point":
      return 1;
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates.length;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.reduce((total, line) => total + line.length, 0);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (total, polygon) => total + polygon.reduce((ringTotal, ring) => ringTotal + ring.length, 0),
        0,
      );
  }
}

function countDemoGeometryParts(geometry: TemporalGeoJsonSupportedGeometry) {
  switch (geometry.type) {
    case "Point":
    case "LineString":
    case "Polygon":
      return 1;
    case "MultiPoint":
      return geometry.coordinates.length;
    case "MultiLineString":
      return geometry.coordinates.length;
    case "MultiPolygon":
      return geometry.coordinates.length;
  }
}

function renderDemoTimelineGeoJsonTooltip(feature: GeoJsonLayerFeature<DemoGeoJsonProperties>) {
  const properties = readDemoTimelineOutputProperties(feature);

  return `${properties.label} (${feature.geometry.type})`;
}

function renderDemoTimelineGeoJsonPopup(
  feature: GeoJsonLayerFeature<DemoGeoJsonProperties>,
  activeTime: number,
) {
  const properties = readDemoTimelineOutputProperties(feature);
  const interpolation = getDemoTimelineInterpolationInfo(properties.trackId, activeTime);

  return (
    <div className="demo-popup">
      <strong>{properties.label}</strong>
      <span>{feature.geometry.type}</span>
      <span>
        {countDemoGeometryPositions(feature.geometry)} coordinates across{" "}
        {countDemoGeometryParts(feature.geometry)} part
        {countDemoGeometryParts(feature.geometry) === 1 ? "" : "s"}
      </span>
      <span>{interpolation.segment}</span>
      <span>{interpolation.method}</span>
    </div>
  );
}

function readDemoTimelineOutputProperties(feature: GeoJsonLayerFeature<DemoGeoJsonProperties>) {
  const properties = feature.properties as DemoGeoJsonProperties & {
    temporalLabel?: unknown;
    temporalTrackId?: unknown;
  };

  return {
    label: String(properties.temporalLabel ?? properties.label ?? feature.id),
    trackId: String(properties.temporalTrackId ?? properties.trackId ?? feature.id),
  };
}

function getDemoTimelineInterpolationInfo(trackId: string, activeTime: number) {
  const frames = demoTimelineGeoJsonCollection.features
    .flatMap((feature) => {
      if (feature.properties?.trackId !== trackId || !feature.geometry) {
        return [];
      }

      return [
        {
          geometryType: feature.geometry.type,
          time: feature.properties.time,
          visible: feature.properties.visible !== false,
        },
      ];
    })
    .sort((left, right) => left.time - right.time);

  if (frames.length === 0) {
    return {
      method: "No source keyframes found",
      segment: `Sampled at ${formatDemoTimelineTime(activeTime)}`,
    };
  }

  const previousIndex = findPreviousDemoTimelineFrameIndex(frames, activeTime);
  const nextIndex = frames.findIndex((frame) => frame.time > activeTime);

  if (previousIndex < 0) {
    return {
      method: "Waiting for first keyframe",
      segment: `Starts at ${formatDemoTimelineTime(frames[0]!.time)}`,
    };
  }

  if (nextIndex < 0) {
    const frame = frames[previousIndex]!;

    return {
      method: frame.visible ? "Holding final keyframe" : "Hidden after final keyframe",
      segment: `Last keyframe ${formatDemoTimelineTime(frame.time)}`,
    };
  }

  const previous = frames[previousIndex]!;
  const next = frames[nextIndex]!;
  const progress =
    next.time === previous.time
      ? 1
      : Math.min(Math.max((activeTime - previous.time) / (next.time - previous.time), 0), 1);
  const method =
    previous.geometryType === next.geometryType
      ? `${getDemoTimelineInterpolationMethod(previous.geometryType)} interpolation`
      : `Hold fallback from ${previous.geometryType} to ${next.geometryType}`;

  return {
    method,
    segment: `${formatDemoTimelineTime(previous.time)} to ${formatDemoTimelineTime(next.time)} (${Math.round(
      progress * 100,
    )}%)`,
  };
}

function getDemoTimelineInterpolationMethod(geometryType: string) {
  switch (geometryType) {
    case "LineString":
    case "MultiLineString":
    case "Polygon":
    case "MultiPolygon":
      return `Resampled ${geometryType}`;
    default:
      return `Compatible ${geometryType}`;
  }
}

function findPreviousDemoTimelineFrameIndex(frames: Array<{ time: number }>, activeTime: number) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (frames[index]!.time <= activeTime) {
      return index;
    }
  }

  return -1;
}

function GeoJsonInterpolationWorkbench() {
  const [exampleId, setExampleId] = useState(demoInterpolationExamples[0]!.id);
  const example =
    demoInterpolationExamples.find((item) => item.id === exampleId) ??
    demoInterpolationExamples[0]!;
  const isTopologyExample = example.kind === "topology";
  const geometryType = example.geometryType;
  const [strategy, setStrategy] = useState<TemporalGeoJsonInterpolationStrategy>(
    getDemoInterpolationDefaultStrategy(demoInterpolationExamples[0]!),
  );
  const [topologyStrategy, setTopologyStrategy] =
    useState<Exclude<GeoJsonTopologyStrategy, "bounds">>("area-overlap");
  const [progress, setProgress] = useState(50);
  const [constrainToLandmass, setConstrainToLandmass] = useState(false);
  const [selectedKeyframe, setSelectedKeyframe] = useState<DemoInterpolationKeyframeId>("end");
  const [selectedHandleIndex, setSelectedHandleIndex] = useState(0);
  const [geometries, setGeometries] = useState<Record<string, DemoInterpolationGeometryPair>>(() =>
    createDemoInterpolationGeometryExamples(),
  );
  const geometryPair = isTopologyExample ? null : (geometries[example.id] ?? example.pair);
  const topologyPair = isTopologyExample
    ? {
        end: example.endCollection,
        start: example.startCollection,
      }
    : null;
  const handles = geometryPair ? getDemoInterpolationHandles(geometryPair[selectedKeyframe]) : [];
  const selectedHandle = handles[Math.min(selectedHandleIndex, handles.length - 1)] ?? null;
  const selectedPosition =
    geometryPair && selectedHandle
      ? getDemoInterpolationPosition(geometryPair[selectedKeyframe], selectedHandle.path)
      : ([0, 0] as [number, number]);
  const progressTime = progress / 100;
  const canConstrainToLandmass = isDemoPolygonLikeGeometryType(geometryType);
  const rawInterpolatedCollection = useMemo(() => {
    if (topologyPair) {
      if (progressTime <= 0) {
        return topologyPair.start;
      }

      if (progressTime >= 1) {
        return topologyPair.end;
      }

      return interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(topologyPair.start, topologyPair.end, {
          algorithm: "topology-plan",
          topologyStrategy,
        }),
        progressTime,
      );
    }

    return getTemporalGeoJsonFeatureCollectionAtTime(
      [
        {
          id: "interpolation-preview",
          label: `${geometryType} preview`,
          frames: [
            {
              geometry: geometryPair!.start,
              time: 0,
            },
            {
              geometry: geometryPair!.end,
              time: 1,
            },
          ],
        },
      ],
      progressTime,
      {
        fallback: "hold",
        minResampleCoordinates: 24,
        strategy,
      },
    );
  }, [geometryPair, geometryType, progressTime, strategy, topologyPair, topologyStrategy]);
  const interpolatedCollection =
    constrainToLandmass && canConstrainToLandmass
      ? constrainDemoInterpolationCollection(
          rawInterpolatedCollection,
          demoInterpolationLandmassConstraint,
        )
      : rawInterpolatedCollection;
  const startCollection = topologyPair
    ? topologyPair.start
    : createDemoInterpolationFeatureCollection("start", "Start keyframe", geometryPair!.start);
  const endCollection = topologyPair
    ? topologyPair.end
    : createDemoInterpolationFeatureCollection("end", "End keyframe", geometryPair!.end);
  const previewFeature = interpolatedCollection.features[0] ?? null;
  const previewGeometry =
    previewFeature?.geometry ??
    geometryPair?.start ??
    topologyPair?.start.features[0]?.geometry ??
    ({ coordinates: [0, 0], type: "Point" } as const);
  const bounds = getBoundsFromGeoJson({
    features: [
      ...startCollection.features,
      ...endCollection.features,
      ...interpolatedCollection.features,
    ],
    type: "FeatureCollection",
  });
  const strategyDetails = demoInterpolationStrategies.find((item) => item.id === strategy);
  const setExampleFromControl = (nextExampleId: string) => {
    const nextExample =
      demoInterpolationExamples.find((item) => item.id === nextExampleId) ??
      demoInterpolationExamples[0]!;

    setExampleId(nextExample.id);
    setStrategy(getDemoInterpolationDefaultStrategy(nextExample));
    setTopologyStrategy("area-overlap");
    setSelectedHandleIndex(0);
  };
  const updateSelectedPosition = (axis: 0 | 1, value: number) => {
    if (!geometryPair || !selectedHandle || !Number.isFinite(value)) {
      return;
    }

    const nextPosition: [number, number] =
      axis === 0 ? [value, selectedPosition[1]] : [selectedPosition[0], value];

    setGeometries((current) => {
      const currentPair = current[example.id] ?? example.pair;

      return {
        ...current,
        [example.id]: {
          ...currentPair,
          [selectedKeyframe]: setDemoInterpolationPosition(
            currentPair[selectedKeyframe],
            selectedHandle.path,
            nextPosition,
          ),
        },
      };
    });
  };
  const resetCurrentGeometry = () => {
    if (isTopologyExample) {
      setProgress(50);
      setTopologyStrategy("area-overlap");
      setSelectedHandleIndex(0);
      return;
    }

    setGeometries((current) => ({
      ...current,
      [example.id]: example.pair,
    }));
    setStrategy(getDemoInterpolationDefaultStrategy(example));
    setProgress(50);
    setSelectedHandleIndex(0);
  };
  const transitionKinds = [
    ...new Set(
      interpolatedCollection.features.flatMap((feature) => {
        const kind = readDemoTransitionKind(feature.properties);

        return typeof kind === "string" ? [kind] : [];
      }),
    ),
  ];
  const totalFlowArea = interpolatedCollection.features.reduce(
    (sum, feature) => sum + readDemoNumericProperty(feature.properties, "flowArea"),
    0,
  );

  return (
    <section className="demo-interpolation-workbench" aria-label="GeoJSON interpolation workbench">
      <div className="demo-interpolation-workbench__map">
        <MapView
          dataBounds={bounds}
          defaultViewState={{ center: [6.5, 48.5], zoom: 4.2 }}
          fitBoundsPadding={72}
          mapLabel="GeoJSON interpolation preview"
          mapStyle={demoMapStyle}
          style={{ minHeight: 620 }}
        >
          <GeoJsonLayer
            featureCollection={startCollection}
            getFeatureStyle={() => getDemoInterpolationLayerStyle("start", geometryType)}
            layerId="interpolation-start"
            renderFeatureTooltip={() => "Start keyframe"}
          />
          <GeoJsonLayer
            featureCollection={endCollection}
            getFeatureStyle={() => getDemoInterpolationLayerStyle("end", geometryType)}
            layerId="interpolation-end"
            renderFeatureTooltip={() => "End keyframe"}
          />
          {constrainToLandmass && canConstrainToLandmass ? (
            <GeoJsonLayer
              featureCollection={demoInterpolationLandmassCollection}
              getFeatureStyle={() => getDemoInterpolationConstraintLayerStyle()}
              layerId="interpolation-constraint"
              renderFeatureTooltip={() => "Constraint polygon"}
            />
          ) : null}
          <GeoJsonLayer
            featureCollection={interpolatedCollection}
            getFeatureStyle={(feature) =>
              getDemoInterpolationPreviewLayerStyle(feature, geometryType)
            }
            layerId="interpolation-preview"
            renderFeaturePopup={(feature) => (
              <div className="demo-popup">
                <strong>{feature.geometry.type} interpolation</strong>
                <span>
                  {isTopologyExample ? "Topology plan" : (strategyDetails?.label ?? strategy)}
                </span>
                <span>{progress}% between keyframes</span>
                <span>{countDemoGeometryPositions(feature.geometry)} coordinates</span>
              </div>
            )}
            renderFeatureTooltip={() => `${geometryType} at ${progress}%`}
          />
        </MapView>
        <div className="demo-interpolation-legend" aria-label="Interpolation layers">
          <span>
            <i className="demo-interpolation-legend__start" /> Start
          </span>
          <span>
            <i className="demo-interpolation-legend__preview" /> Interpolated
          </span>
          <span>
            <i className="demo-interpolation-legend__end" /> End
          </span>
        </div>
      </div>

      <div className="demo-interpolation-panel">
        <div className="demo-layer-manager__header">
          <h2>Interpolation</h2>
          <Button size="sm" variant="secondary" type="button" onClick={resetCurrentGeometry}>
            Reset
          </Button>
        </div>

        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          <span>Example</span>
          <NativeSelect
            value={example.id}
            onChange={(event) => setExampleFromControl(event.target.value)}
          >
            {demoInterpolationExamples.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </label>

        {isTopologyExample ? (
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span>Topology strategy</span>
            <NativeSelect
              value={topologyStrategy}
              onChange={(event) =>
                setTopologyStrategy(
                  event.target.value as Exclude<GeoJsonTopologyStrategy, "bounds">,
                )
              }
            >
              {demoTopologyStrategies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : (
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span>Algorithm</span>
            <NativeSelect
              value={strategy}
              onChange={(event) =>
                setStrategy(event.target.value as TemporalGeoJsonInterpolationStrategy)
              }
            >
              {demoInterpolationStrategies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}

        <div className="demo-interpolation-note">
          <strong>{geometryType}</strong>
          <span>{example.description}</span>
          <span>
            {isTopologyExample
              ? "Uses collection-level topology planning across all scene features."
              : (strategyDetails?.description ??
                "Uses the selected temporal GeoJSON interpolation mode.")}
          </span>
        </div>

        <label
          className="demo-interpolation-toggle"
          aria-disabled={!canConstrainToLandmass}
        >
          <input
            checked={constrainToLandmass && canConstrainToLandmass}
            disabled={!canConstrainToLandmass}
            type="checkbox"
            onChange={(event) => setConstrainToLandmass(event.target.checked)}
          />
          <span>Constrain to landmass</span>
        </label>

        <label className="demo-interpolation-range">
          <span>
            <strong>Progress</strong>
            <em>{progress}%</em>
          </span>
          <input
            aria-label="Interpolation progress"
            max={100}
            min={0}
            step={1}
            type="range"
            value={progress}
            onChange={(event) => setProgress(Number(event.target.value))}
          />
        </label>

        {!isTopologyExample ? (
          <>
            <div className="demo-interpolation-keyframes" aria-label="Keyframe selector">
              <Button
                size="sm"
                variant={selectedKeyframe === "start" ? "default" : "secondary"}
                type="button"
                onClick={() => setSelectedKeyframe("start")}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant={selectedKeyframe === "end" ? "default" : "secondary"}
                type="button"
                onClick={() => setSelectedKeyframe("end")}
              >
                End
              </Button>
            </div>

            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              <span>Coordinate handle</span>
              <NativeSelect
                value={String(Math.min(selectedHandleIndex, handles.length - 1))}
                onChange={(event) => setSelectedHandleIndex(Number(event.target.value))}
              >
                {handles.map((handle, index) => (
                  <option key={handle.label} value={index}>
                    {handle.label}
                  </option>
                ))}
              </NativeSelect>
            </label>

            <div className="demo-coordinate-grid">
              <label>
                <span>Longitude</span>
                <input
                  step={0.1}
                  type="number"
                  value={Number(selectedPosition[0].toFixed(4))}
                  onChange={(event) => updateSelectedPosition(0, Number(event.target.value))}
                />
              </label>
              <label>
                <span>Latitude</span>
                <input
                  step={0.1}
                  type="number"
                  value={Number(selectedPosition[1].toFixed(4))}
                  onChange={(event) => updateSelectedPosition(1, Number(event.target.value))}
                />
              </label>
            </div>
          </>
        ) : null}

        <dl className="demo-interpolation-facts">
          <div>
            <dt>Preview type</dt>
            <dd>{previewGeometry.type}</dd>
          </div>
          <div>
            <dt>Preview coordinates</dt>
            <dd>{countDemoGeometryPositions(previewGeometry)}</dd>
          </div>
          <div>
            <dt>Parts</dt>
            <dd>{countDemoGeometryParts(previewGeometry)}</dd>
          </div>
          <div>
            <dt>{isTopologyExample ? "Start features" : "Start"}</dt>
            <dd>
              {isTopologyExample
                ? startCollection.features.length
                : `${geometryPair!.start.type} / ${countDemoGeometryPositions(geometryPair!.start)}`}
            </dd>
          </div>
          <div>
            <dt>{isTopologyExample ? "End features" : "End"}</dt>
            <dd>
              {isTopologyExample
                ? endCollection.features.length
                : `${geometryPair!.end.type} / ${countDemoGeometryPositions(geometryPair!.end)}`}
            </dd>
          </div>
          {isTopologyExample ? (
            <>
              <div>
                <dt>Strategy</dt>
                <dd>
                  {demoTopologyStrategies.find((item) => item.id === topologyStrategy)?.label}
                </dd>
              </div>
              <div>
                <dt>Preview features</dt>
                <dd>{interpolatedCollection.features.length}</dd>
              </div>
              <div>
                <dt>Kinds</dt>
                <dd>{transitionKinds.length > 0 ? transitionKinds.join(", ") : "scene"}</dd>
              </div>
              <div>
                <dt>Total flow area</dt>
                <dd>{totalFlowArea.toFixed(2)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

function createDemoInterpolationFeatureCollection(
  kind: string,
  label: string,
  geometry: TemporalGeoJsonSupportedGeometry,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  return {
    features: [
      {
        geometry,
        properties: {
          kind,
          label,
          time: 0,
          trackId: kind,
        },
        type: "Feature",
      },
    ],
    type: "FeatureCollection",
  };
}

function getDemoInterpolationLayerStyle(
  layer: "end" | "preview" | "start",
  geometryType: DemoInterpolationGeometryType,
) {
  const color = layer === "start" ? "#475569" : layer === "end" ? "#d97706" : "#be123c";
  const fillOpacity = layer === "preview" ? 0.3 : 0.11;
  const width = layer === "preview" ? 5 : 3;

  if (geometryType === "Point" || geometryType === "MultiPoint") {
    return {
      pointColor: color,
      pointRadius: layer === "preview" ? 8 : 6,
    };
  }

  if (geometryType === "LineString" || geometryType === "MultiLineString") {
    return {
      lineColor: color,
      lineOpacity: layer === "preview" ? 0.92 : 0.56,
      lineWidth: width,
    };
  }

  return {
    polygonFillColor: color,
    polygonFillOpacity: fillOpacity,
    polygonStrokeColor: color,
    polygonStrokeWidth: layer === "preview" ? 3 : 2,
  };
}

function getDemoInterpolationConstraintLayerStyle() {
  return {
    polygonFillColor: "#0f766e",
    polygonFillOpacity: 0.08,
    polygonStrokeColor: "#0f766e",
    polygonStrokeWidth: 2,
  };
}

function getDemoInterpolationPreviewLayerStyle(
  feature: GeoJsonLayerFeature<DemoGeoJsonProperties>,
  geometryType: DemoInterpolationGeometryType,
) {
  const transitionKind = readDemoTransitionKind(feature.properties);

  if (transitionKind === "split") {
    return {
      polygonFillColor: "#14b8a6",
      polygonFillOpacity: 0.24,
      polygonStrokeColor: "#0f766e",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "merge") {
    return {
      polygonFillColor: "#f59e0b",
      polygonFillOpacity: 0.24,
      polygonStrokeColor: "#b45309",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "preserve") {
    return {
      polygonFillColor: "#64748b",
      polygonFillOpacity: 0.2,
      polygonStrokeColor: "#475569",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "appear") {
    return {
      polygonFillColor: "#22c55e",
      polygonFillOpacity: 0.22,
      polygonStrokeColor: "#15803d",
      polygonStrokeWidth: 3,
    };
  }

  if (transitionKind === "disappear") {
    return {
      polygonFillColor: "#f43f5e",
      polygonFillOpacity: 0.22,
      polygonStrokeColor: "#be123c",
      polygonStrokeWidth: 3,
    };
  }

  return getDemoInterpolationLayerStyle("preview", geometryType);
}

function constrainDemoInterpolationCollection(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  constraint: GeoJsonPolygonConstraint,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  return {
    ...collection,
    features: collection.features.flatMap((feature) => {
      const constrainedGeometry = constrainGeoJsonGeometryToPolygon(feature.geometry, constraint);

      return constrainedGeometry
        ? [
            {
              ...feature,
              geometry: constrainedGeometry,
            },
          ]
        : [];
    }),
  };
}

function isDemoPolygonLikeGeometryType(geometryType: DemoInterpolationGeometryType) {
  return geometryType === "Polygon" || geometryType === "MultiPolygon";
}

function readDemoTransitionKind(properties: unknown) {
  return isDemoRecord(properties) ? properties.transitionKind : undefined;
}

function readDemoNumericProperty(properties: unknown, key: string) {
  const value = isDemoRecord(properties) ? properties[key] : undefined;

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isDemoRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createDemoInterpolationGeometryExamples() {
  return Object.fromEntries(
    demoInterpolationExamples.flatMap((example) =>
      example.kind === "topology" ? [] : [[example.id, example.pair]],
    ),
  ) as Record<string, DemoInterpolationGeometryPair>;
}

function getDemoInterpolationDefaultStrategy(example: DemoInterpolationExample) {
  return example.kind === "topology" ? "vertex-union" : example.defaultStrategy;
}

function createDemoInterpolationExamples(): DemoInterpolationExample[] {
  return [
    {
      defaultStrategy: "vertex-union",
      description: "Two service areas both move and skew while keeping matching polygon counts.",
      geometryType: "MultiPolygon",
      id: "multipolygon-two-islands",
      label: "MultiPolygon: two moving areas",
      pair: createDemoInterpolationGeometryPair("MultiPolygon"),
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The next keyframe adds a second polygon. Algorithms fall back to holding the previous MultiPolygon because the polygon count is incompatible.",
      geometryType: "MultiPolygon",
      id: "multipolygon-added-part",
      label: "MultiPolygon: added part fallback",
      pair: {
        end: createDemoInterpolationGeometryPair("MultiPolygon").end,
        start: {
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
          ],
          type: "MultiPolygon",
        },
      },
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The west polygon has an interior ring in both keyframes, so the hole interpolates with the shell.",
      geometryType: "MultiPolygon",
      id: "multipolygon-hole",
      label: "MultiPolygon: hole",
      pair: createDemoMultiPolygonHolePair(),
    },
    {
      defaultStrategy: "centroid-radial",
      description:
        "A polygon changes from a simple square into a concave outline with extra vertices.",
      geometryType: "Polygon",
      id: "polygon-concave-extra-vertices",
      label: "Polygon: concave extra vertices",
      pair: createDemoConcavePolygonPair(),
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The shell winds in the opposite direction at the end keyframe, testing ring orientation alignment before blending.",
      geometryType: "Polygon",
      id: "polygon-reversed-ring",
      label: "Polygon: reversed ring",
      pair: createDemoReversedRingPolygonPair(),
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The end keyframe introduces an interior ring. Vertex union collapses the missing start hole to its centroid.",
      geometryType: "Polygon",
      id: "polygon-hole-appears",
      label: "Polygon: hole appears",
      pair: createDemoPolygonHoleAppearsPair(),
    },
    {
      defaultStrategy: "centroid-radial",
      description:
        "A thin service sliver expands into a broad area, stressing centroid sampling and very uneven edge lengths.",
      geometryType: "Polygon",
      id: "polygon-sliver-expansion",
      label: "Polygon: sliver expansion",
      pair: createDemoSliverPolygonPair(),
    },
    {
      defaultStrategy: "resample",
      description:
        "A route changes point density between keyframes; resample creates matching intermediate points.",
      geometryType: "LineString",
      id: "line-density-change",
      label: "LineString: density change",
      pair: createDemoLineDensityPair(),
    },
    {
      defaultStrategy: "resample",
      description:
        "A sparse direct route becomes a long zig-zag corridor, making resampled intermediate vertices visible.",
      geometryType: "LineString",
      id: "line-zigzag-growth",
      label: "LineString: zig-zag growth",
      pair: createDemoZigZagLinePair(),
    },
    {
      defaultStrategy: "resample",
      description: "Two branch lines stay as two parts, but each branch bends and changes length.",
      geometryType: "MultiLineString",
      id: "multiline-branches",
      label: "MultiLineString: branches",
      pair: createDemoInterpolationGeometryPair("MultiLineString"),
    },
    {
      defaultStrategy: "resample",
      description:
        "The end keyframe drops one branch, so multipart line interpolation falls back because part counts differ.",
      geometryType: "MultiLineString",
      id: "multiline-missing-branch",
      label: "MultiLineString: missing branch",
      pair: createDemoMultiLineMissingBranchPair(),
    },
    {
      defaultStrategy: "compatible",
      description:
        "Three points move one-for-one. Compatible interpolation is enough when counts match.",
      geometryType: "MultiPoint",
      id: "multipoint-compatible",
      label: "MultiPoint: compatible",
      pair: createDemoInterpolationGeometryPair("MultiPoint"),
    },
    {
      defaultStrategy: "compatible",
      description:
        "The next MultiPoint has fewer points, so compatible mode demonstrates the hold fallback.",
      geometryType: "MultiPoint",
      id: "multipoint-count-mismatch",
      label: "MultiPoint: count mismatch",
      pair: createDemoMultiPointMismatchPair(),
    },
    {
      defaultStrategy: "resample",
      description:
        "A point follows the simplest possible geometry interpolation path between two coordinates.",
      geometryType: "Point",
      id: "point-simple",
      label: "Point: simple",
      pair: createDemoInterpolationGeometryPair("Point"),
    },
    {
      defaultStrategy: "hold",
      description:
        "The geometry type changes from Polygon to MultiPolygon, so interpolation falls back to holding the previous keyframe.",
      geometryType: "Polygon",
      id: "type-change-fallback",
      label: "Type change: Polygon to MultiPolygon",
      pair: {
        end: createDemoInterpolationGeometryPair("MultiPolygon").end,
        start: createDemoInterpolationGeometryPair("Polygon").start,
      },
    },
    {
      defaultStrategy: "hold",
      description:
        "The geometry type changes from LineString to MultiLineString, exercising the fallback path for incompatible line primitives.",
      geometryType: "LineString",
      id: "line-to-multiline-fallback",
      label: "Type change: LineString to MultiLineString",
      pair: {
        end: createDemoInterpolationGeometryPair("MultiLineString").end,
        start: createDemoInterpolationGeometryPair("LineString").start,
      },
    },
    {
      description:
        "One service region separates into three district polygons using collection-level topology fragments.",
      endCollection: createDemoTopologySplitCollection("end"),
      geometryType: "Polygon",
      id: "topology-polygon-split",
      kind: "topology",
      label: "Topology: polygon split",
      startCollection: createDemoTopologySplitCollection("start"),
    },
    {
      description:
        "Three district polygons consolidate into one service region using collection-level topology fragments.",
      endCollection: createDemoTopologyMergeCollection("end"),
      geometryType: "Polygon",
      id: "topology-polygon-merge",
      kind: "topology",
      label: "Topology: polygon merge",
      startCollection: createDemoTopologyMergeCollection("start"),
    },
    {
      description:
        "Two partially overlapping source and target regions show preserved, appearing, disappearing, and ambiguous area fragments.",
      endCollection: createDemoTopologyMixedOverlapCollection("end"),
      geometryType: "Polygon",
      id: "topology-mixed-overlap",
      kind: "topology",
      label: "Topology: mixed overlap",
      startCollection: createDemoTopologyMixedOverlapCollection("start"),
    },
  ];
}

function createDemoTopologySplitCollection(
  keyframe: DemoInterpolationKeyframeId,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  if (keyframe === "start") {
    return {
      features: [
        demoTopologyFeature("topology-source", "Service region", {
          coordinates: [
            [
              [-7.0, 43.5],
              [6.2, 43.8],
              [6.7, 49.0],
              [-6.4, 49.4],
              [-7.0, 43.5],
            ],
          ],
          type: "Polygon",
        }),
      ],
      type: "FeatureCollection",
    };
  }

  return {
    features: [
      demoTopologyFeature("topology-west", "West district", {
        coordinates: [
          [
            [-5.8, 44.4],
            [-1.3, 44.1],
            [-1.1, 50.0],
            [-6.0, 49.5],
            [-5.8, 44.4],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-central", "Central district", {
        coordinates: [
          [
            [-1.0, 44.0],
            [3.2, 44.5],
            [3.0, 50.2],
            [-0.8, 49.8],
            [-1.0, 44.0],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-east", "East district", {
        coordinates: [
          [
            [3.4, 44.4],
            [8.1, 44.8],
            [7.5, 50.3],
            [3.2, 49.9],
            [3.4, 44.4],
          ],
        ],
        type: "Polygon",
      }),
    ],
    type: "FeatureCollection",
  };
}

function createDemoTopologyMergeCollection(
  keyframe: DemoInterpolationKeyframeId,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  if (keyframe === "end") {
    return {
      features: [
        demoTopologyFeature("topology-target", "Merged service region", {
          coordinates: [
            [
              [-5.6, 44.4],
              [8.2, 44.8],
              [7.4, 50.3],
              [-5.1, 49.8],
              [-5.6, 44.4],
            ],
          ],
          type: "Polygon",
        }),
      ],
      type: "FeatureCollection",
    };
  }

  return {
    features: [
      demoTopologyFeature("topology-west", "West district", {
        coordinates: [
          [
            [-7.2, 43.3],
            [-2.5, 43.6],
            [-2.2, 48.8],
            [-6.8, 49.0],
            [-7.2, 43.3],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-central", "Central district", {
        coordinates: [
          [
            [-2.1, 43.6],
            [2.3, 43.4],
            [2.6, 49.0],
            [-1.8, 48.9],
            [-2.1, 43.6],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-east", "East district", {
        coordinates: [
          [
            [2.8, 43.7],
            [6.7, 43.5],
            [6.9, 49.2],
            [3.0, 49.0],
            [2.8, 43.7],
          ],
        ],
        type: "Polygon",
      }),
    ],
    type: "FeatureCollection",
  };
}

function createDemoTopologyMixedOverlapCollection(
  keyframe: DemoInterpolationKeyframeId,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  if (keyframe === "start") {
    return {
      features: [
        demoTopologyFeature("topology-northwest", "Northwest area", {
          coordinates: [
            [
              [-6.8, 44.1],
              [-1.0, 44.3],
              [-1.3, 49.2],
              [-6.4, 49.0],
              [-6.8, 44.1],
            ],
          ],
          type: "Polygon",
        }),
        demoTopologyFeature("topology-southeast", "Southeast area", {
          coordinates: [
            [
              [0.5, 43.7],
              [5.8, 43.9],
              [5.4, 48.8],
              [0.2, 48.5],
              [0.5, 43.7],
            ],
          ],
          type: "Polygon",
        }),
      ],
      type: "FeatureCollection",
    };
  }

  return {
    features: [
      demoTopologyFeature("topology-west-shift", "Shifted west area", {
        coordinates: [
          [
            [-5.4, 44.8],
            [0.1, 44.5],
            [0.0, 49.9],
            [-5.8, 49.6],
            [-5.4, 44.8],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-east-new", "New east area", {
        coordinates: [
          [
            [3.4, 44.2],
            [8.4, 44.8],
            [7.7, 50.0],
            [3.1, 49.3],
            [3.4, 44.2],
          ],
        ],
        type: "Polygon",
      }),
    ],
    type: "FeatureCollection",
  };
}

function demoTopologyFeature(
  id: string,
  label: string,
  geometry: TemporalGeoJsonSupportedGeometry,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>["features"][number] {
  return {
    geometry,
    id,
    properties: {
      kind: "topology-area",
      label,
      time: 0,
      trackId: id,
    },
    type: "Feature",
  };
}

function createDemoInterpolationGeometryPair(
  geometryType: DemoInterpolationGeometryType,
): DemoInterpolationGeometryPair {
  switch (geometryType) {
    case "Point":
      return {
        end: { coordinates: [10.2, 52.0], type: "Point" },
        start: { coordinates: [2.35, 48.85], type: "Point" },
      };
    case "MultiPoint":
      return {
        end: {
          coordinates: [
            [4.9, 52.36],
            [12.56, 55.67],
            [18.06, 59.32],
          ],
          type: "MultiPoint",
        },
        start: {
          coordinates: [
            [-9.13, 38.72],
            [-3.7, 40.41],
            [2.16, 41.38],
          ],
          type: "MultiPoint",
        },
      };
    case "LineString":
      return {
        end: {
          coordinates: [
            [2.35, 48.85],
            [6.96, 50.93],
            [9.99, 53.55],
            [18.06, 59.32],
          ],
          type: "LineString",
        },
        start: {
          coordinates: [
            [-3.7, 40.41],
            [2.16, 41.38],
            [7.58, 47.55],
            [11.58, 48.13],
          ],
          type: "LineString",
        },
      };
    case "MultiLineString":
      return {
        end: {
          coordinates: [
            [
              [4.9, 52.36],
              [9.99, 53.55],
              [12.56, 55.67],
            ],
            [
              [14.43, 50.07],
              [21.01, 52.22],
              [25.27, 54.68],
            ],
          ],
          type: "MultiLineString",
        },
        start: {
          coordinates: [
            [
              [-9.13, 38.72],
              [-3.7, 40.41],
              [2.16, 41.38],
            ],
            [
              [7.58, 47.55],
              [11.58, 48.13],
              [16.37, 48.2],
            ],
          ],
          type: "MultiLineString",
        },
      };
    case "Polygon":
      return {
        end: {
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
        },
        start: {
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
        },
      };
    case "MultiPolygon":
      return {
        end: {
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
        start: {
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
      };
  }
}

function createDemoMultiPolygonHolePair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [
            [-9.0, 37.1],
            [-2.4, 37.9],
            [-2.8, 41.8],
            [-8.8, 41.0],
            [-9.0, 37.1],
          ],
          [
            [-6.8, 38.7],
            [-5.3, 38.9],
            [-5.4, 39.8],
            [-6.7, 39.6],
            [-6.8, 38.7],
          ],
        ],
        [
          [
            [0.1, 40.0],
            [3.7, 40.4],
            [3.3, 43.3],
            [0.0, 42.8],
            [0.1, 40.0],
          ],
        ],
      ],
      type: "MultiPolygon",
    },
    start: {
      coordinates: [
        [
          [
            [-9.6, 37.4],
            [-3.0, 37.6],
            [-3.3, 41.3],
            [-9.4, 41.0],
            [-9.6, 37.4],
          ],
          [
            [-7.2, 38.4],
            [-5.9, 38.6],
            [-6.0, 39.5],
            [-7.0, 39.3],
            [-7.2, 38.4],
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
  };
}

function createDemoConcavePolygonPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [5.6, 45.3],
          [9.2, 45.7],
          [12.8, 45.4],
          [11.1, 47.2],
          [13.0, 49.2],
          [9.0, 48.4],
          [6.0, 49.1],
          [7.1, 47.0],
          [5.6, 45.3],
        ],
      ],
      type: "Polygon",
    },
    start: createDemoInterpolationGeometryPair("Polygon").start,
  };
}

function createDemoReversedRingPolygonPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [6.2, 48.9],
          [13.3, 48.5],
          [12.4, 45.1],
          [5.9, 45.6],
          [6.2, 48.9],
        ],
      ],
      type: "Polygon",
    },
    start: createDemoInterpolationGeometryPair("Polygon").start,
  };
}

function createDemoPolygonHoleAppearsPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [5.6, 45.3],
          [13.4, 45.4],
          [13.1, 49.4],
          [5.9, 49.0],
          [5.6, 45.3],
        ],
        [
          [8.4, 46.7],
          [10.8, 46.8],
          [10.6, 48.0],
          [8.7, 47.9],
          [8.4, 46.7],
        ],
      ],
      type: "Polygon",
    },
    start: {
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
    },
  };
}

function createDemoSliverPolygonPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [4.8, 44.9],
          [13.5, 45.8],
          [14.0, 49.5],
          [8.8, 48.7],
          [5.2, 50.2],
          [4.8, 44.9],
        ],
      ],
      type: "Polygon",
    },
    start: {
      coordinates: [
        [
          [6.8, 45.1],
          [12.8, 45.4],
          [12.2, 46.0],
          [6.6, 45.6],
          [6.8, 45.1],
        ],
      ],
      type: "Polygon",
    },
  };
}

function createDemoLineDensityPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [2.35, 48.85],
        [3.75, 49.35],
        [6.96, 50.93],
        [9.99, 53.55],
        [12.56, 55.67],
        [18.06, 59.32],
      ],
      type: "LineString",
    },
    start: {
      coordinates: [
        [-3.7, 40.41],
        [2.16, 41.38],
        [7.58, 47.55],
      ],
      type: "LineString",
    },
  };
}

function createDemoZigZagLinePair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [-8.9, 39.0],
        [-5.2, 43.2],
        [-1.4, 40.6],
        [2.4, 45.2],
        [6.8, 42.4],
        [11.8, 48.8],
      ],
      type: "LineString",
    },
    start: {
      coordinates: [
        [-8.9, 39.0],
        [2.0, 42.0],
        [11.8, 48.8],
      ],
      type: "LineString",
    },
  };
}

function createDemoMultiLineMissingBranchPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [4.9, 52.36],
          [9.99, 53.55],
          [12.56, 55.67],
          [18.06, 59.32],
        ],
      ],
      type: "MultiLineString",
    },
    start: createDemoInterpolationGeometryPair("MultiLineString").start,
  };
}

function createDemoMultiPointMismatchPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [4.9, 52.36],
        [12.56, 55.67],
      ],
      type: "MultiPoint",
    },
    start: createDemoInterpolationGeometryPair("MultiPoint").start,
  };
}

function getDemoInterpolationHandles(
  geometry: TemporalGeoJsonSupportedGeometry,
): DemoInterpolationHandle[] {
  switch (geometry.type) {
    case "Point":
      return [{ label: "Point", path: [] }];
    case "MultiPoint":
      return geometry.coordinates.map((_coordinate, index) => ({
        label: `Point ${index + 1}`,
        path: [index],
      }));
    case "LineString":
      return geometry.coordinates.map((_coordinate, index) => ({
        label:
          index === 0
            ? "Start"
            : index === geometry.coordinates.length - 1
              ? "End"
              : `Point ${index + 1}`,
        path: [index],
      }));
    case "MultiLineString":
      return geometry.coordinates.flatMap((line, lineIndex) =>
        line.map((_coordinate, coordinateIndex) => ({
          label: `Line ${lineIndex + 1} point ${coordinateIndex + 1}`,
          path: [lineIndex, coordinateIndex],
        })),
      );
    case "Polygon":
      return geometry.coordinates.flatMap((ring, ringIndex) =>
        ring.slice(0, -1).map((_coordinate, coordinateIndex) => ({
          label: `${ringIndex === 0 ? "Outer" : `Hole ${ringIndex}`} point ${coordinateIndex + 1}`,
          path: [ringIndex, coordinateIndex],
        })),
      );
    case "MultiPolygon":
      return geometry.coordinates.flatMap((polygon, polygonIndex) =>
        polygon.flatMap((ring, ringIndex) =>
          ring.slice(0, -1).map((_coordinate, coordinateIndex) => ({
            label: `Area ${polygonIndex + 1} ${
              ringIndex === 0 ? "outer" : `hole ${ringIndex}`
            } point ${coordinateIndex + 1}`,
            path: [polygonIndex, ringIndex, coordinateIndex],
          })),
        ),
      );
  }
}

function getDemoInterpolationPosition(
  geometry: TemporalGeoJsonSupportedGeometry,
  path: number[],
): [number, number] {
  switch (geometry.type) {
    case "Point":
      return geometry.coordinates;
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates[path[0] ?? 0] ?? geometry.coordinates[0]!;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates[path[0] ?? 0]?.[path[1] ?? 0] ?? geometry.coordinates[0]![0]!;
    case "MultiPolygon":
      return (
        geometry.coordinates[path[0] ?? 0]?.[path[1] ?? 0]?.[path[2] ?? 0] ??
        geometry.coordinates[0]![0]![0]!
      );
  }
}

function setDemoInterpolationPosition(
  geometry: TemporalGeoJsonSupportedGeometry,
  path: number[],
  position: [number, number],
): TemporalGeoJsonSupportedGeometry {
  switch (geometry.type) {
    case "Point":
      return { coordinates: position, type: "Point" };
    case "MultiPoint":
      return {
        coordinates: geometry.coordinates.map((coordinate, index) =>
          index === (path[0] ?? 0) ? position : coordinate,
        ),
        type: "MultiPoint",
      };
    case "LineString":
      return {
        coordinates: geometry.coordinates.map((coordinate, index) =>
          index === (path[0] ?? 0) ? position : coordinate,
        ),
        type: "LineString",
      };
    case "MultiLineString":
      return {
        coordinates: geometry.coordinates.map((line, lineIndex) =>
          lineIndex === (path[0] ?? 0)
            ? line.map((coordinate, coordinateIndex) =>
                coordinateIndex === (path[1] ?? 0) ? position : coordinate,
              )
            : line,
        ),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: geometry.coordinates.map((ring, ringIndex) =>
          ringIndex === (path[0] ?? 0)
            ? setDemoInterpolationRingPosition(ring, path[1] ?? 0, position)
            : ring,
        ),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: geometry.coordinates.map((polygon, polygonIndex) =>
          polygonIndex === (path[0] ?? 0)
            ? polygon.map((ring, ringIndex) =>
                ringIndex === (path[1] ?? 0)
                  ? setDemoInterpolationRingPosition(ring, path[2] ?? 0, position)
                  : ring,
              )
            : polygon,
        ),
        type: "MultiPolygon",
      };
  }
}

function setDemoInterpolationRingPosition(
  ring: [number, number][],
  index: number,
  position: [number, number],
) {
  return ring.map((coordinate, coordinateIndex) => {
    if (
      coordinateIndex === index ||
      (index === 0 && coordinateIndex === ring.length - 1) ||
      (index === ring.length - 1 && coordinateIndex === 0)
    ) {
      return position;
    }

    return coordinate;
  });
}

function GeoJsonGeometryExample() {
  const tracks = createTemporalGeoJsonTracksFromGeoJson(demoGeoJsonCollection);
  const frame = createTemporalGeoJsonPlaybackIndex(tracks).getFeatureCollectionAtTime(0);

  return (
    <section className="demo-geojson-example" aria-label="GeoJSON geometry examples">
      <MapView
        defaultViewState={{ center: [8.4, 50.4], zoom: 4.4 }}
        fitToData={false}
        mapLabel="Rendered GeoJSON geometries"
        mapStyle={demoMapStyle}
        style={{ minHeight: 620 }}
      >
        <HeatLayer
          heatmapColorRamp={getHeatLayerColorRamp("#0f766e")}
          layerId="geojson-heat-from-point-features"
          points={demoPoints}
          weightMetric="demand"
        />
        <FlowLayer
          flowColor="#b45309"
          flows={demoFlows}
          layerId="geojson-flows-from-line-features"
          maxWidth={14}
          showEndpoints
          weightMetric="trips"
        />
        <GeoJsonLayer
          featureCollection={frame}
          getFeatureStyle={(feature) => getGeoJsonFeatureStyle(feature.geometry.type)}
          layerId="geojson-primitives"
          renderFeaturePopup={(feature) => (
            <div className="demo-popup">
              <strong>{String(feature.properties.temporalLabel)}</strong>
              <span>{feature.geometry.type}</span>
            </div>
          )}
          renderFeatureTooltip={(feature) =>
            `${String(feature.properties.temporalLabel)} (${feature.geometry.type})`
          }
        />
      </MapView>
      <div className="demo-geojson-example__legend">
        <span>Point heat from GeoJSON point features</span>
        <span>Flows from GeoJSON LineString features</span>
        <span>{frame.features.length} rendered temporal GeoJSON primitives</span>
      </div>
    </section>
  );
}

function renderComposedLayer(layer: DemoLayerConfig, points: Array<MapPoint<DemoPointProperties>>) {
  switch (layer.kind) {
    case "bubbles":
      return (
        <BubbleLayer
          bubbleColor={layer.color}
          key={layer.id}
          layerId={layer.id}
          maxRadius={28}
          points={points}
          renderFeatureTooltip={(feature) => feature.point.label}
          weightMetric="demand"
        />
      );
    case "clusters":
      return (
        <ClusterLayer
          clusterRadius={72}
          key={layer.id}
          layerId={layer.id}
          points={points}
          renderFeatureTooltip={(feature) =>
            feature.kind === "cluster" ? feature.pointCountAbbreviated : feature.point.label
          }
        />
      );
    case "flows":
      return (
        <FlowLayer
          flowColor={layer.color}
          flows={demoFlows}
          key={layer.id}
          layerId={layer.id}
          maxWidth={16}
          showEndpoints
          weightMetric="trips"
        />
      );
    case "heat":
      return (
        <HeatLayer
          heatmapColorRamp={getHeatLayerColorRamp(layer.color)}
          key={layer.id}
          layerId={layer.id}
          points={points}
          weightMetric="demand"
        />
      );
    case "points":
    default:
      return (
        <PointLayer
          key={layer.id}
          layerId={layer.id}
          pointColor={layer.color}
          points={points}
          renderFeatureTooltip={(feature) => feature.point.label}
        />
      );
  }
}

function getLayerKindLabel(kind: DemoLayerKind) {
  return layerKinds.find((item) => item.id === kind)?.label ?? "Layer";
}

function getGeoJsonFeatureStyle(geometryType: string) {
  switch (geometryType) {
    case "Point":
    case "MultiPoint":
      return {
        pointColor: "#be123c",
        pointRadius: 8,
      };
    case "LineString":
    case "MultiLineString":
      return {
        lineColor: "#2563eb",
        lineWidth: 5,
      };
    case "Polygon":
    case "MultiPolygon":
      return {
        polygonFillColor: "#14b8a6",
        polygonFillOpacity: 0.26,
        polygonStrokeColor: "#0f766e",
        polygonStrokeWidth: 2.5,
      };
    default:
      return {};
  }
}

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

function point(
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

function getDemoTimelineGeographyStyle(feature: { properties: Partial<DemoGeoJsonProperties> }) {
  switch (feature.properties.kind) {
    case "checkpoint":
      return {
        pointColor: "#be123c",
        pointRadius: 8,
      };
    case "relay-pair":
      return {
        pointColor: "#7c3aed",
        pointRadius: 6,
      };
    case "corridor":
      return {
        lineColor: "#0e7490",
        lineOpacity: 0.8,
        lineWidth: 4,
      };
    case "branch-corridors":
      return {
        lineColor: "#4f46e5",
        lineOpacity: 0.72,
        lineWidth: 3,
      };
    case "operating-area":
      return {
        polygonFillColor: "#f59e0b",
        polygonFillOpacity: 0.12,
        polygonStrokeColor: "#b45309",
        polygonStrokeWidth: 2,
      };
    default:
      return {
        polygonFillColor: "#14b8a6",
        polygonFillOpacity: 0.16,
        polygonStrokeColor: "#0f766e",
        polygonStrokeWidth: 2.5,
      };
  }
}

function geoJsonFeature(
  trackId: string,
  kind: DemoGeoJsonProperties["kind"],
  label: string,
  geometry: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>["features"][number]["geometry"],
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>["features"][number] {
  return {
    geometry,
    properties: {
      kind,
      label,
      time: 0,
      trackId,
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

function formatDemoTimelineTime(time: number) {
  const totalMinutes = Math.max(0, Math.round(time));
  const hours = 8 + Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
