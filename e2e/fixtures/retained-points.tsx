// Retained application point host (#155). The same points render through GPU-retained
// instances (WebGPU) or the screen-projected Canvas fallback (no `navigator.gpu`), so the
// two can be compared, and dense camera journeys can read the retained work counters.
import { createRoot } from "react-dom/client";
import "../../styles.css";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";
import type { MapSurfaceController, MapViewState } from "../../src/map-display";
import type { MapsRendererStats } from "../../src/maps-browser-runtime";
import { FlowLayer } from "../../src/flow-layer";
import { MapView } from "../../src/map-view";
import { PointLayer } from "../../src/point-layer";

configureMapsWasmPackage("/wasm/maps_wasm.js");

type Controller = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };
type Point = { id: string; latitude: number; longitude: number };

declare global {
  interface Window {
    retainedPoints: {
      controller: Controller | null;
      setViewState(state: MapViewState): void;
      stats(): MapsRendererStats | null;
    };
  }
}

const params = new URLSearchParams(location.search);
const viewState: MapViewState = {
  center: [Number(params.get("lon") ?? 13.4), Number(params.get("lat") ?? 52.5)],
  zoom: Number(params.get("zoom") ?? 11),
  bearing: Number(params.get("bearing") ?? 0),
  pitch: Number(params.get("pitch") ?? 0),
};

function grid(
  center: [number, number],
  step: [number, number],
  columns: number,
  rows: number,
): Point[] {
  const points: Point[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push({
        id: `p-${row}-${column}`,
        latitude: center[1] + (row - (rows - 1) / 2) * step[1],
        longitude: center[0] + (column - (columns - 1) / 2) * step[0],
      });
    }
  }
  return points;
}

function dense(count: number): Point[] {
  // Deterministic spread over Europe: a large static dataset, not a visual pattern.
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  return Array.from({ length: count }, (_, index) => ({
    id: `d-${index}`,
    latitude: 40 + random() * 20,
    longitude: -5 + random() * 35,
  }));
}

const scenario = params.get("points") ?? "grid";
const points: Point[] =
  scenario === "dense"
    ? dense(Number(params.get("count") ?? 10_000))
    : scenario === "antimeridian"
      ? [
          { id: "east-near", latitude: 0.01, longitude: 179.985 },
          { id: "east-far", latitude: -0.01, longitude: 179.96 },
          { id: "west-near", latitude: 0.01, longitude: -179.985 },
          { id: "west-far", latitude: -0.01, longitude: -179.96 },
        ]
      : scenario === "world"
        ? [
            { id: "west", latitude: 20, longitude: -170 },
            { id: "east", latitude: -20, longitude: 170 },
            { id: "middle", latitude: 0, longitude: 0 },
          ]
        : grid(
            viewState.center,
            [Number(params.get("step") ?? 0.03), Number(params.get("step") ?? 0.03) * 0.6],
            3,
            3,
          );

// `flows=N`: N flows with direction markers above the points (#195), over the dense area.
const flowCount = Number(params.get("flows") ?? 0);
const flows = Array.from({ length: flowCount }, (_, index) => ({
  from: [-3 + (index % 10) * 3, 41 + Math.floor(index / 10) * 1.5] as [number, number],
  id: `f-${index}`,
  to: [-1 + (index % 10) * 3, 43 + Math.floor(index / 10) * 1.5] as [number, number],
}));

window.retainedPoints = {
  controller: null,
  setViewState(state) {
    window.retainedPoints.controller?.setViewState(state);
  },
  stats() {
    return window.retainedPoints.controller?.getRendererStats() ?? null;
  },
};

createRoot(document.getElementById("map")!).render(
  <MapView
    fitToData={false}
    flatRuntime="maps"
    mapLabel="Retained points map"
    mapStyle={{ attribution: "", tiles: false }}
    onMapControllerReady={(controller) => {
      window.retainedPoints.controller = controller as Controller | null;
    }}
    style={{ height: 480, width: 640 }}
    viewState={scenario === "dense" ? undefined : viewState}
    defaultViewState={scenario === "dense" ? viewState : undefined}
  >
    <PointLayer
      points={points}
      pointColor="#ff0000"
      pointRadius={6}
      renderFeatureTooltip={(feature) => <span>Picked {feature.point.id}</span>}
    />
    {flowCount > 0 ? <FlowLayer flowColor="#1d4ed8" flows={flows} showDirection /> : null}
  </MapView>,
);
