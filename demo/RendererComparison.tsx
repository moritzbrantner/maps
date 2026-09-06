import { useMemo, useState } from "react";

import {
  ClusteredMap,
  NativeSelect,
  type AggregatedMapFeature,
  type MapPoint,
  type MapViewState,
} from "@moritzbrantner/maps";
import { CanvasClusteredMap } from "../src/canvas-clustered-map";
import { demoMapStyle } from "./data/map-style";

type RendererBackend = "maplibre" | "canvas2d";

type ComparisonPointProperties = {
  demand: number;
  region: string;
};

const initialViewState: MapViewState = { center: [10.3, 50.4], zoom: 4.4 };

export function RendererComparison() {
  const [backend, setBackend] = useState<RendererBackend>("maplibre");
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(initialViewState);
  const points = useMemo(() => createComparisonPoints(), []);
  const MapComponent = backend === "canvas2d" ? CanvasClusteredMap : ClusteredMap;

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
            Same Maps frame, different pixels
          </h2>
          <p className="mb-0 mt-2 text-sm leading-6 text-muted-foreground">
            Switch the point/cluster data layer without changing the viewport, selection, clustering,
            or expansion semantics. MapLibre still supplies the camera and basemap; Canvas2D is a
            deliberately small reference renderer over the Maps-owned frame.
          </p>
        </div>
        <label className="grid min-w-44 gap-1 text-xs font-medium text-muted-foreground">
          <span>Data renderer</span>
          <NativeSelect
            aria-label="Point cluster renderer"
            value={backend}
            onChange={(event) => setBackend(event.target.value as RendererBackend)}
          >
            <option value="maplibre">MapLibre layer</option>
            <option value="canvas2d">Canvas2D layer</option>
          </NativeSelect>
        </label>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-muted">
        <MapComponent
          fitToData={false}
          getFeatureId={getComparisonFeatureId}
          mapLabel="Renderer parity map"
          mapStyle={demoMapStyle}
          onFeatureSelect={(feature) => setSelectedFeatureId(feature ? getComparisonFeatureId(feature) : null)}
          onViewStateChange={setViewState}
          points={points}
          selectedFeatureId={selectedFeatureId}
          style={{ minHeight: 430 }}
          viewState={viewState}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>
          Backend: <strong className="text-foreground">{backend === "canvas2d" ? "Canvas2D" : "MapLibre"}</strong>
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
      points.push({
        id: `${label.toLowerCase()}-${index}`,
        label: `${label} ${index + 1}`,
        latitude: latitude + Math.sin(angle) * distance,
        longitude: longitude + Math.cos(angle) * distance * 1.35,
        metrics: { demand: 20 + ((index * 17 + hubIndex * 13) % 180) },
        properties: {
          demand: 20 + ((index * 17 + hubIndex * 13) % 180),
          region,
        },
      });
    }
  }

  return points;
}
