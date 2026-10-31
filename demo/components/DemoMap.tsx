import type { Dispatch, SetStateAction } from "react";

import {
  BeeLineMeasurementLayer,
  BubbleLayer,
  BubbleMap,
  ClusterLayer,
  ClusteredMap,
  FlowLayer,
  FlowMap,
  HeatLayer,
  HeatMap,
  MapView,
  PointLayer,
  PointMap,
  TemporalClusteredMap,
  type GeoJsonEditMode,
  type GeoJsonEditorSelection,
  type HeatFieldRenderMode,
  type MapBeeLineMeasurement,
  type MapBeeLineMeasurementDraft,
  type MapBeeLineMeasurementResult,
  type MapPoint,
  type MapViewState,
  type TemporalGeoJsonGeometryFeatureCollection,
} from "@moritzbrantner/maps";
import { EditableGeoJsonMap } from "../../src/entries/editor";

import { demoFlows } from "../data/demo-flows";
import {
  demoTemperatureDomainBounds,
  demoTemperatureFieldColorRamp,
  demoTemperaturePoints,
  demoTemperatureValueDomain,
} from "../data/demo-points";
import {
  demoTimelineGeoJsonCollection,
  demoTimelineViewState,
  demoTracks,
  formatDemoTimelineTime,
} from "../data/demo-timeline";
import { demoMapStyle } from "../data/map-style";
import type { DemoE2ERegistration } from "../lib/e2e-probe";
import { formatTemperatureValue, getHeatLayerColorRamp } from "../lib/format";
import { getDemoFeatureId } from "../lib/geojson-features";
import type {
  DemoGeoJsonProperties,
  DemoLayerConfig,
  DemoPointProperties,
  DemoView,
  EditablePointContext,
} from "../types";
import { renderDemoFlowPopup, renderDemoFlowTooltip } from "./FlowVolumeLegend";
import { GeoJsonGeometryExample } from "./GeoJsonGeometryExample";
import { GeoJsonInterpolationWorkbench } from "./GeoJsonInterpolationWorkbench";
import { HistoryDemoView } from "./HistoryDemoView";
import {
  getDemoTimelineGeographyStyle,
  renderDemoTimelineGeoJsonPopup,
  renderDemoTimelineGeoJsonTooltip,
} from "./TimelineGeoJsonPopup";

type DemoMapProps = {
  view: DemoView;
  points: Array<MapPoint<DemoPointProperties>>;
  measurements: MapBeeLineMeasurement[];
  setMeasurements: Dispatch<SetStateAction<MapBeeLineMeasurement[]>>;
  setMeasurementDraft: Dispatch<SetStateAction<MapBeeLineMeasurementDraft | null>>;
  isMeasuring: boolean;
  setViewport: Dispatch<SetStateAction<MapViewState>>;
  layers: DemoLayerConfig[];
  editablePoints: EditablePointContext;
  editableGeoJson: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>;
  setEditableGeoJson: Dispatch<
    SetStateAction<TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>>
  >;
  editMode: GeoJsonEditMode;
  setEditMode: Dispatch<SetStateAction<GeoJsonEditMode>>;
  geoJsonSelection: GeoJsonEditorSelection;
  setGeoJsonSelection: Dispatch<SetStateAction<GeoJsonEditorSelection>>;
  heatFieldRenderMode: HeatFieldRenderMode;
  heatFieldContourLineWidth: number;
  showHeatDataPoints: boolean;
  selectedFlowId: string | null;
  setSelectedFlowId: Dispatch<SetStateAction<string | null>>;
  temporalTime: number;
  setTemporalTime: Dispatch<SetStateAction<number>>;
  e2eRegistration: DemoE2ERegistration;
};

/** Selects the Map View for the active demo tab. */
export function DemoMap({
  view,
  points,
  measurements,
  setMeasurements,
  setMeasurementDraft,
  isMeasuring,
  setViewport,
  layers,
  editablePoints,
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
  e2eRegistration,
}: DemoMapProps) {
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
    onMeasurementDraftChange: setMeasurementDraft,
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
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapContextMenu={() => {
            editablePoints.onSelectPoint(null);
          }}
          onMapReady={e2eRegistration.onMapReady}
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
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
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
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
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
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
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
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
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
      return <GeoJsonInterpolationWorkbench e2eRegistration={e2eRegistration} />;
    case "history":
      return (
        <HistoryDemoView
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
          onViewStateChange={setViewport}
        />
      );
    case "globe":
      return (
        <BubbleMap
          {...sharedMeasurementProps}
          bubbleColor="#0f766e"
          mapDisplay="globe"
          mapStyle={demoMapStyle}
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
          onViewStateChange={setViewport}
          points={points}
          renderFeatureTooltip={(feature) => feature.point.label}
          style={{ minHeight: 620 }}
          weightMetric="demand"
        />
      );
    case "geojson":
      return <GeoJsonGeometryExample e2eRegistration={e2eRegistration} />;
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
          onMapControllerReady={e2eRegistration.onMapControllerReady}
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
          onMapReady={e2eRegistration.onMapReady}
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
          onMapControllerReady={e2eRegistration.onMapControllerReady}
          onMapReady={e2eRegistration.onMapReady}
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
