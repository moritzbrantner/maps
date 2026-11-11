import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  GeoJsonLayer,
  HeatLayer,
  MapView,
  PointLayer,
  type GeoJsonLayerStyle,
  type MapSurfaceController,
  type MapViewState,
  type RasterMapStyle,
} from "../../src";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";
import {
  observeHeatLayerWork,
  type HeatLayerWorkTotals,
} from "../../src/heat-layer-work";
import {
  createBerlinPhyllotaxisDemandPoints,
  createEuropeTemperatureObservations,
  type HeatScalarWorkloadPoint,
} from "./heat-scalar-workloads";

/**
 * `heat-scalar-journey-v1` (#171 phase 5): the canonical heat/scalar workloads mounted in one
 * public `flatRuntime="maps"` Map View next to interactive points and polygons.
 *
 * - a weighted density Heat Layer over the `heat-map-density-index-v1` points (10,000 demand
 *   weights around Berlin), stable raster with the default meter radius;
 * - a scalar-field Heat Layer over the `scalar-field-grid-v1` observations (320 × 200 cells,
 *   K = 10, power 2), clipped by a polygon mask with a hole and traced into contours;
 * - a GeoJSON Layer with the mask's polygon and a Point Layer with the observation stations.
 *
 * Observation of the heat/scalar work counters is installed before the first render, so the
 * journey reads every index, grid, image, contour, raster and upload count from page load on.
 */

configureMapsWasmPackage("/wasm/maps_wasm.js");
const workObservation = observeHeatLayerWork();

const WHITE_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

// `?heat=0` mounts the same Map View without its Heat Layers: the control lane.
const WITH_HEAT =
  new URLSearchParams(window.location.search).get("heat") !== "0";
const DENSITY_POINT_COUNT = 10_000;
const DENSITY_POINTS = createBerlinPhyllotaxisDemandPoints(DENSITY_POINT_COUNT);
const OBSERVATIONS = createEuropeTemperatureObservations();
const FIELD_DOMAIN: [number, number, number, number] = [-25, 34, 35, 66];
const FIELD_CONTOUR_LEVELS = [16, 20, 24, 28];

// Mainland Europe with a hole over the Alps: the mask clips the raster and the contours.
const MASK_GEOMETRY: GeoJSON.Polygon = {
  coordinates: [
    [
      [-11, 36],
      [30, 36],
      [30, 62],
      [6, 62],
      [-11, 55],
      [-11, 36],
    ],
    [
      [5, 45],
      [13, 45],
      [13, 48],
      [5, 48],
      [5, 45],
    ],
  ],
  type: "Polygon",
};
const MASK = {
  features: [
    { geometry: MASK_GEOMETRY, properties: {}, type: "Feature" as const },
  ],
  type: "FeatureCollection" as const,
};
const MASK_POLYGON = {
  features: [
    {
      geometry: MASK_GEOMETRY,
      id: "mask",
      properties: {},
      type: "Feature" as const,
    },
  ],
  type: "FeatureCollection" as const,
};
const MASK_STYLE: GeoJsonLayerStyle = {
  polygonFillColor: "#16a34a",
  polygonFillOpacity: 0.04,
  polygonStrokeColor: "#15803d",
  polygonStrokeWidth: 2,
};

const DENSITY_RAMPS = [
  [
    [0, "rgba(37, 99, 235, 0)"],
    [0.4, "rgba(14, 165, 233, 0.7)"],
    [0.7, "rgba(250, 204, 21, 0.85)"],
    [1, "rgba(220, 38, 38, 0.95)"],
  ],
  [
    [0, "rgba(15, 23, 42, 0)"],
    [0.5, "rgba(124, 58, 237, 0.75)"],
    [1, "rgba(236, 72, 153, 0.95)"],
  ],
] as const;
const FIELD_RAMPS = [
  [
    [0, "#1d4ed8"],
    [0.5, "#fde68a"],
    [1, "#b91c1c"],
  ],
  [
    [0, "#0f766e"],
    [1, "#f97316"],
  ],
] as const;

const HEAT_SCALAR_JOURNEY_VIEW: MapViewState = {
  bearing: 0,
  center: [8, 50],
  pitch: 0,
  zoom: 3.4,
};

type Controller = MapSurfaceController;

declare global {
  interface Window {
    heatScalarJourney: {
      controller: Controller | null;
      /** Density "temporal seek": the filter keeps the points whose index modulo 12 is ≤ step. */
      seekDensity(step: number): void;
      setMounted(mounted: boolean): void;
      setSize(size: { height: number; width: number }): void;
      /** Replaces both layers' color ramps with variant `variant % 2`. */
      setStyle(variant: number): void;
      totals(): HeatLayerWorkTotals;
      /** Field data refresh: new observation objects with every temperature shifted by step. */
      updateField(step: number): void;
    };
  }
}

window.heatScalarJourney = {
  controller: null,
  seekDensity: () => undefined,
  setMounted: () => undefined,
  setSize: () => undefined,
  setStyle: () => undefined,
  totals: () => workObservation.totals(),
  updateField: () => undefined,
};

const densityFilters = new Map<
  number,
  (point: HeatScalarWorkloadPoint) => boolean
>();
function densityFilter(step: number) {
  let filter = densityFilters.get(step);
  if (!filter) {
    filter = (point) => Number(point.id.slice("point-".length)) % 12 <= step;
    densityFilters.set(step, filter);
  }
  return filter;
}

function shiftObservations(step: number): HeatScalarWorkloadPoint[] {
  return OBSERVATIONS.map((point, index) => ({
    ...point,
    metrics: {
      temperature:
        point.metrics.temperature! + step * (index % 2 === 0 ? 0.6 : -0.4),
    },
  }));
}

function HeatScalarJourney() {
  const [densityStep, setDensityStep] = useState(11);
  const [fieldStep, setFieldStep] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [size, setSize] = useState({ height: 720, width: 1280 });
  const [style, setStyle] = useState(0);
  window.heatScalarJourney.seekDensity = setDensityStep;
  window.heatScalarJourney.setMounted = setMounted;
  window.heatScalarJourney.setSize = setSize;
  window.heatScalarJourney.setStyle = setStyle;
  window.heatScalarJourney.updateField = setFieldStep;

  const observations = useMemo(
    () => (fieldStep === 0 ? OBSERVATIONS : shiftObservations(fieldStep)),
    [fieldStep],
  );

  if (!mounted) return null;

  return (
    <MapView
      defaultViewState={HEAT_SCALAR_JOURNEY_VIEW}
      fitToData={false}
      flatRuntime="maps"
      mapLabel="Heat scalar journey"
      mapStyle={
        {
          maxZoom: 12,
          minZoom: 0,
          tileSize: 256,
          tiles: WHITE_TILE,
        } as RasterMapStyle
      }
      onMapControllerReady={(controller) => {
        window.heatScalarJourney.controller = controller;
      }}
      style={size}
    >
      {WITH_HEAT ? (
        <>
          <HeatLayer
            domainBounds={FIELD_DOMAIN}
            fieldAsyncRender
            fieldColorRamp={FIELD_RAMPS[style % 2]}
            fieldColumns={320}
            fieldContourColor="#1e293b"
            fieldContourLevels={FIELD_CONTOUR_LEVELS}
            fieldOpacity={0.55}
            fieldRenderMode="raster-contours"
            fieldRows={200}
            heatmapSurfaceMode="field"
            interpolationK={10}
            interpolationPower={2}
            layerId="journey-temperature-field"
            maskGeoJson={MASK}
            points={observations}
            valueMetric="temperature"
          />
          <HeatLayer
            filterPoint={densityFilter(densityStep)}
            heatmapColorRamp={DENSITY_RAMPS[style % 2]}
            layerId="journey-demand-density"
            points={DENSITY_POINTS}
            weightMetric="demand"
          />
        </>
      ) : null}
      <GeoJsonLayer
        featureCollection={MASK_POLYGON}
        getFeatureId={getMaskId}
        getFeatureStyle={getMaskStyle}
        layerId="journey-mask-polygon"
      />
      <PointLayer
        layerId="journey-stations"
        pointColor="#0f172a"
        pointRadius={5}
        points={observations}
      />
    </MapView>
  );
}

function getMaskId() {
  return "mask";
}

function getMaskStyle() {
  return MASK_STYLE;
}

createRoot(document.getElementById("root")!).render(<HeatScalarJourney />);
