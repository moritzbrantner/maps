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
  FlowLayer,
  GeoJsonLayer,
  type GeoJsonLayerStyle,
  MapView,
  PointLayer,
  type AggregatedMapFeature,
  type MapPoint,
  type MapsTileset,
  type MapsTilesetLayers,
  type MapSurfaceController,
  type MapViewState,
  type RasterMapStyle,
} from "../src";
import { configureMapsWasmPackage } from "../src/aggregation-wasm";
import { getShortbreadClassStyle } from "../src/maps-tileset-style";
import type { MapsVectorBasemapStyleClass } from "../src/vector-basemap";
import "../styles.css";
import alpineForeland from "./data/alpine-foreland.json";
import {
  DEAD_SEA_SCROLLS,
  findScenario,
  TILE_ORIGIN,
  type FrameTiming,
  type LngLat,
  type Scenario,
} from "./scenarios.ts";
import { LAND_BOUNDS, VECTOR_MAX_ZOOM } from "./vector-constants.ts";

configureMapsWasmPackage("/wasm/maps_wasm.js");

type Runtime = "maplibre" | "maps";
type PickEvent = { kind: "hover" | "select"; layer: string; id: string | null; source: string };

type OracleApi = {
  controller: MapSurfaceController | null;
  events: PickEvent[];
  maplibre: {
    loaded(): boolean;
    areTilesLoaded(): boolean;
    isMoving(): boolean;
    project(at: LngLat): { x: number; y: number };
  } | null;
  runtime: Runtime;
  scenario: Scenario;
  frameTimes(timing: FrameTiming): Promise<number[]>;
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

/** The alpine line collection, built once on first use. */
const alpineLineCache: { collection: ReturnType<typeof buildAlpineLines> | null } = { collection: null };

const rasterSource = (pattern: string) => ({
  maxzoom: 19,
  tileSize: 256,
  tiles: [`${TILE_ORIGIN}/${pattern}/{z}/{x}/{y}.png`],
  type: "raster",
});

/** Exactly one raster source/layer: the one style form both runtimes accept. */
const rasterStyle = (pattern: string) => ({
  layers: [{ id: "oracle-raster", source: "oracle", type: "raster" }],
  sources: { oracle: rasterSource(pattern) },
  version: 8,
});

/** The Maps Tileset for `vector` scenarios (tiles from `oracle/vector-tiles.ts`). */
const tileset: MapsTileset = {
  attribution: "Natural Earth",
  bounds: [...LAND_BOUNDS],
  dataRevision: "natural-earth-10m-alpine-foreland-v1",
  format: "mvt",
  license: "Public domain (Natural Earth)",
  maxZoom: VECTOR_MAX_ZOOM,
  minZoom: 0,
  projection: "web-mercator",
  provenance: "oracle/clip-natural-earth.mjs extract, cut by geojson-vt and encoded by vt-pbf",
  scheme: "xyz",
  schema: {
    id: "shortbread",
    sourceLayers: ["land", "water_polygons", "water_lines", "streets", "boundaries"],
    version: "1.0",
  },
  sourceId: "oracle-alpine-foreland",
  tileSize: 512,
  transport: { kind: "xyz", urlTemplate: `${TILE_ORIGIN}/vector/{z}/{x}/{y}.mvt` },
  version: 1,
};

/**
 * The Maps Shortbread class palette (`getShortbreadClassStyle`, the same table `tileset`
 * renders with) as a data-driven MapLibre style: fills by `kind`, outlines and lines by
 * source layer, in the Maps paint order.
 */
function vectorStyle() {
  const fill = (styleClass: MapsVectorBasemapStyleClass) => getShortbreadClassStyle(styleClass);
  const line = (id: string, sourceLayer: string, styleClass: MapsVectorBasemapStyleClass) => {
    const style = getShortbreadClassStyle(styleClass) as { color: string; opacity: number; width: number };
    return {
      id,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": style.color, "line-opacity": style.opacity, "line-width": style.width },
      source: "oracle-vector",
      "source-layer": sourceLayer,
      type: "line",
    };
  };
  const byKind = (property: "color" | "opacity", kind: string, special: MapsVectorBasemapStyleClass, base: MapsVectorBasemapStyleClass) => [
    "match",
    ["get", "kind"],
    kind,
    fill(special)[property],
    fill(base)[property],
  ];
  return {
    glyphs: GLYPHS_URL,
    layers: [
      { id: "background", paint: { "background-color": "#f9f4ee" }, type: "background" },
      {
        id: "land",
        paint: { "fill-color": byKind("color", "forest", "land-forest", "land"), "fill-opacity": byKind("opacity", "forest", "land-forest", "land") },
        source: "oracle-vector",
        "source-layer": "land",
        type: "fill",
      },
      {
        id: "water",
        paint: { "fill-color": byKind("color", "glacier", "water-glacier", "water"), "fill-opacity": byKind("opacity", "glacier", "water-glacier", "water") },
        source: "oracle-vector",
        "source-layer": "water_polygons",
        type: "fill",
      },
      line("water-outline", "water_polygons", "water-line"),
      line("water-lines", "water_lines", "water-line"),
      line("streets", "streets", "street"),
      line("boundaries", "boundaries", "boundary"),
    ] as Array<Record<string, unknown>>,
    sources: {
      "oracle-vector": {
        maxzoom: VECTOR_MAX_ZOOM,
        minzoom: 0,
        tileSize: 512,
        tiles: [tileset.transport.urlTemplate],
        type: "vector",
      },
    } as Record<string, unknown>,
    version: 8,
  };
}

/**
 * The `symbols` style layers (#321): MapLibre draws them in its style, Maps over its Tileset
 * (`tilesetLayers`). The very same layer objects reach both runtimes.
 */
const SYMBOL_LAYERS: Array<Record<string, unknown>> = [
  {
    id: "place-dots",
    paint: { "circle-color": "#1f2937", "circle-radius": ["interpolate", ["linear"], ["get", "rank"], 2, 5, 8, 3] },
    source: "oracle-vector",
    "source-layer": "places",
    type: "circle",
  },
  {
    id: "place-labels",
    layout: {
      "text-anchor": "left",
      "text-field": ["get", "name"],
      "text-font": ["NotoSans-Regular"],
      "text-offset": [0.6, 0],
      "text-size": ["interpolate", ["linear"], ["get", "rank"], 2, 20, 8, 13],
    },
    paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
    source: "oracle-vector",
    "source-layer": "places",
    type: "symbol",
  },
  {
    id: "lake-labels",
    filter: ["==", ["get", "kind"], "lake"],
    layout: { "text-field": ["get", "name"], "text-font": ["NotoSans-Regular"], "text-size": 14 },
    paint: { "text-color": "#1e3a8a", "text-halo-color": "#e0f2fe", "text-halo-width": 1 },
    source: "oracle-vector",
    "source-layer": "water_polygons",
    type: "symbol",
  },
];
const GLYPHS_URL = `${TILE_ORIGIN}/glyphs/{fontstack}/{range}.pbf`;
/**
 * The `tileset-lines` style layers (#322): MapLibre `line` layers with caps, joins and dashes
 * over the Tileset's Shortbread source layers, the same objects on both runtimes.
 */
const LINE_LAYERS: Array<Record<string, unknown>> = [
  {
    filter: ["==", ["get", "kind"], "motorway"],
    id: "motorway-casing",
    layout: { "line-cap": "square", "line-join": "bevel" },
    paint: { "line-color": "#c2410c", "line-width": 5 },
    source: "oracle-vector",
    "source-layer": "streets",
    type: "line",
  },
  {
    filter: ["==", ["get", "kind"], "primary"],
    id: "primary-dashes",
    layout: { "line-cap": "butt", "line-join": "miter" },
    paint: { "line-color": "#ea580c", "line-dasharray": [3, 1.5], "line-width": 3 },
    source: "oracle-vector",
    "source-layer": "streets",
    type: "line",
  },
  {
    id: "river-dots",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#1d4ed8", "line-dasharray": [0.5, 2], "line-opacity": 0.9, "line-width": 4 },
    source: "oracle-vector",
    "source-layer": "water_lines",
    type: "line",
  },
  {
    filter: ["==", ["get", "admin_level"], 2],
    id: "border-dash-dot",
    paint: { "line-color": "#7e22ce", "line-dasharray": [4, 2, 1, 2], "line-width": 2.5 },
    source: "oracle-vector",
    "source-layer": "boundaries",
    type: "line",
  },
];
const tilesetLayers = (name: string): MapsTilesetLayers | null =>
  name === "symbols"
    ? { glyphs: GLYPHS_URL, layers: SYMBOL_LAYERS }
    : name === "tileset-lines"
      ? { layers: LINE_LAYERS }
      : null;

/** MapLibre styles beyond the plain vector basemap: `symbols`, `tileset-lines` and the unsupported scenarios (#323, #324). */
function referenceStyle(name: string) {
  switch (name) {
    case "symbols": {
      const style = vectorStyle();
      style.layers.push(...SYMBOL_LAYERS);
      return style;
    }
    case "tileset-lines": {
      const style = vectorStyle();
      style.layers.push(...LINE_LAYERS);
      return style;
    }
    case "fill-pattern": {
      const style = { ...vectorStyle(), sprite: `${TILE_ORIGIN}/sprite/oracle` };
      style.layers.push({
        filter: ["==", ["get", "kind"], "glacier"],
        id: "glacier-hatch",
        paint: { "fill-pattern": "hatch" },
        source: "oracle-vector",
        "source-layer": "water_polygons",
        type: "fill",
      });
      return style;
    }
    case "hillshade-terrain": {
      const dem = {
        encoding: "terrarium",
        maxzoom: 12,
        tileSize: 256,
        tiles: [`${TILE_ORIGIN}/dem/{z}/{x}/{y}.png`],
        type: "raster-dem",
      };
      return {
        layers: [
          { id: "oracle-raster", source: "oracle", type: "raster" },
          {
            id: "hillshade",
            paint: { "hillshade-exaggeration": 0.6, "hillshade-shadow-color": "#3b3b3b" },
            source: "dem-hillshade",
            type: "hillshade",
          },
        ],
        sources: { "dem-hillshade": dem, "dem-terrain": dem, oracle: rasterSource("geographic") },
        terrain: { exaggeration: 1.2, source: "dem-terrain" },
        version: 8,
      };
    }
    default:
      throw new Error(`no reference style for scenario ${name}`);
  }
}

function styleFor(): RasterMapStyle {
  if (scenario.basemap === "style") return referenceStyle(scenario.name) as unknown as RasterMapStyle;
  if (scenario.basemap === "vector") {
    // Maps draws the basemap from `tileset`; MapLibre from the equivalent style.
    const style =
      scenario.unsupported || tilesetLayers(scenario.name) ? referenceStyle(scenario.name) : vectorStyle();
    return style as unknown as RasterMapStyle;
  }
  return rasterStyle(scenario.basemap) as unknown as RasterMapStyle;
}
const style = styleFor();
const styleLayers = tilesetLayers(scenario.name);

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
        {...(runtime === "maps" && scenario.basemap === "vector" ? { tileset } : {})}
        {...(runtime === "maps" && styleLayers ? { tilesetLayers: styleLayers } : {})}
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
    case "bearing":
    case "pitch":
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
    case "vector-tiles":
    case "symbols":
    case "tileset-lines":
    case "fill-pattern":
    case "hillshade-terrain":
      return () => null;
    case "line-styles":
      return (context) => (
        <GeoJsonLayer
          {...interactive("line", context)}
          featureCollection={alpineLines()}
          getFeatureStyle={(feature) => {
            const style = LINE_STYLES[String(feature.properties.kind)] ?? LINE_STYLES.secondary!;
            const rank = Number(feature.properties.rank ?? 6);
            const selected = context.selected.line === feature.id;
            const width = feature.properties.kind === "river" ? 1 + (10 - rank) * 0.35 : style.lineWidth!;
            return { ...style, lineWidth: selected ? width + 2 : width };
          }}
          layerId="alpine-lines"
        />
      );
    case "line-dash-caps-joins":
      // One layer per class, in MapLibre paint order: square-capped bevelled motorways, then
      // dashed primary roads (butt, miter), rivers (round dashes) and borders (dash-dot).
      return (context) => (
        <>
          {DASHED_LINE_CLASSES.map(({ filter, layer, style }) => (
            <GeoJsonLayer
              {...interactive(layer, context)}
              featureCollection={dashedLines(layer, filter)}
              key={layer}
              layerId={`dashed-${layer}`}
              {...style}
            />
          ))}
        </>
      );
    case "atlas-flows":
      return (context) => (
        <>
          <GeoJsonLayer
            featureCollection={romanProvinces}
            getFeatureStyle={(feature) => ({
              polygonFillColor: String(feature.properties.color),
              polygonFillOpacity: 0.28,
              polygonStrokeColor: "#5b4636",
              polygonStrokeWidth: 1.2,
            })}
            layerId="country-overlay"
          />
          <FlowLayer
            {...interactive("flow", context)}
            flowColor="#0f766e"
            flows={atlasFlows}
            getFeatureId={(feature) => feature.flow.id}
            maxWidth={9}
            minWidth={2}
            showDirection
            showEndpoints
          />
          <ClusterLayer
            {...interactive("entity", context)}
            clusterRadius={40}
            getFeatureId={clusterFeatureId}
            layerId="atlas-entities"
            points={atlasEntities}
          />
        </>
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

/**
 * Mean frame time (ms) of each batch of back-to-back frames while the camera moves every
 * frame, after an untimed warm-up of at least `warmupMs` and `warmupFrames`. Frames never
 * wait on anything but the next rAF, so the GPU stays busy and in its high power state; a
 * batch's mean also resolves far below the 0.1 ms granularity of a single rAF interval.
 */
async function frameTimes(timing: FrameTiming): Promise<number[]> {
  const controller = oracle.controller;
  if (!controller) throw new Error("no map controller");
  const start = controller.getViewState();
  const [lon, lat] = start.center;
  let frame = 0;
  const moveCamera = () => {
    const angle = (frame++ / timing.orbitFrames) * Math.PI * 2;
    controller.setViewState({
      ...start,
      center: [lon + Math.cos(angle) * 0.4, lat + Math.sin(angle) * 0.25],
      zoom: start.zoom + Math.sin(angle * 2) * 0.2,
    });
  };

  const warmupStart = await nextFrame();
  let now = warmupStart;
  while (frame < timing.warmupFrames || now - warmupStart < timing.warmupMs) {
    moveCamera();
    now = await nextFrame();
  }

  const means: number[] = [];
  let batchStart = now;
  for (let batch = 0; batch < timing.batches; batch++) {
    for (let index = 0; index < timing.batchFrames; index++) {
      moveCamera();
      now = await nextFrame();
    }
    means.push((now - batchStart) / timing.batchFrames);
    batchStart = now;
  }
  controller.setViewState(start);
  return means;
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

type AlpineFeature = {
  geometry: { coordinates: unknown; type: string };
  properties: Record<string, string | number | undefined>;
  type: "Feature";
};

/** One stable collection: a new object per render would make layers rebuild their data. */
function alpineLines() {
  return (alpineLineCache.collection ??= buildAlpineLines());
}

/** Rivers, roads and borders of the Natural Earth extract, with stable ids for picking. */
function buildAlpineLines() {
  return {
    features: (alpineForeland.features as AlpineFeature[]).flatMap((feature, index) => {
      const { layer, ...properties } = feature.properties;
      if (layer !== "water_lines" && layer !== "streets" && layer !== "boundaries") return [];
      return [{ ...feature, id: `${layer}-${index}`, properties: { kind: "boundary", ...properties } }];
    }),
    type: "FeatureCollection" as const,
  } as unknown as Parameters<typeof GeoJsonLayer>[0]["featureCollection"];
}

const LINE_STYLES: Record<string, { lineColor: string; lineOpacity: number; lineWidth: number }> = {
  motorway: { lineColor: "#c2410c", lineOpacity: 0.9, lineWidth: 4 },
  primary: { lineColor: "#ea580c", lineOpacity: 0.85, lineWidth: 2.5 },
  river: { lineColor: "#1d4ed8", lineOpacity: 0.9, lineWidth: 2 },
  secondary: { lineColor: "#a16207", lineOpacity: 0.75, lineWidth: 1.5 },
  boundary: { lineColor: "#7e22ce", lineOpacity: 0.7, lineWidth: 1.2 },
};

const PLACES = {
  alexandria: [29.92, 31.2],
  antioch: [36.16, 36.2],
  carthage: [10.32, 36.85],
  constantinople: [28.97, 41.01],
  milan: [9.19, 45.46],
  ravenna: [12.2, 44.42],
  rome: [12.4964, 41.9028],
} satisfies Record<string, LngLat>;

/** Source-transfer flows of a late-antique corpus (historical-source-atlas#64 shape). */
const atlasFlows = (
  [
    ["alexandria-rome", "alexandria", "rome", 14],
    ["constantinople-ravenna", "constantinople", "ravenna", 9],
    ["antioch-constantinople", "antioch", "constantinople", 6],
    ["carthage-rome", "carthage", "rome", 4],
    ["rome-milan", "rome", "milan", 3],
  ] as const
).map(([id, from, to, weight]) => ({
  from: PLACES[from] as LngLat,
  id,
  metrics: { weight },
  to: PLACES[to] as LngLat,
}));

/** Manuscript witnesses around each place; they cluster at the Atlas zoom. */
const atlasEntities: MapPoint[] = Object.entries(PLACES).flatMap(([place, [longitude, latitude]], hub) =>
  Array.from({ length: 4 + hub * 2 }, (_, index) => {
    const angle = index * 2.399963229728653;
    const distance = 0.08 + (index % 5) * 0.06;
    return {
      id: `${place}-witness-${index}`,
      label: `${place} witness ${index + 1}`,
      latitude: latitude + Math.sin(angle) * distance,
      longitude: longitude + Math.cos(angle) * distance * 1.3,
    };
  }),
);

/** Coarse late-antique dioceses as the Atlas country overlay. */
const romanProvinces = {
  features: [
    province("italia", "#c2410c", [[7.6, 44.1], [9.5, 44.2], [12.3, 44.9], [13.7, 45.7], [12.4, 44.2], [14.2, 42.4], [16.0, 41.4], [18.5, 40.1], [16.6, 38.4], [15.6, 38.0], [15.7, 40.0], [12.6, 41.4], [10.5, 42.9], [8.7, 44.4]]),
    province("macedonia", "#7c3aed", [[19.4, 41.9], [22.5, 42.3], [24.1, 41.0], [22.9, 40.4], [23.3, 39.2], [22.0, 37.0], [21.1, 37.8], [20.2, 39.6]]),
    province("thracia", "#0369a1", [[24.1, 41.0], [26.3, 42.0], [28.0, 42.0], [29.1, 41.2], [26.2, 40.4]]),
    province("africa", "#a16207", [[8.6, 36.9], [10.2, 37.3], [11.1, 36.9], [10.4, 35.6], [11.1, 34.2], [8.2, 34.0]]),
  ],
  type: "FeatureCollection" as const,
};

createRoot(document.getElementById("root")!).render(<App />);

type AlpineLineProperties = Record<string, string | number | undefined>;

/** `line-dash-caps-joins` (#322): MapLibre `line-cap`, `line-join` and `line-dasharray`. */
const DASHED_LINE_CLASSES: Array<{
  filter: (properties: AlpineLineProperties) => boolean;
  layer: string;
  style: GeoJsonLayerStyle;
}> = [
  {
    filter: (properties) => properties.kind === "motorway",
    layer: "motorway",
    style: { lineCap: "square", lineColor: "#c2410c", lineJoin: "bevel", lineOpacity: 1, lineWidth: 6 },
  },
  {
    filter: (properties) => properties.kind === "primary",
    layer: "primary",
    style: { lineCap: "butt", lineColor: "#ea580c", lineDasharray: [3, 1.5], lineJoin: "miter", lineOpacity: 1, lineWidth: 3 },
  },
  {
    filter: (properties) => properties.kind === "river",
    layer: "river",
    style: { lineCap: "round", lineColor: "#1d4ed8", lineDasharray: [0.5, 2], lineJoin: "round", lineOpacity: 1, lineWidth: 4 },
  },
  {
    filter: (properties) => properties.admin_level === 2,
    layer: "boundary",
    style: { lineCap: "butt", lineColor: "#7e22ce", lineDasharray: [4, 2, 1, 2], lineJoin: "miter", lineOpacity: 1, lineWidth: 2.5 },
  },
];

const dashedLineCache = new Map<string, ReturnType<typeof buildAlpineLines>>();

/** One stable collection per class, so layers do not rebuild their data per render. */
function dashedLines(layer: string, filter: (properties: AlpineLineProperties) => boolean) {
  let collection = dashedLineCache.get(layer);
  if (!collection) {
    const all = alpineLines() as unknown as { features: Array<{ properties: AlpineLineProperties }> };
    collection = {
      features: all.features.filter((feature) => filter(feature.properties)),
      type: "FeatureCollection",
    } as unknown as ReturnType<typeof buildAlpineLines>;
    dashedLineCache.set(layer, collection);
  }
  return collection;
}
