// Reference of `maps-atlas-tileset-v1` (#270 Fast): MapLibre GL reads the same
// content-pinned Atlas PMTiles archives through the `pmtiles` protocol and draws them
// with the Maps Shortbread class palette. Reference-specific code stays here so it
// cannot become Maps engine truth.
import {
  addProtocol,
  Map as MapLibreMap,
  setWorkerUrl,
  type LayerSpecification,
} from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";

import { atlasReleaseIndex, type AtlasRegion } from "../../demo/atlas-source";
import {
  ATLAS_JOURNEY_INITIAL,
  type AtlasJourneyImplementation,
} from "../../e2e/fixtures/atlas-tileset-journey";
import { getShortbreadClassStyle } from "../../src/maps-tileset-style";

const regions: AtlasRegion[] = ["liechtenstein", "liechtenstein-north"];

function archiveUrl(region: AtlasRegion) {
  const tileset = atlasReleaseIndex.tilesets[regions.indexOf(region)]!;
  return new URL(
    `${import.meta.env.BASE_URL}tilesets/${tileset.archiveRef.path}`,
    location.origin,
  ).href;
}

/** The fixed Maps Shortbread style as MapLibre layers over one region's source. */
function layers(region: AtlasRegion): LayerSpecification[] {
  const fill = (styleClass: Parameters<typeof getShortbreadClassStyle>[0]) =>
    getShortbreadClassStyle(styleClass);
  const byKind = (
    property: "color" | "opacity",
    kind: string,
    special: Parameters<typeof getShortbreadClassStyle>[0],
    base: Parameters<typeof getShortbreadClassStyle>[0],
  ) => ["match", ["get", "kind"], kind, fill(special)[property], fill(base)[property]];
  const polygon = (id: string, sourceLayer: string, paint: Record<string, unknown>) => ({
    id: `${region}:${id}`,
    paint,
    source: region,
    "source-layer": sourceLayer,
    type: "fill",
  });
  const line = (
    id: string,
    sourceLayer: string,
    styleClass: Parameters<typeof getShortbreadClassStyle>[0],
  ) => {
    const style = getShortbreadClassStyle(styleClass) as {
      color: string;
      opacity: number;
      width: number;
    };
    return {
      id: `${region}:${id}`,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": style.color,
        "line-opacity": style.opacity,
        "line-width": style.width,
      },
      source: region,
      "source-layer": sourceLayer,
      type: "line",
    };
  };
  return [
    polygon("land", "land", {
      "fill-color": byKind("color", "forest", "land-forest", "land"),
      "fill-opacity": byKind("opacity", "forest", "land-forest", "land"),
    }),
    polygon("water", "water_polygons", {
      "fill-color": byKind("color", "glacier", "water-glacier", "water"),
      "fill-opacity": byKind("opacity", "glacier", "water-glacier", "water"),
    }),
    line("water-outline", "water_polygons", "water-line"),
    line("water-lines", "water_lines", "water-line"),
    polygon("buildings", "buildings", {
      "fill-color": fill("building").color,
      "fill-opacity": fill("building").opacity,
    }),
    line("building-outline", "buildings", "building-outline"),
    line("streets", "streets", "street"),
    line("boundaries", "boundaries", "boundary"),
  ] as LayerSpecification[];
}

let protocolRegistered = false;

export async function mount(container: HTMLElement): Promise<AtlasJourneyImplementation> {
  if (!protocolRegistered) {
    setWorkerUrl(maplibreWorkerUrl);
    addProtocol("pmtiles", new Protocol().tile);
    protocolRegistered = true;
  }
  const source = (region: AtlasRegion) => ({
    type: "vector" as const,
    url: `pmtiles://${archiveUrl(region)}`,
  });
  let active: AtlasRegion = "liechtenstein";
  const added = new Set<AtlasRegion>([active]);
  let idle = false;
  const map = new MapLibreMap({
    attributionControl: false,
    center: [...ATLAS_JOURNEY_INITIAL.center],
    container,
    fadeDuration: 0,
    interactive: false,
    style: {
      layers: [
        { id: "background", paint: { "background-color": "#f9f4ee" }, type: "background" },
        ...layers(active),
      ],
      sources: { [active]: source(active) },
      version: 8,
    },
    zoom: ATLAS_JOURNEY_INITIAL.zoom,
  });
  map.on("error", (event) => {
    throw event.error;
  });
  // `idle` follows a rendered frame with every visible tile loaded: the reference's
  // equivalent of the candidate's ready, presented source.
  map.on("idle", () => {
    idle = true;
  });
  return {
    name: `maplibre-gl@${map.version}`,
    apply(step) {
      idle = false;
      if (step.kind === "camera") {
        map.jumpTo({ center: [...step.center], zoom: step.zoom });
        return;
      }
      // Both regions stay retained once visited, like the candidate's inactive sources.
      if (!added.has(step.region)) {
        map.addSource(step.region, source(step.region));
        for (const layer of layers(step.region)) map.addLayer(layer);
        added.add(step.region);
      }
      for (const region of added) {
        for (const layer of layers(region)) {
          map.setLayoutProperty(
            layer.id,
            "visibility",
            region === step.region ? "visible" : "none",
          );
        }
      }
      active = step.region;
    },
    settled: () => idle && map.loaded(),
    observe: () => ({
      backend: "webgl",
      sourceId: atlasReleaseIndex.tilesets[regions.indexOf(active)]!.sourceId,
      dataRevision: atlasReleaseIndex.tilesets[regions.indexOf(active)]!.dataRevision,
    }),
  };
}
