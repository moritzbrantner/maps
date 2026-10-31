/**
 * Oracle fixture page: `oracle/index.html?scenario=<name>&runtime=maplibre|maps`.
 * Renders one named scenario through the public `MapView` seam and exposes `window.__oracle`
 * for the runner (readiness, picked ids, camera, frame timing). Both runtimes receive the
 * same style, tiles, camera and data; nothing here is runtime-specific except readiness.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  ClusterLayer,
  GeoJsonLayer,
  MapView,
  PointLayer,
  type AggregatedMapFeature,
  type MapPoint,
  type MapSurfaceController,
  type MapViewState,
  type RasterMapStyle,
} from "../src";
import { configureMapsWasmPackage } from "../src/aggregation-wasm";
import "../styles.css";
import {
  DEAD_SEA_SCROLLS,
  findScenario,
  TILE_ORIGIN,
  type LngLat,
  type Scenario,
} from "./scenarios.ts";

configureMapsWasmPackage("/wasm/maps_wasm.js");

type Runtime = "maplibre" | "maps";
type PickEvent = { kind: "hover" | "select"; layer: string; id: string | null; source: string };

type OracleApi = {
  controller: MapSurfaceController | null;
  events: PickEvent[];
  maplibre: { loaded(): boolean; areTilesLoaded(): boolean; isMoving(): boolean } | null;
  runtime: Runtime;
  scenario: Scenario;
  frameTimes(frames: number): Promise<number[]>;
  viewState(): MapViewState | null;
};

declare global {
  interface Window {
    __oracle: OracleApi;
  }
}

const params = new URLSearchParams(location.search);
const scenario = findScenario(params.get("scenario") ?? "");
const runtime: Runtime = params.get("runtime") === "maps" ? "maps" : "maplibre";

const oracle: OracleApi = {
  controller: null,
  events: [],
  maplibre: null,
  runtime,
  scenario,
  frameTimes,
  viewState: () => oracle.controller?.getViewState() ?? null,
};
window.__oracle = oracle;

/** Exactly one raster source/layer: the one style form both runtimes accept. */
const style = {
  layers: [{ id: "oracle-raster", source: "oracle", type: "raster" }],
  sources: {
    oracle: {
      maxzoom: 19,
      tileSize: 256,
      tiles: [`${TILE_ORIGIN}/${scenario.tiles}/{z}/{x}/{y}.png`],
      type: "raster",
    },
  },
  version: 8,
} as unknown as RasterMapStyle;

function record(layer: string, kind: PickEvent["kind"]) {
  return (id: string | null, context: { source: string }) => {
    oracle.events.push({ id, kind, layer, source: context.source });
  };
}

function pickProps(layer: string) {
  return {
    onHoveredFeatureIdChange: record(layer, "hover"),
    onSelectedFeatureIdChange: record(layer, "select"),
  };
}

function App() {
  const [selected, setSelected] = useState<Record<string, string | null>>({});
  const select = useCallback(
    (layer: string) => (id: string | null, context: { source: string }) => {
      oracle.events.push({ id, kind: "select", layer, source: context.source });
      setSelected((current) => ({ ...current, [layer]: id }));
    },
    [],
  );
  const layers = useMemo(() => renderScenario(scenario.name), []);

  return (
    <div id="map" style={{ height: scenario.size.height, width: scenario.size.width }}>
      <MapView
        defaultViewState={scenario.camera}
        fitToData={false}
        flatRuntime={runtime}
        mapLabel={`Oracle ${scenario.name}`}
        mapStyle={style}
        onMapControllerReady={(controller) => {
          oracle.controller = controller;
        }}
        {...(runtime === "maplibre"
          ? {
              onMapReady: (map: OracleApi["maplibre"]) => {
                oracle.maplibre = map;
              },
            }
          : {})}
        showAttributionControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        {layers({ select, selected })}
      </MapView>
    </div>
  );
}

type LayerContext = {
  select: (layer: string) => (id: string | null, context: { source: string }) => void;
  selected: Record<string, string | null>;
};

function interactive(layer: string, context: LayerContext) {
  return {
    ...pickProps(layer),
    onSelectedFeatureIdChange: context.select(layer),
    selectedFeatureId: context.selected[layer] ?? null,
  };
}

function renderScenario(name: string): (context: LayerContext) => ReactNode {
  switch (name) {
    case "source-location":
      return (context) => (
        <PointLayer
          {...interactive("source", context)}
          layerId="source-location"
          pointColor="#b45309"
          pointRadius={9}
          points={[
            {
              id: "dead-sea-scrolls",
              label: "Dead Sea Scrolls",
              latitude: DEAD_SEA_SCROLLS[1],
              longitude: DEAD_SEA_SCROLLS[0],
              properties: { found: "1947-1956" },
            },
          ]}
          renderFeaturePopup={(feature) => <span>Found: {String(feature.point.properties?.found)}</span>}
        />
      );
    case "church-site-discovery":
      return (context) => (
        <>
          <GeoJsonLayer
            featureCollection={germanyBoundary}
            layerId="germany-boundary"
            polygonFillColor="#e7dfcf"
            polygonFillOpacity={0.82}
            polygonStrokeColor="#53634e"
            polygonStrokeWidth={2}
          />
          <GeoJsonLayer
            {...interactive("territory", context)}
            featureCollection={provinceTerritories}
            getFeatureStyle={(feature) => ({
              polygonFillColor: String(feature.properties.color),
              polygonFillOpacity: context.selected.territory === feature.id ? 0.42 : 0.24,
              polygonStrokeColor: context.selected.territory === feature.id ? "#172018" : "#7a6a58",
              polygonStrokeWidth: context.selected.territory === feature.id ? 2.4 : 1.15,
            })}
            layerId="diocese-territories"
          />
          <ClusterLayer
            {...interactive("site", context)}
            clusterRadius={54}
            getFeatureId={clusterFeatureId}
            layerId="church-sites"
            points={churchSites}
          />
          <GeoJsonLayer
            {...interactive("seat", context)}
            featureCollection={dioceseSeats}
            getFeatureStyle={(feature) => ({
              pointColor: feature.properties.kind === "archdiocese" ? "#8f2f24" : "#315f4f",
              pointRadius: feature.properties.kind === "archdiocese" ? 8 : 6,
            })}
            layerId="diocese-seats"
          />
        </>
      );
    case "zoom-crossfade":
      return () => null;
    case "labels":
      return (context) => (
        <PointLayer
          {...interactive("city", context)}
          getPointLabel={(feature) => feature.point.label ?? null}
          layerId="city-labels"
          pointColor="#1d4ed8"
          pointRadius={14}
          points={cityPoints}
        />
      );
    case "clusters":
      return (context) => (
        <ClusterLayer
          {...interactive("cluster", context)}
          getFeatureId={clusterFeatureId}
          layerId="comparison-clusters"
          points={comparisonPoints}
        />
      );
    default:
      throw new Error(`no layers for scenario ${name}`);
  }
}

function clusterFeatureId(feature: AggregatedMapFeature<unknown>) {
  return feature.kind === "cluster"
    ? `cluster:${feature.clusterId}:${feature.pointCount}`
    : `point:${feature.point.id}`;
}

/** Median-free raw rAF intervals while the camera moves every frame. */
async function frameTimes(frames: number): Promise<number[]> {
  const controller = oracle.controller;
  if (!controller) throw new Error("no map controller");
  const start = controller.getViewState();
  const [lon, lat] = start.center;
  const times: number[] = [];
  let last = await nextFrame();
  for (let frame = 0; frame < frames; frame++) {
    const angle = (frame / frames) * Math.PI * 2;
    controller.setViewState({
      center: [lon + Math.cos(angle) * 0.4, lat + Math.sin(angle) * 0.25],
      zoom: start.zoom + Math.sin(angle * 2) * 0.2,
    });
    const now = await nextFrame();
    times.push(now - last);
    last = now;
  }
  controller.setViewState(start);
  return times;
}

function nextFrame() {
  return new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

// ---- Scenario data (Maps-owned copies of the consumer seeds, see oracle/scenarios.ts) ----

const ring = (points: LngLat[]) => [...points, points[0]!];

/** A simplified Germany outline (church-atlas renders world-atlas countries-50m). */
const germanyBoundary = {
  features: [
    {
      geometry: {
        coordinates: [
          ring([
            [5.87, 51.05], [6.1, 50.75], [6.4, 50.3], [6.13, 49.5], [6.65, 49.2], [7.6, 49.1],
            [8.2, 48.97], [7.6, 48.1], [7.55, 47.6], [8.6, 47.65], [9.6, 47.53], [10.4, 47.3],
            [10.9, 47.5], [12.2, 47.6], [13.0, 47.5], [12.75, 48.1], [13.8, 48.6], [12.6, 49.4],
            [12.1, 50.3], [13.0, 50.5], [14.3, 50.9], [14.8, 51.0], [15.0, 51.5], [14.6, 52.6],
            [14.2, 53.25], [14.4, 53.9], [13.0, 54.45], [11.0, 54.0], [10.9, 54.4], [9.9, 54.8],
            [8.6, 54.9], [8.6, 54.3], [8.9, 53.9], [7.0, 53.6], [7.2, 53.2], [7.0, 52.6],
            [6.7, 52.5], [6.9, 52.0], [6.0, 51.85],
          ]),
        ],
        type: "Polygon" as const,
      },
      id: "DE",
      properties: { name: "Germany" },
      type: "Feature" as const,
    },
  ],
  type: "FeatureCollection" as const,
};

const province = (id: string, color: string, points: LngLat[]) => ({
  geometry: { coordinates: [ring(points)], type: "Polygon" as const },
  id,
  properties: { color, id },
  type: "Feature" as const,
});

/** Ecclesiastical provinces as coarse territories (church-atlas derives finer ones). */
const provinceTerritories = {
  features: [
    province("hamburg", "#4f7cac", [[7.0, 52.4], [11.3, 52.4], [11.3, 54.0], [9.9, 54.8], [8.6, 54.9], [8.6, 53.9], [7.0, 53.6]]),
    province("berlin", "#8f6bb0", [[11.3, 51.2], [15.0, 51.2], [14.6, 52.6], [14.4, 53.9], [13.0, 54.45], [11.3, 54.0]]),
    province("paderborn", "#b7844f", [[8.2, 50.4], [11.3, 50.4], [11.3, 52.4], [8.2, 52.4]]),
    province("cologne", "#c25b56", [[5.9, 49.4], [8.2, 49.4], [8.2, 52.4], [7.0, 52.4], [6.0, 51.85], [5.87, 51.05]]),
    province("freiburg", "#5d9b74", [[7.55, 47.6], [9.6, 47.53], [10.2, 48.6], [9.4, 49.4], [8.2, 49.4], [7.6, 48.1]]),
    province("bamberg", "#d1a646", [[8.2, 49.4], [9.4, 49.4], [10.2, 48.6], [12.6, 49.4], [12.1, 50.4], [8.2, 50.4]]),
    province("munich", "#5c8fa3", [[9.6, 47.53], [13.0, 47.5], [12.75, 48.1], [13.8, 48.6], [12.6, 49.4], [10.2, 48.6]]),
  ],
  type: "FeatureCollection" as const,
};

const churchSites: Array<MapPoint<{ kind: string }>> = (
  [
    ["cologne-cathedral", "Cologne Cathedral", "cathedral", 50.9413, 6.9583],
    ["aachen-cathedral", "Aachen Cathedral", "cathedral", 50.7748, 6.0839],
    ["speyer-cathedral", "Speyer Cathedral", "cathedral", 49.3172, 8.4412],
    ["freiburg-minster", "Freiburg Minster", "cathedral", 47.9959, 7.8522],
    ["mainz-cathedral", "Mainz Cathedral", "cathedral", 49.999, 8.2742],
    ["trier-cathedral", "Trier Cathedral", "cathedral", 49.7567, 6.6439],
    ["munich-frauenkirche", "Munich Frauenkirche", "cathedral", 48.1386, 11.5738],
    ["berlin-st-hedwig", "St. Hedwig's Cathedral", "cathedral", 52.5163, 13.3949],
    ["hamburg-st-marien", "St. Mary's Cathedral Hamburg", "cathedral", 53.5553, 10.0094],
    ["paderborn-cathedral", "Paderborn Cathedral", "cathedral", 51.7191, 8.7575],
    ["ettenheim-wallfahrtskapelle", "Wallfahrtskapelle Ettenheimmunster", "chapel", 48.2533, 7.8456],
    ["altotting-grace-chapel", "Chapel of Grace Altotting", "chapel", 48.2254, 12.6767],
    ["kevelaer-gnadenkapelle", "Gnadenkapelle Kevelaer", "chapel", 51.5823, 6.2474],
    ["wieskirche", "Pilgrimage Church of Wies", "church", 47.6814, 10.9006],
    ["andernach-maria-himmelfahrt", "Maria Himmelfahrt Andernach", "church", 50.4398, 7.4012],
    ["bamberg-cathedral", "Bamberg Cathedral", "cathedral", 49.8914, 10.8827],
  ] as const
).map(([id, label, kind, latitude, longitude]) => ({
  id,
  label,
  latitude,
  longitude,
  properties: { kind },
}));

const dioceseSeats = {
  features: (
    [
      ["bamberg", "archdiocese", 49.8987, 10.9028],
      ["eichstaett", "diocese", 48.891, 11.1839],
      ["speyer", "diocese", 49.3172, 8.4412],
      ["wuerzburg", "diocese", 49.7913, 9.9534],
      ["berlin", "archdiocese", 52.5163, 13.3949],
      ["dresden-meissen", "diocese", 51.051, 13.7416],
      ["goerlitz", "diocese", 51.1526, 14.9885],
      ["cologne", "archdiocese", 50.9413, 6.9583],
      ["aachen", "diocese", 50.7748, 6.0839],
      ["essen", "diocese", 51.4556, 7.0116],
      ["limburg", "diocese", 50.3879, 8.0677],
      ["muenster", "diocese", 51.9626, 7.6257],
      ["trier", "diocese", 49.7567, 6.6439],
      ["freiburg", "archdiocese", 47.9959, 7.8522],
      ["mainz", "diocese", 49.999, 8.2742],
      ["rottenburg-stuttgart", "diocese", 48.4764, 8.9359],
      ["hamburg", "archdiocese", 53.5553, 10.0094],
      ["hildesheim", "diocese", 52.1506, 9.9474],
      ["osnabrueck", "diocese", 52.2763, 8.0434],
      ["munich-freising", "archdiocese", 48.1386, 11.5738],
      ["augsburg", "diocese", 48.3655, 10.8945],
      ["passau", "diocese", 48.5744, 13.4654],
      ["regensburg", "diocese", 49.0194, 12.0975],
      ["paderborn", "archdiocese", 51.7191, 8.7575],
      ["erfurt", "diocese", 50.9756, 11.0231],
      ["fulda", "diocese", 50.5547, 9.6728],
      ["magdeburg", "diocese", 52.1256, 11.6356],
    ] as const
  ).map(([id, kind, latitude, longitude]) => ({
    geometry: { coordinates: [longitude, latitude] as LngLat, type: "Point" as const },
    id,
    properties: { id, kind },
    type: "Feature" as const,
  })),
  type: "FeatureCollection" as const,
};

const cityPoints: MapPoint[] = (
  [
    ["berlin", "Berlin", 52.52, 13.405],
    ["hamburg", "Hamburg", 53.5511, 9.9937],
    ["munich", "Munich", 48.1351, 11.582],
    ["cologne", "Cologne", 50.9375, 6.9603],
    ["frankfurt", "Frankfurt", 50.1109, 8.6821],
    ["leipzig", "Leipzig", 51.3397, 12.3731],
    ["nuremberg", "Nuremberg", 49.4521, 11.0767],
    ["hanover", "Hanover", 52.3759, 9.732],
  ] as const
).map(([id, label, latitude, longitude]) => ({ id, label, latitude, longitude }));

/** The demo/RendererComparison point set: 8 hubs × 44 points. */
const comparisonPoints: MapPoint[] = (() => {
  const hubs = [
    [13.405, 52.52, "berlin"],
    [9.1829, 48.7758, "stuttgart"],
    [11.582, 48.1351, "munich"],
    [9.9937, 53.5511, "hamburg"],
    [6.9603, 50.9375, "cologne"],
    [16.3738, 48.2082, "vienna"],
    [8.5417, 47.3769, "zurich"],
    [14.4378, 50.0755, "prague"],
  ] as const;
  return hubs.flatMap(([longitude, latitude, hub]) =>
    Array.from({ length: 44 }, (_, index) => {
      const angle = index * 2.399963229728653;
      const distance = 0.05 + (index % 11) * 0.035;
      return {
        id: `${hub}-${index}`,
        label: `${hub} ${index + 1}`,
        latitude: latitude + Math.sin(angle) * distance,
        longitude: longitude + Math.cos(angle) * distance * 1.35,
      };
    }),
  );
})();

createRoot(document.getElementById("root")!).render(<App />);
