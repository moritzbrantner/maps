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
  GeoJsonLayer,
  HeatLayer,
  HeatMap,
  MapView,
  PointMap,
  PointLayer,
  TemporalClusteredMap,
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
  type MapBeeLineMeasurement,
  type MapBeeLineMeasurementResult,
  type MapFlow,
  type FlowMapFeature,
  type MapPoint,
  type HeatFieldRenderMode,
  type PointMapFeature,
  type MapViewState,
  type GeoJsonEditMode,
  type GeoJsonEditorSelection,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonSupportedGeometry,
  type TemporalMapTrack,
  moveGeoJsonGeometry,
} from "@moritzbrantner/maps";

type DemoPointProperties = {
  city: string;
  region: string;
};

type DemoPointGeoJsonProperties = DemoPointProperties & {
  demand: number;
  label: string;
};

type DemoFlowGeoJsonProperties = {
  label: string;
  trips: number;
};

type DemoGeoJsonProperties = {
  groupId?: string;
  kind: string;
  label: string;
  time: number;
  trackId: string;
  visible?: boolean;
};

type DemoTimelineProperties = {
  corridor: string;
  status: "loading" | "in-transit" | "handoff" | "arrived";
};

type DemoTimelineStop = {
  city: string;
  demand: number;
  delayMinutes: number;
  latitude: number;
  longitude: number;
  status: DemoTimelineProperties["status"];
  time: number;
};

type DemoView =
  | "clusters"
  | "points"
  | "heat"
  | "flows"
  | "composed"
  | "temporal"
  | "globe"
  | "geojson"
  | "editor";
type DemoLayerKind = "clusters" | "points" | "bubbles" | "heat" | "flows";

type DemoLayerConfig = {
  color: string;
  enabled: boolean;
  id: string;
  kind: DemoLayerKind;
  name: string;
};

type DemoDataset = {
  points: Array<MapPoint<DemoPointProperties>>;
  regions: string[];
};

type EditablePointContext = {
  onCreatePoint: (coordinates: [longitude: number, latitude: number]) => void;
  onDeletePoint: (feature: PointMapFeature<DemoPointProperties>) => void;
  onMovePoint: (
    feature: PointMapFeature<DemoPointProperties>,
    coordinates: [longitude: number, latitude: number],
  ) => void;
  onSelectPoint: (feature: PointMapFeature<DemoPointProperties> | null) => void;
  points: Array<MapPoint<DemoPointProperties>>;
  selectedPointId: string | null;
};

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

const demoTimelineKeyframeCount = demoTracks.reduce(
  (total, item) => total + item.frames.length,
  0,
);

const demoTimelineGeoJsonCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> = {
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
    timelineGeoJsonFeature("timeline-nordic-corridor", "corridor", "Nordic winter corridor", 30, {
      coordinates: [
        [4.9041, 52.3676],
        [9.9937, 53.551],
        [12.5683, 55.6761],
        [18.0686, 59.3293],
      ],
      type: "LineString",
    }),
    timelineGeoJsonFeature("timeline-nordic-corridor", "corridor", "Nordic winter corridor", 90, {
      coordinates: [
        [9.9937, 53.551],
        [12.5683, 55.6761],
        [18.0686, 59.3293],
        [24.9384, 60.1699],
      ],
      type: "LineString",
    }),
    timelineGeoJsonFeature("timeline-iberia-window", "operating-area", "Iberian operating window", 0, {
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
    }),
    timelineGeoJsonFeature("timeline-iberia-window", "operating-area", "Iberian operating window", 70, {
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
    }),
    timelineGeoJsonFeature("timeline-iberia-window", "operating-area", "Iberian operating window", 100, {
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
    }, false),
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
  { id: "globe", label: "Globe" },
  { id: "geojson", label: "GeoJSON" },
  { id: "editor", label: "Editor" },
];

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
          domainBounds={[-25, 34, 35, 66]}
          fieldColumns={420}
          fieldColorRamp={getTemperatureFieldColorRamp()}
          fieldRows={260}
          fieldRenderMode={heatFieldRenderMode}
          fieldValueDomain={[12, 34]}
          fieldContourColor="#111827"
          fieldContourLevels={11}
          fieldContourLineWidth={heatFieldContourLineWidth}
          fieldContourValueFormat={formatTemperatureValue}
          heatmapSurfaceMode="field"
          interpolationK={10}
          interpolationPower={2}
          mapLabel="Europe temperature surface"
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
          flowShape="arc"
          flows={demoFlows}
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
          geoJsonOverlayProps={{
            getFeatureStyle: getDemoTimelineGeographyStyle,
          }}
          initialViewState={demoTimelineViewState}
          loopPlayback
          mapLabel="European logistics timeline"
          onViewStateChange={setViewport}
          playbackRate={6}
          timelineLabel="Shipment timeline"
          tracks={demoTracks}
          style={{ minHeight: 560 }}
          timeStep={1}
        />
      );
    case "globe":
      return (
        <BubbleMap
          {...sharedMeasurementProps}
          bubbleColor="#0f766e"
          mapDisplay="globe"
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

function GeoJsonGeometryExample() {
  const tracks = createTemporalGeoJsonTracksFromGeoJson(demoGeoJsonCollection);
  const frame = createTemporalGeoJsonPlaybackIndex(tracks).getFeatureCollectionAtTime(0);

  return (
    <section className="demo-geojson-example" aria-label="GeoJSON geometry examples">
      <MapView
        defaultViewState={{ center: [8.4, 50.4], zoom: 4.4 }}
        fitToData={false}
        mapLabel="Rendered GeoJSON geometries"
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

function FlowVolumeLegend({ flows }: { flows: MapFlow[] }) {
  const values = getDemoFlowLegendValues(flows);

  return (
    <div className="demo-flow-legend" aria-label="Flow volume">
      <div className="demo-layer-manager__header">
        <h2>Flow volume</h2>
      </div>
      <div className="demo-flow-legend__rows">
        {values.map((item) => (
          <div className="demo-flow-legend__row" key={item.label}>
            <span className="demo-flow-legend__sample" aria-hidden="true">
              <span style={{ height: item.strokeWidth }} />
            </span>
            <span className="demo-flow-legend__label">
              <span>{item.label}</span>
              <strong>{item.value.toLocaleString()} trips</strong>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderDemoFlowTooltip(feature: FlowMapFeature) {
  return (
    <div className="demo-popup">
      <strong>{feature.flow.label}</strong>
      <span>{feature.rawValue.toLocaleString()} trips</span>
    </div>
  );
}

function renderDemoFlowPopup(feature: FlowMapFeature) {
  return (
    <div className="demo-popup">
      <strong>{feature.flow.label}</strong>
      <span>{feature.rawValue.toLocaleString()} trips</span>
      <span>From {formatDemoCoordinate(feature.flow.from)}</span>
      <span>To {formatDemoCoordinate(feature.flow.to)}</span>
    </div>
  );
}

function getDemoFlowLegendValues(flows: MapFlow[]) {
  const values = flows
    .map((item) => item.metrics?.trips ?? 0)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (values.length === 0) {
    return [
      { label: "Low", strokeWidth: 3, value: 0 },
      { label: "Medium", strokeWidth: 7, value: 0 },
      { label: "High", strokeWidth: 12, value: 0 },
    ];
  }

  return [
    { label: "Low", strokeWidth: 3, value: values[0]! },
    { label: "Medium", strokeWidth: 7, value: values[Math.floor(values.length / 2)]! },
    { label: "High", strokeWidth: 12, value: values.at(-1)! },
  ];
}

function formatDemoCoordinate([longitude, latitude]: [longitude: number, latitude: number]) {
  return `${longitude.toFixed(2)}, ${latitude.toFixed(2)}`;
}

function getLayerKindLabel(kind: DemoLayerKind) {
  return layerKinds.find((item) => item.id === kind)?.label ?? "Layer";
}

function getHeatLayerColorRamp(color: string) {
  return [
    [0, "rgba(15, 23, 42, 0)"],
    [0.18, "#67e8f9"],
    [0.58, color],
    [1, "#dc2626"],
  ] as const;
}

function getTemperatureFieldColorRamp() {
  return [
    [0, "#1d4ed8"],
    [0.22, "#38bdf8"],
    [0.42, "#22c55e"],
    [0.62, "#fde047"],
    [0.8, "#fb923c"],
    [1, "#dc2626"],
  ] as const;
}

function formatTemperatureValue(value: number) {
  return `${value.toFixed(1)} C`;
}

function getGeoJsonFeatureStyle(geometryType: string) {
  switch (geometryType) {
    case "Point":
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

function getDemoTimelineGeographyStyle(feature: {
  properties: Partial<DemoGeoJsonProperties>;
}) {
  switch (feature.properties.kind) {
    case "corridor":
      return {
        lineColor: "#0e7490",
        lineOpacity: 0.8,
        lineWidth: 4,
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
