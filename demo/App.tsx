import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

import {
  BubbleMap,
  BeeLineMeasurementLayer,
  BubbleLayer,
  ClusterLayer,
  ClusteredMap,
  FlowLayer,
  FlowMap,
  HeatLayer,
  HeatMap,
  MapView,
  PointMap,
  PointLayer,
  TemporalClusteredMap,
  type MapBeeLineMeasurement,
  type MapBeeLineMeasurementResult,
  type MapFlow,
  type MapPoint,
  type MapViewState,
  type TemporalMapTrack,
} from "@moritzbrantner/maps";

type DemoPointProperties = {
  city: string;
  region: string;
};

type DemoView = "clusters" | "points" | "heat" | "flows" | "composed" | "temporal" | "globe";
type DemoLayerKind = "clusters" | "points" | "bubbles" | "heat" | "flows";

type DemoLayerConfig = {
  color: string;
  enabled: boolean;
  id: string;
  kind: DemoLayerKind;
  name: string;
};

const demoPoints: Array<MapPoint<DemoPointProperties>> = [
  point("berlin", "Berlin", "DACH", 52.52, 13.405, 940),
  point("hamburg", "Hamburg", "DACH", 53.551, 9.9937, 420),
  point("munich", "Munich", "DACH", 48.1351, 11.582, 610),
  point("cologne", "Cologne", "DACH", 50.9375, 6.9603, 350),
  point("zurich", "Zurich", "DACH", 47.3769, 8.5417, 520),
  point("vienna", "Vienna", "DACH", 48.2082, 16.3738, 560),
  point("paris", "Paris", "West", 48.8566, 2.3522, 880),
  point("london", "London", "West", 51.5072, -0.1276, 910),
  point("amsterdam", "Amsterdam", "West", 52.3676, 4.9041, 470),
  point("brussels", "Brussels", "West", 50.8503, 4.3517, 300),
  point("madrid", "Madrid", "South", 40.4168, -3.7038, 760),
  point("barcelona", "Barcelona", "South", 41.3874, 2.1686, 690),
  point("milan", "Milan", "South", 45.4642, 9.19, 580),
  point("rome", "Rome", "South", 41.9028, 12.4964, 640),
  point("warsaw", "Warsaw", "East", 52.2297, 21.0122, 430),
  point("prague", "Prague", "East", 50.0755, 14.4378, 390),
  point("copenhagen", "Copenhagen", "North", 55.6761, 12.5683, 330),
  point("stockholm", "Stockholm", "North", 59.3293, 18.0686, 370),
  point("oslo", "Oslo", "North", 59.9139, 10.7522, 280),
  point("helsinki", "Helsinki", "North", 60.1699, 24.9384, 260),
];

const demoFlows: MapFlow[] = [
  flow("berlin-paris", "Berlin to Paris", [13.405, 52.52], [2.3522, 48.8566], 180),
  flow("berlin-london", "Berlin to London", [13.405, 52.52], [-0.1276, 51.5072], 145),
  flow("hamburg-stockholm", "Hamburg to Stockholm", [9.9937, 53.551], [18.0686, 59.3293], 82),
  flow("munich-milan", "Munich to Milan", [11.582, 48.1351], [9.19, 45.4642], 120),
  flow("vienna-prague", "Vienna to Prague", [16.3738, 48.2082], [14.4378, 50.0755], 96),
  flow("madrid-barcelona", "Madrid to Barcelona", [-3.7038, 40.4168], [2.1686, 41.3874], 165),
  flow("amsterdam-brussels", "Amsterdam to Brussels", [4.9041, 52.3676], [4.3517, 50.8503], 74),
];

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

const views: Array<{ id: DemoView; label: string }> = [
  { id: "clusters", label: "Clusters" },
  { id: "points", label: "Points" },
  { id: "heat", label: "Heat" },
  { id: "flows", label: "Flows" },
  { id: "composed", label: "Composed" },
  { id: "temporal", label: "Timeline" },
  { id: "globe", label: "Globe" },
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

export function App() {
  const [view, setView] = useState<DemoView>("clusters");
  const [selectedRegion, setSelectedRegion] = useState("all");
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [layers, setLayers] = useState<DemoLayerConfig[]>(initialLayers);
  const [measurements, setMeasurements] = useState<MapBeeLineMeasurement[]>([]);
  const [viewport, setViewport] = useState<MapViewState>({
    center: [13.405, 52.52],
    zoom: 5,
  });
  const visiblePoints = useMemo(
    () =>
      selectedRegion === "all"
        ? demoPoints
        : demoPoints.filter((item) => item.properties?.region === selectedRegion),
    [selectedRegion],
  );
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
              name: patch.kind && patch.kind !== layer.kind ? getLayerKindLabel(patch.kind) : layer.name,
            }
          : layer,
      ),
    );
  };
  const removeLayer = (id: string) => {
    setLayers((current) => current.filter((layer) => layer.id !== id));
  };

  return (
    <main className="demo-shell">
      <header className="demo-toolbar">
        <div>
          <p className="demo-kicker">@moritzbrantner/maps</p>
          <h1>Interactive map component workbench</h1>
        </div>
        <div className="demo-actions" aria-label="Demo controls">
          <label className="demo-field">
            <span>Region</span>
            <select value={selectedRegion} onChange={(event) => setSelectedRegion(event.target.value)}>
              <option value="all">All regions</option>
              <option value="DACH">DACH</option>
              <option value="West">West</option>
              <option value="South">South</option>
              <option value="East">East</option>
              <option value="North">North</option>
            </select>
          </label>
          <button
            className="demo-button"
            type="button"
            aria-pressed={isMeasuring}
            onClick={() => setIsMeasuring((value) => !value)}
          >
            {isMeasuring ? "Measuring" : "Measure"}
          </button>
          <button className="demo-button" type="button" onClick={() => setMeasurements([])}>
            Clear
          </button>
        </div>
      </header>

      <nav className="demo-tabs" aria-label="Map examples">
        {views.map((item) => (
          <button
            key={item.id}
            type="button"
            className="demo-tab"
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <section className="demo-stage">
        <div className="demo-map-frame">
          {renderMap(view, visiblePoints, measurements, setMeasurements, isMeasuring, setViewport, layers)}
        </div>
        <aside className="demo-inspector" aria-label="Current dataset">
          <h2>Dataset</h2>
          <dl>
            <div>
              <dt>Viewport</dt>
              <dd>
                {viewport.center[0].toFixed(2)}, {viewport.center[1].toFixed(2)} /{" "}
                {viewport.zoom.toFixed(1)}
              </dd>
            </div>
            <div>
              <dt>Points</dt>
              <dd>{visiblePoints.length}</dd>
            </div>
            <div>
              <dt>Demand</dt>
              <dd>{visiblePoints.reduce((total, item) => total + (item.metrics?.demand ?? 0), 0)}</dd>
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
                    <button
                      className="demo-button demo-button--compact"
                      key={kind.id}
                      type="button"
                      onClick={() => addLayer(kind.id)}
                    >
                      + {kind.label}
                    </button>
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
                        onChange={(event) => updateLayer(layer.id, { enabled: event.target.checked })}
                      />
                      <span>{layer.name}</span>
                    </label>
                    <label className="demo-field">
                      <span>Type</span>
                      <select
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
                      </select>
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
                    <button
                      className="demo-button demo-button--compact"
                      type="button"
                      onClick={() => removeLayer(layer.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  );
}

function renderMap(
  view: DemoView,
  points: Array<MapPoint<DemoPointProperties>>,
  measurements: MapBeeLineMeasurement[],
  setMeasurements: Dispatch<SetStateAction<MapBeeLineMeasurement[]>>,
  isMeasuring: boolean,
  setViewport: Dispatch<SetStateAction<MapViewState>>,
  layers: DemoLayerConfig[],
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
          onViewStateChange={setViewport}
          points={points}
          pointColor="#115e59"
          renderFeaturePopup={(feature) => (
            <div className="demo-popup">
              <strong>{feature.point.label}</strong>
              <span>{feature.point.metrics.demand ?? 0} demand</span>
            </div>
          )}
          renderFeatureTooltip={(feature) => feature.point.label}
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
          {layers.filter((layer) => layer.enabled).map((layer) => renderComposedLayer(layer, points))}
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

function renderComposedLayer(
  layer: DemoLayerConfig,
  points: Array<MapPoint<DemoPointProperties>>,
) {
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

function point(
  id: string,
  city: string,
  region: string,
  latitude: number,
  longitude: number,
  demand: number,
): MapPoint<DemoPointProperties> {
  return {
    id,
    label: city,
    latitude,
    longitude,
    metrics: { demand },
    properties: { city, region },
  };
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
