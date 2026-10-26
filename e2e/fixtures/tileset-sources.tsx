import { PointLayer } from "../../src/point-layer";
import type { MapSurfaceController } from "../../src/map-display";
import { Component, useState, type ReactNode } from "react";
import type { MapsTileset } from "../../src/maps-tileset";
import { createRoot } from "react-dom/client";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";
import { MapView } from "../../src/map-view";
import { createFixtureTileset } from "../../src/tileset-fixtures";
import type { MapsVectorBasemapStyle } from "../../src/maps-tileset-style";
import "../../styles.css";

if (new URLSearchParams(location.search).has("canvas")) {
  Object.defineProperty(navigator, "gpu", { value: undefined });
}
declare global {
  interface Window {
    tilesetController: MapSurfaceController | null;
  }
}
const limits = new URLSearchParams(location.search).has("smallCache")
  ? { maxVisibleTiles: 1, cacheCapacity: 2, loadConcurrency: 1 }
  : undefined;
const points = [{ id: "application-point", longitude: 0, latitude: 0 }];
configureMapsWasmPackage("/wasm/maps_wasm.js");
function Host() {
  const [source, setSource] = useState(createFixtureTileset("a"));
  const [selected, setSelected] = useState<string | null>(null);
  const [style, setStyle] = useState<MapsVectorBasemapStyle>();
  return (
    <>
      <button onClick={() => setSource(createFixtureTileset("a"))}>Source A</button>
      <button onClick={() => setSource(createFixtureTileset("b"))}>Source B</button>
      <button onClick={() => setSource(createFixtureTileset("a", "2"))}>Revision 2</button>
      <button onClick={() => setSource({ ...source, sourceId: "" })}>Malformed manifest</button>
      <button
        onClick={() => {
          const untrusted: unknown = { ...source, schema: { ...source.schema, version: "2" } };
          // Deliberately cross the public untrusted-data boundary to verify rejection.
          setSource(untrusted as MapsTileset);
        }}
      >
        Unsupported schema
      </button>
      <button onClick={() => setStyle({ "land-forest": { color: "#ff0000" } })}>Red forest</button>
      <MapView
        flatRuntime="maps"
        fitToData={false}
        initialViewState={{ center: [0, 0], zoom: 0 }}
        tileset={source}
        tilesetStyle={style}
        tileLimits={limits}
        onMapControllerReady={(controller) => {
          window.tilesetController = controller;
        }}
        style={{ width: limits ? 200 : 640, height: limits ? 200 : 480, minHeight: 0 }}
      >
        <PointLayer
          points={points}
          pointRadius={10}
          selectedFeatureId={selected}
          onSelectedFeatureIdChange={setSelected}
        />
      </MapView>
      <output aria-label="Selected Map Feature">{selected ?? "none"}</output>
    </>
  );
}
class ManifestBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null };
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  render() {
    return this.state.message ? <p role="alert">{this.state.message}</p> : this.props.children;
  }
}
createRoot(document.getElementById("map")!).render(
  <ManifestBoundary>
    <Host />
  </ManifestBoundary>,
);
