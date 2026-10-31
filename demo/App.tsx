import { useMemo, useState } from "react";
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
import type {
  GeoJsonEditMode,
  GeoJsonEditorSelection,
  HeatFieldRenderMode,
  MapBeeLineMeasurement,
  MapBeeLineMeasurementDraft,
  MapPoint,
  MapViewState,
  PointMapFeature,
} from "@moritzbrantner/maps";

import { DemoMap } from "./components/DemoMap";
import { FlowVolumeLegend } from "./components/FlowVolumeLegend";
import { emptyGeoJsonEditorSelection, GeoJsonEditorPanel } from "./components/GeoJsonEditorPanel";
import { HeatControlsPanel } from "./components/HeatControlsPanel";
import { initialLayers, LayerManagerPanel } from "./components/LayerManagerPanel";
import { TimelineSummaryPanel } from "./components/TimelineSummaryPanel";
import { demoFlows } from "./data/demo-flows";
import { demoGeoJsonCollection } from "./data/demo-geojson";
import { demoPointHubs, demoPoints, demoRegions, point } from "./data/demo-points";
import { useDemoE2EProbe } from "./lib/e2e-probe";
import type {
  DemoDataset,
  DemoLayerConfig,
  DemoPointProperties,
  DemoView,
  EditablePointContext,
} from "./types";

const views: Array<{ id: DemoView; label: string }> = [
  { id: "clusters", label: "Clusters" },
  { id: "points", label: "Points" },
  { id: "heat", label: "Heat" },
  { id: "flows", label: "Flows" },
  { id: "composed", label: "Composed" },
  { id: "temporal", label: "Timeline" },
  { id: "interpolation", label: "Interpolation" },
  { id: "history", label: "History" },
  { id: "globe", label: "Globe" },
  { id: "geojson", label: "GeoJSON" },
  { id: "editor", label: "Editor" },
];

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
  const [measurementDraft, setMeasurementDraft] = useState<MapBeeLineMeasurementDraft | null>(null);
  const [editablePoints, setEditablePoints] =
    useState<Array<MapPoint<DemoPointProperties>>>(demoPointHubs);
  const [editableGeoJson, setEditableGeoJson] = useState(demoGeoJsonCollection);
  const [editMode, setEditMode] = useState<GeoJsonEditMode>("select");
  const [geoJsonSelection, setGeoJsonSelection] = useState<GeoJsonEditorSelection>(
    emptyGeoJsonEditorSelection,
  );
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
  const e2eRegistration = useDemoE2EProbe({
    editMode,
    editableGeoJson,
    geoJsonSelection,
    measurementDraft,
    measurements,
    selectedFlowId,
    selectedPointId,
    view,
    viewport,
    visibleEditablePoints,
    visiblePoints,
  });

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
          <DemoMap
            view={view}
            points={visiblePoints}
            measurements={measurements}
            setMeasurements={setMeasurements}
            setMeasurementDraft={setMeasurementDraft}
            isMeasuring={isMeasuring}
            setViewport={setViewport}
            layers={layers}
            editablePoints={editablePointContext}
            editableGeoJson={editableGeoJson}
            setEditableGeoJson={setEditableGeoJson}
            editMode={editMode}
            setEditMode={setEditMode}
            geoJsonSelection={geoJsonSelection}
            setGeoJsonSelection={setGeoJsonSelection}
            heatFieldRenderMode={heatFieldRenderMode}
            heatFieldContourLineWidth={heatFieldContourLineWidth}
            showHeatDataPoints={showHeatDataPoints}
            selectedFlowId={selectedFlowId}
            setSelectedFlowId={setSelectedFlowId}
            temporalTime={temporalTime}
            setTemporalTime={setTemporalTime}
            e2eRegistration={e2eRegistration}
          />
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
                <LayerManagerPanel layers={layers} setLayers={setLayers} />
              ) : null}
              {view === "heat" ? (
                <HeatControlsPanel
                  contourLineWidth={heatFieldContourLineWidth}
                  onContourLineWidthChange={setHeatFieldContourLineWidth}
                  onRenderModeChange={setHeatFieldRenderMode}
                  onShowDataPointsChange={setShowHeatDataPoints}
                  renderMode={heatFieldRenderMode}
                  showDataPoints={showHeatDataPoints}
                />
              ) : null}
              {view === "flows" ? <FlowVolumeLegend flows={demoFlows} /> : null}
              {view === "temporal" ? <TimelineSummaryPanel /> : null}
              {view === "editor" ? (
                <GeoJsonEditorPanel
                  editMode={editMode}
                  editableGeoJson={editableGeoJson}
                  geoJsonSelection={geoJsonSelection}
                  setEditMode={setEditMode}
                  setEditableGeoJson={setEditableGeoJson}
                  setGeoJsonSelection={setGeoJsonSelection}
                />
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
