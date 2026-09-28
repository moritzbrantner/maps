// Vector basemap parity host: one Shortbread basemap, no application layers, so the
// retained WebGPU buckets (`?renderer=wgpu`) and the Canvas GeoJSON overlay
// (`?renderer=canvas`) can be compared pixel for pixel under one camera.
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";
import type { MapsRasterTileId } from "../../src/flat-runtime-wasm";
import { GeoJsonLayer, type GeoJsonLayerFeature } from "../../src/geojson-layer";
import type { MapSurfaceController, MapViewState } from "../../src/map-display";
import type { MapsCanvasFlatRuntimeController } from "../../src/maps-browser-runtime";
import { MapView } from "../../src/map-view";
import {
  getShortbreadBasemapStyle,
  useShortbreadBasemap,
  type ShortbreadFeatureProperties,
} from "../../demo/ShortbreadBasemapLayer";

configureMapsWasmPackage("/wasm/maps_wasm.js");

type Controller = MapSurfaceController &
  Pick<
    MapsCanvasFlatRuntimeController,
    "getRetainedVectorBasemap" | "getVisibleTiles" | "subscribeBaseRenderer"
  >;

const params = new URLSearchParams(location.search);
const forceOverlay = params.get("renderer") === "canvas";
const viewState: MapViewState = {
  center: [Number(params.get("lon") ?? 10.3), Number(params.get("lat") ?? 50.4)],
  zoom: Number(params.get("zoom") ?? 4.4),
  ...(params.has("bearing") ? { bearing: Number(params.get("bearing")) } : {}),
};

function Host() {
  const [controller, setController] = useState<Controller | null>(null);
  const [tiles, setTiles] = useState<MapsRasterTileId[]>([]);
  const basemap = useShortbreadBasemap(tiles, { controller, forceOverlay });
  const onController = useCallback((next: MapSurfaceController | null) => {
    const mapsController = next as Controller | null;
    setController(mapsController);
    setTiles(mapsController?.getVisibleTiles() ?? []);
  }, []);
  return (
    <>
      <MapView
        fitToData={false}
        flatRuntime="maps"
        mapLabel="Vector basemap parity map"
        mapStyle={{ attribution: "", tiles: false }}
        onMapControllerReady={onController}
        style={{ height: 480, width: 640 }}
        viewState={viewState}
      >
        {basemap.renderer === "canvas-overlay" ? (
          <GeoJsonLayer
            featureCollection={basemap.featureCollection}
            getFeatureStyle={(feature: GeoJsonLayerFeature) => {
              const properties = feature.properties as ShortbreadFeatureProperties;
              return getShortbreadBasemapStyle(properties.kind, properties.sourceKind);
            }}
            isFeatureInteractive={() => false}
            layerId="shortbread-basemap"
          />
        ) : null}
      </MapView>
      <output
        data-feature-count={basemap.featureCount}
        data-renderer={basemap.renderer}
        data-state={basemap.state}
        data-tile-count={basemap.tileCount}
        hidden
      />
    </>
  );
}

createRoot(document.getElementById("map")!).render(<Host />);
