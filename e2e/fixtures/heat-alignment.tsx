import { useState } from "react";
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
import type { MapsRendererStats } from "../../src/maps-browser-runtime";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";

configureMapsWasmPackage("/wasm/maps_wasm.js");

// A 1×1 white raster tile keeps the base map deterministic and network-free.
const WHITE_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

/**
 * Heat/scalar alignment evidence (#171 phase 3). Every layer draws in a color class the
 * spec can separate from screenshots alone, so alignment is measured from pixels, not from
 * the projection code under test:
 *
 * - density surfaces are pure red with varying alpha;
 * - the masked scalar field and its contours are blue to violet;
 * - the Point Layer markers at the density sources are black;
 * - the GeoJSON polygon with the mask's exact geometry is green.
 */
const DENSITY_RAMP = [
  [0, "rgba(255, 0, 0, 0)"],
  [1, "rgba(255, 0, 0, 1)"],
] as const;
const FIELD_RAMP = [
  [0, "#2563eb"],
  [1, "#7c3aed"],
] as const;

// Geographic (meter) radius: the stable-raster strategy, a Mercator-anchored raster that is
// reused while the camera stays inside it.
const STABLE_DENSITY_POINTS = [
  { id: "stable-north", latitude: 52.5, longitude: 2.5 },
  { id: "stable-south", latitude: 47.5, longitude: 5.5 },
];
// Pixel radius: the viewport-raster strategy, a screen-space raster redrawn per camera.
const VIEWPORT_DENSITY_POINTS = [
  { id: "viewport-north", latitude: 53, longitude: 6.5 },
  { id: "viewport-south", latitude: 48, longitude: 2.5 },
];
const MARKERS = [...STABLE_DENSITY_POINTS, ...VIEWPORT_DENSITY_POINTS];

const FIELD_POINTS = [
  { id: "field-sw", latitude: 46, longitude: 11.5, metrics: { value: 0 } },
  { id: "field-se", latitude: 46, longitude: 19, metrics: { value: 10 } },
  { id: "field-nw", latitude: 54, longitude: 11.5, metrics: { value: 20 } },
  { id: "field-ne", latitude: 54, longitude: 19, metrics: { value: 30 } },
  { id: "field-center", latitude: 50, longitude: 15, metrics: { value: 15 } },
];

// An L-shaped mask with an off-center hole: a missing rotation, a flipped axis or an offset
// all change which pixels it covers.
const MASK_GEOMETRY: GeoJSON.Polygon = {
  coordinates: [
    [
      [12, 47],
      [18, 47],
      [18, 50],
      [15, 50],
      [15, 53],
      [12, 53],
      [12, 47],
    ],
    [
      [13, 48],
      [14.4, 48],
      [14.4, 49.4],
      [13, 49.4],
      [13, 48],
    ],
  ],
  type: "Polygon",
};
const MASK = { features: [{ geometry: MASK_GEOMETRY, properties: {}, type: "Feature" }], type: "FeatureCollection" };
const MASK_POLYGON = {
  features: [{ geometry: MASK_GEOMETRY, id: "mask", properties: {}, type: "Feature" as const }],
  type: "FeatureCollection" as const,
};

/**
 * - `composite`: the evidence picture, markers over the surfaces and the mask outlined.
 * - `vector`: markers and the polygon filled opaque, to measure where the vector layers are.
 * - `surfaces`: the heat layers only, to measure where the surfaces are.
 *
 * Switching mode mounts or restyles only the vector layers; the heat layers stay mounted.
 */
type AlignmentMode = "composite" | "surfaces" | "vector";

const OUTLINE_STYLE: GeoJsonLayerStyle = {
  polygonFillColor: "#16a34a",
  polygonFillOpacity: 0,
  polygonStrokeColor: "#16a34a",
  polygonStrokeWidth: 2,
};
const FILL_STYLE: GeoJsonLayerStyle = {
  polygonFillColor: "#16a34a",
  polygonFillOpacity: 1,
  polygonStrokeColor: "#16a34a",
  polygonStrokeWidth: 0,
};

type Controller = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };

type Size = { height: number; width: number };

declare global {
  interface Window {
    heatAlignment: {
      controller: Controller | null;
      setMode(mode: AlignmentMode): void;
      setSize(size: Size): void;
      setViewState(state: MapViewState): void;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const asyncRender = params.get("async") !== "0";

window.heatAlignment = {
  controller: null,
  setMode: () => undefined,
  setSize: () => undefined,
  setViewState(state) {
    window.heatAlignment.controller?.setViewState(state);
  },
};

const INITIAL_VIEW_STATE: MapViewState = { bearing: 0, center: [10, 50], pitch: 0, zoom: 4.75 };

function HeatAlignment() {
  const [mode, setMode] = useState<AlignmentMode>("composite");
  const [size, setSize] = useState<Size>({ height: 540, width: 960 });
  window.heatAlignment.setMode = setMode;
  window.heatAlignment.setSize = setSize;

  return (
    <div data-alignment-mode={mode}>
      <MapView
        defaultViewState={INITIAL_VIEW_STATE}
        fitToData={false}
        flatRuntime="maps"
        mapLabel="Heat alignment"
        mapStyle={{ maxZoom: 10, minZoom: 0, tileSize: 256, tiles: WHITE_TILE } as RasterMapStyle}
        onMapControllerReady={(controller) => {
          window.heatAlignment.controller = controller as Controller | null;
        }}
        style={size}
      >
        <HeatLayer
          heatmapAsyncRender={asyncRender}
          heatmapColorRamp={DENSITY_RAMP}
          heatmapRadius={{ meters: 70_000 }}
          heatmapRenderStrategy="stable-raster"
          layerId="alignment-stable-density"
          points={STABLE_DENSITY_POINTS}
        />
        <HeatLayer
          heatmapAsyncRender={asyncRender}
          heatmapColorRamp={DENSITY_RAMP}
          heatmapRadius={18}
          heatmapRenderStrategy="viewport-raster"
          heatmapSurfaceMode="data"
          layerId="alignment-viewport-density"
          points={VIEWPORT_DENSITY_POINTS}
        />
        <HeatLayer
          domainBounds={[11, 45.5, 19.5, 54.5]}
          fieldAsyncRender={asyncRender}
          fieldColorRamp={FIELD_RAMP}
          fieldColumns={96}
          fieldContourColor="#1e3a8a"
          fieldOpacity={1}
          fieldRenderMode="raster-contours"
          fieldRows={96}
          heatmapSurfaceMode="field"
          layerId="alignment-masked-field"
          maskGeoJson={MASK}
          points={FIELD_POINTS}
          valueMetric="value"
        />
        {mode === "surfaces" ? null : (
          <>
            <GeoJsonLayer
              featureCollection={MASK_POLYGON}
              getFeatureId={getMaskId}
              getFeatureStyle={mode === "vector" ? getFillStyle : getOutlineStyle}
              layerId="alignment-mask-polygon"
            />
            <PointLayer
              layerId="alignment-markers"
              pointColor="#000000"
              pointRadius={5}
              points={MARKERS}
            />
          </>
        )}
      </MapView>
    </div>
  );
}

function getMaskId() {
  return "mask";
}

function getFillStyle() {
  return FILL_STYLE;
}

function getOutlineStyle() {
  return OUTLINE_STYLE;
}

createRoot(document.getElementById("root")!).render(<HeatAlignment />);
