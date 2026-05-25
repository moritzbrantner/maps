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
  type MapPoint,
  type PointMapFeature,
  type MapViewState,
  type GeoJsonEditMode,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalMapTrack,
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
  kind: string;
  label: string;
  time: number;
  trackId: string;
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

const demoTracks: TemporalMapTrack[] = [
  track("cargo-1", "North sea freight", [
    [0, 51.5072, -0.1276, 70],
    [25, 52.3676, 4.9041, 110],
    [50, 53.551, 9.9937, 150],
    [75, 55.6761, 12.5683, 130],
    [100, 59.3293, 18.0686, 90],
  ]),
  track("cargo-2", "Alpine express", [
    [0, 45.4642, 9.19, 80],
    [25, 47.3769, 8.5417, 120],
    [50, 48.1351, 11.582, 180],
    [75, 48.2082, 16.3738, 140],
    [100, 50.0755, 14.4378, 100],
  ]),
  track("cargo-3", "Iberia connector", [
    [0, 40.4168, -3.7038, 110],
    [25, 41.3874, 2.1686, 160],
    [50, 45.4642, 9.19, 130],
    [75, 41.9028, 12.4964, 100],
    [100, 48.8566, 2.3522, 150],
  ]),
];

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
  const [layers, setLayers] = useState<DemoLayerConfig[]>(initialLayers);
  const [measurements, setMeasurements] = useState<MapBeeLineMeasurement[]>([]);
  const [editablePoints, setEditablePoints] =
    useState<Array<MapPoint<DemoPointProperties>>>(demoPointHubs);
  const [editableGeoJson, setEditableGeoJson] = useState(demoGeoJsonCollection);
  const [editMode, setEditMode] = useState<GeoJsonEditMode>("select");
  const [selectedGeoJsonId, setSelectedGeoJsonId] = useState<string | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
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
            selectedGeoJsonId,
            setSelectedGeoJsonId,
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
              {view === "editor" ? (
                <div className="demo-layer-manager" aria-label="GeoJSON editor controls">
                  <div className="demo-layer-manager__header">
                    <h2>Editor</h2>
                  </div>
                  <div className="demo-editor-mode-grid">
                    {editorModes.map((mode) => (
                      <Button
                        aria-pressed={editMode === mode.id}
                        key={mode.id}
                        size="sm"
                        variant={editMode === mode.id ? "default" : "secondary"}
                        type="button"
                        onClick={() => setEditMode(mode.id)}
                      >
                        {mode.label}
                      </Button>
                    ))}
                  </div>
                  <dl className="grid gap-3 [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-3 [&>div]:border-b [&>div]:border-border [&>div]:pb-3 [&>div:last-child]:border-b-0 [&>div:last-child]:pb-0 [&_dd]:m-0 [&_dd]:font-semibold [&_dd]:tabular-nums [&_dt]:text-sm [&_dt]:font-medium [&_dt]:text-muted-foreground">
                    <div>
                      <dt>Mode</dt>
                      <dd>{editMode}</dd>
                    </div>
                    <div>
                      <dt>Selected</dt>
                      <dd>{selectedGeoJsonId ?? "None"}</dd>
                    </div>
                    <div>
                      <dt>Features</dt>
                      <dd>{editableGeoJson.features.length}</dd>
                    </div>
                  </dl>
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
  selectedGeoJsonId: string | null,
  setSelectedGeoJsonId: Dispatch<SetStateAction<string | null>>,
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
          getWeight={(item) => item.metrics?.demand ?? 1}
          onViewStateChange={setViewport}
          points={points}
          style={{ minHeight: 620 }}
        />
      );
    case "flows":
      return (
        <FlowMap
          {...sharedMeasurementProps}
          flowColor="#b45309"
          flows={demoFlows}
          maxWidth={18}
          onViewStateChange={setViewport}
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
          loopPlayback
          playbackRate={8}
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
          initialViewState={{ center: [8.4, 50.4], zoom: 4.4 }}
          onFeatureCollectionChange={(next) => setEditableGeoJson(next)}
          onSelectionChange={setSelectedGeoJsonId}
          selectedFeatureId={selectedGeoJsonId}
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

function track(
  id: string,
  label: string,
  frames: Array<[time: number, latitude: number, longitude: number, demand: number]>,
): TemporalMapTrack {
  return {
    id,
    label,
    frames: frames.map(([time, latitude, longitude, demand]) => ({
      latitude,
      longitude,
      metrics: { demand },
      time,
    })),
  };
}
