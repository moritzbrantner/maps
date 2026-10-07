import { createRoot } from "react-dom/client";

import {
  FlowLayer,
  GeoJsonLayer,
  MapView,
  type GeoJsonLayerStyle,
  type MapSurfaceController,
  type MapViewState,
} from "../../src";
import type { MapsRendererStats } from "../../src/maps-browser-runtime";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";

configureMapsWasmPackage("/wasm/maps_wasm.js");

// A 1×1 white raster tile keeps the base map deterministic and network-free.
const WHITE_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

type Ring = [number, number][];

const square = (west: number, south: number, size: number): Ring => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];

type CaseProperties = { style: GeoJsonLayerStyle };

const opaque = (color: string, strokeWidth = 0): GeoJsonLayerStyle => ({
  polygonFillColor: color,
  polygonFillOpacity: 1,
  polygonStrokeColor: "#0f172a",
  polygonStrokeWidth: strokeWidth,
});

const feature = (
  id: string,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | GeoJSON.LineString | GeoJSON.Point,
  style: GeoJsonLayerStyle,
) => ({ geometry, id, properties: { style }, type: "Feature" as const });

const cases = {
  // Top row: fill semantics.
  hole: feature(
    "hole",
    { coordinates: [square(-19, 2, 8), square(-17, 4, 4)], type: "Polygon" },
    opaque("#2563eb"),
  ),
  "multiple-exteriors": feature(
    "multiple-exteriors",
    {
      coordinates: [
        [square(-9, 2, 3.5)],
        [square(-4.5, 2, 3.5)],
        [square(-9, 6.5, 8), square(-7, 7.5, 4)],
      ],
      type: "MultiPolygon",
    },
    opaque("#16a34a"),
  ),
  "overlapping-holes": feature(
    "overlapping-holes",
    { coordinates: [square(1, 2, 8), square(2, 3, 4), square(4, 5, 4)], type: "Polygon" },
    opaque("#9333ea"),
  ),
  "self-intersecting": feature(
    "self-intersecting",
    {
      coordinates: [
        [
          [11, 2],
          [19, 10],
          [19, 2],
          [11, 10],
          [11, 2],
        ],
      ],
      type: "Polygon",
    },
    opaque("#ea580c"),
  ),
  // Bottom row: opacity, stroke and painter order.
  "translucent-stroke": feature(
    "translucent-stroke",
    {
      coordinates: [
        [
          [-19, -9],
          [-11, -9],
          [-17.5, -6.5],
          [-11, -1],
          [-19, -1],
          [-19, -9],
        ],
      ],
      type: "Polygon",
    },
    {
      polygonFillColor: "#0891b2",
      polygonFillOpacity: 0.45,
      polygonStrokeColor: "#be123c",
      polygonStrokeWidth: 12,
    },
  ),
  "order-lower": feature(
    "order-lower",
    { coordinates: [square(-9, -9, 5.5)], type: "Polygon" },
    { ...opaque("#facc15", 2), polygonFillOpacity: 0.7 },
  ),
  "order-line": feature(
    "order-line",
    {
      coordinates: [
        [-9.5, -6],
        [0.5, -4],
      ],
      type: "LineString",
    },
    { lineColor: "#1d4ed8", lineOpacity: 1, lineWidth: 6 },
  ),
  "order-point": feature(
    "order-point",
    { coordinates: [-5.5, -5.5], type: "Point" },
    { pointColor: "#dc2626", pointRadius: 9 },
  ),
  "order-upper": feature(
    "order-upper",
    { coordinates: [square(-5.5, -6.5, 5.5)], type: "Polygon" },
    { ...opaque("#22c55e", 2), polygonFillOpacity: 0.7 },
  ),
  selected: feature(
    "selected",
    { coordinates: [square(1, -9, 8)], type: "Polygon" },
    opaque("#e0f2fe", 3),
  ),
  hovered: feature(
    "hovered",
    { coordinates: [square(11, -9, 8)], type: "Polygon" },
    opaque("#fef3c7", 3),
  ),
  // Opt-in: across the antimeridian, viewed with `lon=180`.
  antimeridian: feature(
    "antimeridian",
    {
      coordinates: [
        [
          [174, -6],
          [-174, -6],
          [-174, 6],
          [174, 6],
          [174, -6],
        ],
        [
          [178, -2],
          [178, 2],
          [-178, 2],
          [-178, -2],
          [178, -2],
        ],
      ],
      type: "Polygon",
    },
    { ...opaque("#0d9488", 3), polygonFillOpacity: 0.8 },
  ),
  // Opt-in line cases (#195), in the top row: sharp round joins, round caps and a
  // translucent line that crosses itself, which must blend once where it overlaps.
  "line-joins": feature(
    "line-joins",
    {
      coordinates: [
        [-19, 3],
        [-15, 9],
        [-11, 3.5],
        [-7, 9],
        [-6.5, 4],
      ],
      type: "LineString",
    },
    { lineColor: "#7c3aed", lineOpacity: 1, lineWidth: 10 },
  ),
  "translucent-line": feature(
    "translucent-line",
    {
      coordinates: [
        [1, 3],
        [9, 9],
        [9, 3],
        [1, 9],
        [3, 2],
      ],
      type: "LineString",
    },
    { lineColor: "#0f766e", lineOpacity: 0.5, lineWidth: 14 },
  ),
  // Opt-in invalid input; the packer's whole-frame behavior is part of the contract.
  "zero-area": feature(
    "zero-area",
    {
      coordinates: [
        [
          [-15, 12],
          [-10, 12],
          [-5, 12],
          [-15, 12],
        ],
      ],
      type: "Polygon",
    },
    opaque("#000000", 4),
  ),
};

const OPT_IN = new Set(["zero-area", "antimeridian", "line-joins", "translucent-line"]);
const params = new URLSearchParams(window.location.search);
const only = params.get("cases")?.split(",");
const features = Object.entries(cases)
  .filter(([id]) => (only ? only.includes(id) : !OPT_IN.has(id)))
  .map(([, value]) => value);
// `flows=1`: flows above the GeoJSON layer (#195): direction markers on their own, then
// endpoints, which interleave circles with lines in painter order.
const flowPoint = (longitude: number, latitude: number): [number, number] => [longitude, latitude];
const flows =
  params.get("flows") === "1"
    ? {
        endpoints: [{ from: flowPoint(19, -9), id: "west", to: flowPoint(12, -2) }],
        markers: [
          { from: flowPoint(11, -9), id: "east", to: flowPoint(18, -1) },
          { from: flowPoint(11, 3), id: "north-east", to: flowPoint(19, 9) },
          { from: flowPoint(-4, 2), id: "north", to: flowPoint(-3, 9) },
        ],
      }
    : null;

type Controller = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };

declare global {
  interface Window {
    polygonParity: {
      controller: Controller | null;
      setViewState(state: MapViewState): void;
      stats(): MapsRendererStats | null;
    };
  }
}

window.polygonParity = {
  controller: null,
  setViewState(state) {
    window.polygonParity.controller?.setViewState(state);
  },
  stats() {
    return window.polygonParity.controller?.getRendererStats() ?? null;
  },
};

const initialViewState: MapViewState = {
  center: [Number(params.get("lon") ?? 0), Number(params.get("lat") ?? 0)],
  zoom: Number(params.get("zoom") ?? 4),
};

function PolygonParity() {
  return (
    <MapView
      fitToData={false}
      flatRuntime="maps"
      mapLabel="Polygon parity"
      mapStyle={{ maxZoom: 8, minZoom: 0, tileSize: 256, tiles: WHITE_TILE }}
      style={{ height: 540, width: 960 }}
      defaultViewState={initialViewState}
      onMapControllerReady={(controller) => {
        window.polygonParity.controller = controller as Controller | null;
      }}
    >
      <GeoJsonLayer<CaseProperties>
        featureCollection={{ features, type: "FeatureCollection" }}
        getFeatureId={(value) => String(value.id)}
        getFeatureStyle={(value) => value.properties.style}
        hoveredFeatureId="hovered"
        selectedFeatureId="selected"
      />
      {flows ? (
        <>
          <FlowLayer
            flowColor="#1d4ed8"
            flows={flows.markers}
            maxWidth={8}
            minWidth={8}
            showDirection
            showEndpoints={false}
          />
          <FlowLayer flowColor="#be185d" flows={flows.endpoints} maxWidth={6} minWidth={6} />
        </>
      ) : null}
    </MapView>
  );
}

createRoot(document.getElementById("root")!).render(<PolygonParity />);
