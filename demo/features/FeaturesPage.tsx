import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

import {
  ClusterLayer,
  createMapScopedTimelineClock,
  FlowLayer,
  GeoJsonLayer,
  HeatMap,
  MapScopedTimelineControls,
  MapView,
  PointLayer,
  TemporalClusteredMap,
  useMapScopedTimelineSnapshot,
  type AggregatedMapFeature,
  type HeatFieldRenderMode,
  type MapViewState,
} from "../../src";
import { HeatControlsPanel } from "../components/HeatControlsPanel";
import { createAtlasTileset } from "../atlas-source";
import {
  demoAtlasTemperatureBounds,
  demoAtlasTemperaturePoints,
} from "../data/demo-atlas-temperatures";
import { demoFlows } from "../data/demo-flows";
import { demoGeoJsonCollection } from "../data/demo-geojson";
import {
  demoPointHubs,
  demoPoints,
  demoTemperatureDomainBounds,
  demoTemperatureFieldColorRamp,
  demoTemperaturePoints,
  demoTemperatureValueDomain,
} from "../data/demo-points";
import { demoTracks, formatDemoTimelineTime } from "../data/demo-timeline";
import { formatTemperatureValue } from "../lib/format";
import { getDemoFeatureId, getDemoGeoJsonLabel } from "../lib/geojson-features";
import { createShowcaseTileset } from "../showcase-tileset";
import {
  comingFeatures,
  featureRoutes,
  featureSearch,
  readFeatureRoute,
  type FeatureId,
  type HeatBasemap,
  type FeatureRoute,
} from "./feature-route";

/** Explicit source-free comparison for the heat controls and other feature families. */
const featureBackground = {
  layers: [{ id: "background", paint: { "background-color": "#e6ece8" }, type: "background" }],
  sources: {},
  version: 8,
} as const;

const europeView: MapViewState = { center: [8.8, 50.2], zoom: 3.6 };
const mapStyle = { height: "100%", minHeight: 0 } as const;

/** `/features/`: try each first-party capability family on the Rust/WASM runtime (#176). */
export function FeaturesPage() {
  const [route, setRoute] = useState<FeatureRoute>(() => readFeatureRoute(location.search));

  const navigate = useCallback((next: FeatureRoute) => {
    setRoute(next);
    const search = featureSearch(next);
    if (search !== location.search) history.pushState(null, "", search);
  }, []);
  useEffect(() => {
    const onPopState = () => setRoute(readFeatureRoute(location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  // Keep the shared URL canonical, e.g. a bare `/features/` names its default feature.
  useEffect(() => {
    const search = featureSearch(route);
    if (search !== location.search) history.replaceState(null, "", search);
  }, [route]);

  const openFeature = (event: MouseEvent<HTMLAnchorElement>, feature: FeatureId) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    navigate({ ...route, feature });
  };
  const active = featureRoutes.find((item) => item.id === route.feature)!;

  return (
    <main className="engine-page features-page">
      <header className="engine-toolbar">
        <div className="engine-brand">
          <span className="engine-logo" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <p className="engine-kicker">@moritzbrantner/maps · First-party</p>
            <h1>Maps features</h1>
          </div>
        </div>
        <nav aria-label="Site navigation" className="engine-nav">
          <a href={`${import.meta.env.BASE_URL}engine/`}>Engine</a>
          <a href={`${import.meta.env.BASE_URL}stats/`}>Stats</a>
          <a href={`${import.meta.env.BASE_URL}benchmarks/`}>Benchmark evidence</a>
          <a href="https://github.com/moritzbrantner/maps">Source ↗</a>
        </nav>
      </header>

      <section
        aria-label={`${active.label} on the first-party engine`}
        className="engine-workspace features-workspace"
        data-feature={route.feature}
      >
        <nav aria-label="Capabilities" className="features-picker">
          <ul>
            {featureRoutes.map((item) => (
              <li key={item.id}>
                <a
                  aria-current={item.id === route.feature ? "page" : undefined}
                  href={featureSearch({ ...route, feature: item.id })}
                  onClick={(event) => openFeature(event, item.id)}
                >
                  {item.label}
                </a>
              </li>
            ))}
            {comingFeatures.map((item) => (
              <li key={item.label} className="features-coming">
                {item.label} <small>coming (#{item.issue})</small>
              </li>
            ))}
          </ul>
        </nav>
        {route.feature === "heat" ? (
          <HeatFeature
            basemap={route.heatBasemap}
            renderMode={route.heatMode}
            onBasemapChange={(heatBasemap) => navigate({ ...route, heatBasemap })}
            onRenderModeChange={(heatMode) => navigate({ ...route, heatMode })}
          />
        ) : null}
        {route.feature === "clusters" ? <ClusterFeature /> : null}
        {route.feature === "polygons" ? <PolygonFeature /> : null}
        {route.feature === "timeline" ? <TimelineFeature /> : null}
      </section>

      <footer className="engine-status">
        <span>
          <strong>Illustrative feature data</strong> ·{" "}
          {route.feature === "heat" && route.heatBasemap === "atlas"
            ? "Real Liechtenstein OpenStreetMap tiles (ODbL); invented temperature values."
            : route.feature === "heat" && route.heatBasemap === "synthetic"
              ? "Self-hosted synthetic CC0 vector tiles; not real-world geography."
              : "No real-world claims or geographic basemap tiles."}
        </span>
        <span>Rust/WASM runtime · flatRuntime="maps"</span>
      </footer>
    </main>
  );
}

function HeatFeature({
  basemap,
  onBasemapChange,
  onRenderModeChange,
  renderMode,
}: {
  basemap: HeatBasemap;
  onBasemapChange: (source: HeatBasemap) => void;
  onRenderModeChange: (mode: HeatFieldRenderMode) => void;
  renderMode: HeatFieldRenderMode;
}) {
  const [contourLineWidth, setContourLineWidth] = useState(1.25);
  const [showDataPoints, setShowDataPoints] = useState(false);
  const tileset = useMemo(() => {
    if (basemap === "atlas") return createAtlasTileset("liechtenstein", import.meta.env.BASE_URL);
    if (basemap === "synthetic") return createShowcaseTileset(import.meta.env.BASE_URL);
    return undefined;
  }, [basemap]);
  const isAtlas = basemap === "atlas";
  const points = isAtlas ? demoAtlasTemperaturePoints : demoTemperaturePoints;
  const bounds = isAtlas ? demoAtlasTemperatureBounds : demoTemperatureDomainBounds;
  return (
    <>
      <HeatMap
        key={basemap}
        className="engine-map"
        dataPointColor="#111827"
        dataPointRadius={4}
        dataPointValueFormat={formatTemperatureValue}
        domainBounds={bounds}
        fieldAsyncRender
        fieldColorRamp={demoTemperatureFieldColorRamp}
        fieldColumns={320}
        fieldContourColor="#111827"
        fieldContourLevels={11}
        fieldContourLineWidth={contourLineWidth}
        fieldContourValueFormat={formatTemperatureValue}
        fieldOpacity={tileset ? 0.55 : 0.84}
        fieldRenderMode={renderMode}
        fieldRows={200}
        fieldValueDomain={demoTemperatureValueDomain}
        flatRuntime="maps"
        fitToData={false}
        heatmapSurfaceMode="field"
        initialViewState={
          isAtlas ? { center: [9.55, 47.15], zoom: 11.5 } : { center: [5, 50], zoom: 3.4 }
        }
        interpolationK={10}
        interpolationPower={2}
        mapLabel={
          isAtlas
            ? "Liechtenstein tiled temperature surface"
            : basemap === "synthetic"
              ? "Europe tiled temperature surface"
              : "Europe temperature surface"
        }
        mapStyle={tileset ? undefined : featureBackground}
        maxBounds={bounds}
        maxZoom={isAtlas ? 17 : 6}
        points={points}
        showDataPoints={showDataPoints}
        style={mapStyle}
        tileset={tileset}
        valueMetric="temperature"
      />
      <aside
        aria-label="Heat controls"
        className="features-panel"
        data-heat-render-mode={renderMode}
      >
        <label className="features-basemap-picker">
          <span>Basemap</span>
          <select
            aria-label="Heat map basemap"
            value={basemap}
            onChange={(event) => onBasemapChange(event.currentTarget.value as HeatBasemap)}
          >
            <option value="synthetic">Tiled world (synthetic)</option>
            <option value="atlas">Liechtenstein (OSM tiles)</option>
            <option value="none">No basemap</option>
          </select>
        </label>
        <p>
          Inverse-distance surface from {points.length} {isAtlas ? "illustrative" : "demo"}{" "}
          temperature stations.
        </p>
        <HeatControlsPanel
          contourLineWidth={contourLineWidth}
          onContourLineWidthChange={setContourLineWidth}
          onRenderModeChange={onRenderModeChange}
          onShowDataPointsChange={setShowDataPoints}
          renderMode={renderMode}
          showDataPoints={showDataPoints}
        />
      </aside>
    </>
  );
}

const clusterFeatureId = (feature: AggregatedMapFeature) =>
  feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`;

function ClusterFeature() {
  const [layers, setLayers] = useState({ clusters: true, flows: true, hubs: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const toggles = [
    ["clusters", `Clustered points (${demoPoints.length})`],
    ["flows", `Flows (${demoFlows.length})`],
    ["hubs", `Hub points (${demoPointHubs.length})`],
  ] as const;
  return (
    <>
      <MapView
        className="engine-map"
        flatRuntime="maps"
        fitToData={false}
        initialViewState={europeView}
        mapLabel="Clusters and flows"
        mapStyle={featureBackground}
        style={mapStyle}
      >
        {layers.flows ? (
          <FlowLayer
            flowColor="#b45309"
            flows={demoFlows}
            maxWidth={14}
            onSelectedFeatureIdChange={setSelected}
            renderFeatureTooltip={(feature) => <span>{feature.flow.label ?? feature.flow.id}</span>}
            selectedFeatureId={selected}
            showDirection
            showEndpoints
            weightMetric="trips"
          />
        ) : null}
        {layers.clusters ? (
          <ClusterLayer
            getFeatureId={clusterFeatureId}
            onSelectedFeatureIdChange={setSelected}
            onViewportAggregationChange={(next) =>
              setSummary(`${next.visibleClusterCount} clusters · ${next.visiblePointCount} points`)
            }
            points={demoPoints}
            selectedFeatureId={selected}
          />
        ) : null}
        {layers.hubs ? (
          <PointLayer
            onSelectedFeatureIdChange={setSelected}
            pointColor="#115e59"
            pointRadius={6}
            points={demoPointHubs}
            renderFeatureTooltip={(feature) => <span>{feature.point.label}</span>}
            selectedFeatureId={selected}
          />
        ) : null}
      </MapView>
      <aside aria-label="Layer controls" className="features-panel">
        <p>Select a cluster to expand it. Flows and hub points are selectable.</p>
        <fieldset>
          <legend>Map Layers</legend>
          {toggles.map(([key, label]) => (
            <label key={key} className="demo-layer-toggle">
              <input
                checked={layers[key]}
                type="checkbox"
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setLayers((current) => ({ ...current, [key]: checked }));
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {layers.clusters && summary ? (
          <output data-testid="feature-summary">{summary}</output>
        ) : null}
        <SelectionReadout selected={selected} onClear={() => setSelected(null)} />
      </aside>
    </>
  );
}

/** A service area with an exclusion hole, next to the demo's mixed GeoJSON geometries. */
const polygonCollection = {
  ...demoGeoJsonCollection,
  features: [
    {
      geometry: {
        coordinates: [
          [
            [13.5, 49.6],
            [19.5, 49.6],
            [19.5, 54.4],
            [13.5, 54.4],
            [13.5, 49.6],
          ],
          [
            [15.4, 51.2],
            [17.6, 51.2],
            [17.6, 52.8],
            [15.4, 52.8],
            [15.4, 51.2],
          ],
        ],
        type: "Polygon" as const,
      },
      properties: {
        kind: "Polygon" as const,
        label: "Eastern service area (with exclusion)",
        time: 0,
        trackId: "geojson-polygon-hole",
      },
      type: "Feature" as const,
    },
    ...demoGeoJsonCollection.features,
  ].map((feature, index) => ({
    ...feature,
    id: feature.properties?.trackId ?? `feature-${index}`,
  })),
};

function PolygonFeature() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <MapView
        className="engine-map"
        flatRuntime="maps"
        fitToData={false}
        initialViewState={{ center: [9, 50.5], zoom: 3.5 }}
        mapLabel="GeoJSON features"
        mapStyle={featureBackground}
        style={mapStyle}
      >
        <GeoJsonLayer
          featureCollection={polygonCollection}
          onSelectedFeatureIdChange={setSelected}
          polygonFillColor="#2563eb"
          polygonFillOpacity={0.22}
          polygonStrokeColor="#1d4ed8"
          selectedFeatureId={selected}
        />
      </MapView>
      <aside aria-label="GeoJSON features" className="features-panel">
        <p>Select a feature on the map or in this list.</p>
        <ul className="features-list">
          {polygonCollection.features.map((feature, index) => {
            const id = getDemoFeatureId(feature, index);
            return (
              <li key={id}>
                <button
                  aria-pressed={selected === id}
                  type="button"
                  onClick={() => setSelected(selected === id ? null : id)}
                >
                  {getDemoGeoJsonLabel(feature)} <small>{feature.geometry?.type}</small>
                </button>
              </li>
            );
          })}
        </ul>
        <SelectionReadout selected={selected} onClear={() => setSelected(null)} />
      </aside>
    </>
  );
}

/** Static route geometry under the moving tracks; its identity never changes with time. */
const timelineRoutes: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
  features: demoTracks.map((track) => ({
    geometry: {
      coordinates: track.frames.map((frame) => [frame.longitude, frame.latitude]),
      type: "LineString",
    },
    id: `route:${track.id}`,
    properties: {},
    type: "Feature",
  })),
  type: "FeatureCollection",
};

function TimelineFeature() {
  const [clock] = useState(() => createMapScopedTimelineClock({ loop: true, playbackRate: 8 }));
  const snapshot = useMapScopedTimelineSnapshot(clock);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => () => clock.dispose(), [clock]);
  return (
    <>
      <TemporalClusteredMap
        className="engine-map features-temporal"
        fitToData={false}
        flatRuntime="maps"
        initialViewState={{ center: [8, 50], zoom: 3.5 }}
        mapLabel="Freight timeline"
        mapStyle={featureBackground}
        onSelectedFeatureIdChange={setSelected}
        selectedFeatureId={selected}
        showPlaybackControls={false}
        style={mapStyle}
        timeline={clock}
        tracks={demoTracks}
      >
        <GeoJsonLayer featureCollection={timelineRoutes} lineColor="#94a3b8" lineWidth={2} />
      </TemporalClusteredMap>
      <aside aria-label="Timeline controls" className="features-panel">
        <p>{demoTracks.length} freight routes moving on one Map-Scoped Timeline.</p>
        <MapScopedTimelineControls
          formatTimeLabel={formatDemoTimelineTime}
          timeline={clock}
          timelineLabel="Freight timeline"
        />
        <output data-testid="feature-time">
          {formatDemoTimelineTime(snapshot.activeTime)} ·{" "}
          {snapshot.isPlaying ? "playing" : "paused"}
        </output>
        <SelectionReadout selected={selected} onClear={() => setSelected(null)} />
      </aside>
    </>
  );
}

function SelectionReadout({ onClear, selected }: { onClear: () => void; selected: string | null }) {
  return (
    <div className="features-selection">
      <output data-testid="feature-selection">
        {selected ? `Selected ${selected}` : "No selection"}
      </output>
      {selected ? (
        <button type="button" onClick={onClear}>
          Clear selection
        </button>
      ) : null}
    </div>
  );
}
