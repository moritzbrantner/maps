import { useCallback, useMemo, useState } from "react";

import { NativeSelect } from "@moritzbrantner/ui";
import {
  ClusterLayer,
  GeoJsonLayer,
  MapView,
  type AggregatedMapFeature,
  type MapPoint,
  type MapSurfaceController,
  type MapViewState,
  type RasterMapStyle,
} from "@moritzbrantner/maps";
import type { MapsCanvasFlatRuntimeController } from "../src/canvas-flat-runtime";
import { demoMapStyle } from "./data/map-style";
import {
  getShortbreadBasemapStyle,
  useShortbreadBasemap,
} from "./ShortbreadBasemapLayer";

type RendererBackend = "maps" | "maplibre";

type MapsDemoController = MapSurfaceController &
  Pick<MapsCanvasFlatRuntimeController, "getVisibleTiles">;

type ComparisonPointProperties = {
  demand: number;
  region: string;
};

const initialViewState: MapViewState = { center: [10.3, 50.4], zoom: 4.4 };
const firstPartyMapStyle: RasterMapStyle = {
  attribution: "© OpenStreetMap contributors",
  tiles: false,
};

export function RendererComparison() {
  const [backend, setBackend] = useState<RendererBackend>("maps");
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(initialViewState);
  const [mapsController, setMapsController] = useState<MapsDemoController | null>(null);
  const points = useMemo(() => createComparisonPoints(), []);
  const visibleTiles = backend === "maps" ? (mapsController?.getVisibleTiles() ?? []) : [];
  const basemap = useShortbreadBasemap(visibleTiles);
  const handleControllerReady = useCallback((controller: MapSurfaceController | null) => {
    setMapsController(
      controller && "getVisibleTiles" in controller
        ? (controller as MapsDemoController)
        : null,
    );
  }, []);
  const layerProps = {
    getFeatureId: getComparisonFeatureId,
    onFeatureSelect: (feature: AggregatedMapFeature<ComparisonPointProperties> | null) =>
      setSelectedFeatureId(feature ? getComparisonFeatureId(feature) : null),
    points,
    selectedFeatureId,
  };

  return (
    <section
      aria-label="Renderer comparison"
      className="mx-auto mt-5 grid w-[min(1480px,calc(100%-44px))] gap-4 rounded-3xl border border-border bg-card p-4 shadow-sm md:p-5"
      data-testid="renderer-comparison"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="max-w-3xl">
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Renderer boundary
          </p>
          <h2 className="mb-0 mt-1 text-xl font-semibold tracking-tight md:text-2xl">
            First-party Maps engine
          </h2>
          <p className="mb-0 mt-2 text-sm leading-6 text-muted-foreground">
            This is the Maps-owned runtime: our Rust/WASM camera and tile cover drive our wgpu
            renderer. OpenStreetMap Shortbread vector tiles are decoded by Maps and turned into our
            own render geometry; MapLibre remains only as a reference path.
          </p>
        </div>
        <label className="grid min-w-44 gap-1 text-xs font-medium text-muted-foreground">
          <span>Engine</span>
          <NativeSelect
            aria-label="Map engine"
            value={backend}
            onChange={(event) => setBackend(event.target.value as RendererBackend)}
          >
            <option value="maps">Maps engine (first-party)</option>
            <option value="maplibre">MapLibre (reference)</option>
          </NativeSelect>
        </label>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-muted">
        <MapView
          fitToData={false}
          flatRuntime={backend === "maps" ? "maps" : undefined}
          mapLabel="Renderer parity map"
          mapStyle={backend === "maps" ? firstPartyMapStyle : demoMapStyle}
          onMapControllerReady={handleControllerReady}
          onViewStateChange={setViewState}
          style={{ minHeight: 430 }}
          viewState={viewState}
        >
          {backend === "maps" && basemap.enabled ? (
            <GeoJsonLayer
              featureCollection={basemap.featureCollection}
              getFeatureStyle={(feature) =>
                getShortbreadBasemapStyle(feature.properties.kind)
              }
              isFeatureInteractive={() => false}
              layerId="shortbread-basemap"
            />
          ) : null}
          <ClusterLayer {...layerProps} />
        </MapView>
      </div>

      <span
        aria-hidden="true"
        data-shortbread-error={basemap.error ?? undefined}
        data-shortbread-feature-count={basemap.featureCollection.features.length}
        data-shortbread-state={basemap.state}
        data-shortbread-tile-count={basemap.tileCount}
        hidden
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>
          Backend:{" "}
          <strong className="text-foreground">
            {backend === "maps" ? "Maps engine" : "MapLibre reference"}
          </strong>
        </span>
        <span>
          Basemap:{" "}
          <strong className="text-foreground">
            {backend === "maps" ? "Shortbread vector / Maps renderer" : "MapLibre reference"}
          </strong>
        </span>
        <span>
          Visible source points: <strong className="text-foreground">{points.length}</strong>
        </span>
        <span>
          Selection: <strong className="text-foreground">{selectedFeatureId ?? "none"}</strong>
        </span>
      </div>
    </section>
  );
}

function getComparisonFeatureId(feature: AggregatedMapFeature<ComparisonPointProperties>) {
  return feature.kind === "cluster" ? `cluster:${feature.clusterId}` : `point:${feature.point.id}`;
}

function createComparisonPoints(): Array<MapPoint<ComparisonPointProperties>> {
  const hubs = [
    [13.405, 52.52, "Berlin", "north-east"],
    [9.1829, 48.7758, "Stuttgart", "south-west"],
    [11.582, 48.1351, "Munich", "south"],
    [9.9937, 53.5511, "Hamburg", "north"],
    [6.9603, 50.9375, "Cologne", "west"],
    [16.3738, 48.2082, "Vienna", "east"],
    [8.5417, 47.3769, "Zurich", "south-west"],
    [14.4378, 50.0755, "Prague", "east"],
  ] as const;
  const points: Array<MapPoint<ComparisonPointProperties>> = [];

  for (const [hubIndex, [longitude, latitude, label, region]] of hubs.entries()) {
    for (let index = 0; index < 44; index += 1) {
      const angle = index * 2.399963229728653;
      const distance = 0.05 + (index % 11) * 0.035;
      const demand = 20 + ((index * 17 + hubIndex * 13) % 180);
      points.push({
        id: `${label.toLowerCase()}-${index}`,
        label: `${label} ${index + 1}`,
        latitude: latitude + Math.sin(angle) * distance,
        longitude: longitude + Math.cos(angle) * distance * 1.35,
        metrics: { demand },
        properties: { demand, region },
      });
    }
  }

  return points;
}
