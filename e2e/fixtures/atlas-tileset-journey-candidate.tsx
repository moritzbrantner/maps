// Candidate of `maps-atlas-tileset-v1`: the public first-party Map View over the
// content-pinned Atlas PMTiles tilesets, with nothing else on the page.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { createAtlasTileset, type AtlasRegion } from "../../demo/atlas-source";
import { configureMapsWasmPackage } from "../../src/aggregation-wasm";
import type { MapSurfaceController } from "../../src/map-display";
import { MapView } from "../../src/map-view";
import type { MapsRendererStats } from "../../src/maps-browser-runtime";
import "../../styles.css";
import { ATLAS_JOURNEY_INITIAL, type AtlasJourneyImplementation } from "./atlas-tileset-journey";

type Controller = MapSurfaceController & { getRendererStats(): MapsRendererStats | null };

const emptyStyle = { tiles: false as const };
const tilesets = {
  liechtenstein: createAtlasTileset("liechtenstein", import.meta.env.BASE_URL),
  "liechtenstein-north": createAtlasTileset("liechtenstein-north", import.meta.env.BASE_URL),
};

export function mount(container: HTMLElement): Promise<AtlasJourneyImplementation> {
  configureMapsWasmPackage(
    new URL(`${import.meta.env.BASE_URL}wasm/maps_wasm.js`, location.origin).href,
  );
  return new Promise((resolve) => {
    let setRegion: (region: AtlasRegion) => void = () => {};
    let region: AtlasRegion = "liechtenstein";
    let camera: { center: readonly [number, number]; zoom: number } = ATLAS_JOURNEY_INITIAL;

    function Host() {
      const [active, setActive] = useState<AtlasRegion>(region);
      useEffect(() => {
        setRegion = setActive;
      }, []);
      return (
        <MapView
          flatRuntime="maps"
          fitToData={false}
          initialViewState={{ center: [...ATLAS_JOURNEY_INITIAL.center], zoom: camera.zoom }}
          mapLabel="Atlas tileset journey"
          mapStyle={emptyStyle}
          maxZoom={20}
          onMapControllerReady={(controller) => {
            if (controller) resolve(implementation(controller as Controller));
          }}
          tileset={tilesets[active]}
          style={{ height: "100vh", minHeight: 0, width: "100vw" }}
        />
      );
    }

    function implementation(controller: Controller): AtlasJourneyImplementation {
      const canvas = () =>
        document.querySelector<HTMLCanvasElement>('canvas[data-flat-runtime="maps"]');
      return {
        name: "maps",
        apply(step) {
          if (step.kind === "camera") {
            camera = step;
            controller.setViewState({ center: [...step.center], zoom: step.zoom });
          } else {
            region = step.region;
            setRegion(step.region);
          }
        },
        settled() {
          const data = canvas()?.dataset;
          if (!data) return false;
          if (data.mapBaseTileError) throw new Error(`Atlas source failed: ${data.mapBaseTileError}`);
          const view = controller.getViewState();
          const tiles = Number(
            data.mapBaseRenderer === "wgpu" ? data.mapVectorTiles : data.mapBaseTiles,
          );
          return (
            data.mapSourceId === tilesets[region].sourceId &&
            data.mapSourceState === "ready" &&
            data.mapBasePendingTiles === "0" &&
            tiles > 0 &&
            Math.abs(view.center[0] - camera.center[0]) < 1e-9 &&
            Math.abs(view.center[1] - camera.center[1]) < 1e-9 &&
            Math.abs(view.zoom - camera.zoom) < 1e-9
          );
        },
        observe() {
          const stats = controller.getRendererStats();
          const data = canvas()?.dataset;
          return {
            backend: stats?.backend ?? null,
            sourceId: stats?.tileset?.descriptor.sourceId ?? null,
            dataRevision: stats?.tileset?.descriptor.dataRevision ?? null,
            presentedTiles: Number(
              data?.mapBaseRenderer === "wgpu" ? data.mapVectorTiles : data?.mapBaseTiles,
            ),
            requests: stats?.tileset?.requests ?? null,
            rustDecodes: stats?.tileset?.decodes ?? null,
            bucketBuilds: stats?.tileset?.bucketBuilds ?? null,
            cacheReuses: stats?.tileset?.cacheReuses ?? null,
            retainedTiles: stats?.tileset?.retainedTiles ?? null,
            retainedRgbaAndMvtBytesLowerBound: stats?.tileset?.retainedBytes ?? null,
            retainedGpuBufferBytes: stats?.retainedVectorBytes ?? null,
            sourceSwitchMs: stats?.tileset?.switchMs ?? null,
          };
        },
      };
    }

    createRoot(container).render(<Host />);
  });
}
