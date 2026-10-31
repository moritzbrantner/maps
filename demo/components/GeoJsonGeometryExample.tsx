import {
  FlowLayer,
  GeoJsonLayer,
  HeatLayer,
  MapView,
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
} from "@moritzbrantner/maps";

import { demoFlows } from "../data/demo-flows";
import { demoGeoJsonCollection } from "../data/demo-geojson";
import { demoPoints } from "../data/demo-points";
import { demoMapStyle } from "../data/map-style";
import type { DemoE2ERegistration } from "../lib/e2e-probe";
import { getHeatLayerColorRamp } from "../lib/format";

export function GeoJsonGeometryExample({
  e2eRegistration,
}: {
  e2eRegistration: DemoE2ERegistration;
}) {
  const tracks = createTemporalGeoJsonTracksFromGeoJson(demoGeoJsonCollection);
  const frame = createTemporalGeoJsonPlaybackIndex(tracks).getFeatureCollectionAtTime(0);

  return (
    <section className="demo-geojson-example" aria-label="GeoJSON geometry examples">
      <MapView
        defaultViewState={{ center: [8.4, 50.4], zoom: 4.4 }}
        fitToData={false}
        mapLabel="Rendered GeoJSON geometries"
        mapStyle={demoMapStyle}
        onMapControllerReady={e2eRegistration.onMapControllerReady}
        onMapReady={e2eRegistration.onMapReady}
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
