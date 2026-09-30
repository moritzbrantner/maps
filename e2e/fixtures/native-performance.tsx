import "../../styles.css";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { MapsMapView } from "../../src/maps-map-view";
import { PointLayer } from "../../src/point-layer";
import { FlowLayer } from "../../src/flow-layer";
import type { MapSurfaceController, MapViewState } from "../../src/map-display";
import {
  points,
  flows,
  initialCamera,
  observeNativeMap,
  probe,
  pointColor,
  flowColor,
  filterPoint,
  weight,
} from "./native-map-probe";

await observeNativeMap();
function ControlledMap() {
  const [camera, setCamera] = useState<MapViewState>(initialCamera);
  const [, setController] = useState<MapSurfaceController | null>(null);
  const ready = useCallback((controller: MapSurfaceController) => {
    probe.readyCount++;
    setController(controller);
    probe.command = (state) => controller.setViewState(state);
  }, []);
  const changed = useCallback((state: MapViewState) => {
    probe.changes++;
    setCamera(state);
  }, []);
  return (
    <main>
      <h1>Retained native Map Layers</h1>
      <p>
        {points.length.toLocaleString()} native points and 100 arc flows. Controlled React
        composition.
      </p>
      <MapsMapView
        mapLabel="Native performance map"
        fitToData={false}
        mapStyle={{ tiles: false }}
        viewState={camera}
        onMapControllerReady={ready}
        onViewStateChange={changed}
        style={{ height: 480 }}
      >
        <FlowLayer
          flows={flows}
          flowShape="arc"
          showEndpoints={false}
          getFlowColor={flowColor}
          getWeight={weight}
        />
        <PointLayer
          points={points}
          filterPoint={filterPoint}
          getPointColor={pointColor}
          pointRadius={2}
          renderFeatureTooltip={(feature) => <span>Picked {feature.point.id}</span>}
        />
      </MapsMapView>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<ControlledMap />);
