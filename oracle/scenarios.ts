/**
 * Named MapLibre-oracle parity scenarios (#306). Data-only, so both the browser fixture
 * (`oracle/fixture.tsx`, which renders the layers) and the Node runner (`oracle/run.ts`,
 * which drives and judges them) import it.
 *
 * Every scenario renders through the public `MapView flatRuntime="maplibre" | "maps"` seam
 * with the same style, tiles, camera and data. The runner then checks three gates:
 * a FLIP image diff, identical picked feature ids for the scripted pointer steps (and the
 * same bounds after pan/zoom), and frame time against MapLibre.
 */

export type Gate = "image" | "interaction" | "time";

export type LngLat = [longitude: number, latitude: number];

/** One scripted pointer step. Points are geographic and projected with the initial camera. */
export type Step =
  | { kind: "hover"; at: LngLat; label: string }
  | { kind: "click"; at: LngLat; label: string }
  /** Drag the map by a screen offset, starting at the map center. */
  | { kind: "pan"; by: [dx: number, dy: number]; label: string }
  /** Wheel at a screen offset from the center; negative deltaY zooms in. */
  | { kind: "wheel"; at: [dx: number, dy: number]; deltaY: number; ticks: number; label: string }
  /** Right-button drag from the center: horizontal rotates the bearing, vertical the pitch. */
  | { kind: "rotate"; by: [dx: number, dy: number]; label: string };

/**
 * A failing gate that is known and owned by a follow-up issue. The runner reports it as a
 * known gap instead of failing CI. If the gate starts passing, CI fails until the entry is
 * removed, so this list can only shrink. The gate thresholds themselves never move.
 */
export type KnownGap = { gate: Gate; issue: number; reason: string };

/**
 * A capability MapLibre renders and Maps does not implement at all. The runner renders only
 * the MapLibre reference, so the report shows the target, and reports the scenario as
 * unsupported with its issue. It claims no Maps gate.
 */
export type Unsupported = { issue: number; reason: string };

/**
 * What draws under the application layers:
 * - `geographic` / `zoom-tinted`: generated raster tiles (`oracle/tiles.ts`);
 * - `vector`: Shortbread MVT built from `oracle/data/alpine-foreland.json`
 *   (`oracle/vector-tiles.ts`), styled by the Maps class palette: `tileset` on Maps and the
 *   equivalent data-driven MapLibre style on MapLibre;
 * - `style`: a MapLibre-only style built by the fixture (unsupported scenarios).
 */
export type Basemap = "geographic" | "zoom-tinted" | "vector" | "style";

export type Camera = { center: LngLat; zoom: number; bearing?: number; pitch?: number };

export type Scenario = {
  name: string;
  /** What the scenario proves, in one line. */
  capability: string;
  /** The real consumer journey or merged change it mirrors. */
  origin: string;
  camera: Camera;
  size: { width: number; height: number };
  basemap: Basemap;
  steps: Step[];
  knownGaps: KnownGap[];
  unsupported?: Unsupported;
};

/**
 * North-up, unpitched cameras project steps with Web Mercator math and compare bounds.
 * Rotated or pitched ones pick at MapLibre's projected pixel and compare view states.
 */
export function isNorthUp(camera: Camera) {
  return !camera.bearing && !camera.pitch;
}

/** FLIP limits, as in render-engine: mean and 99th-percentile per-pixel error. */
export const FLIP_MEAN_MAX = 0.005;
export const FLIP_P99_MAX = 0.05;
/** The first-party runtime may take at most this many times MapLibre's frame time. */
export const FRAME_TIME_MARGIN = 1.1;

/** One timed round in the fixture: untimed warm-up, then back-to-back frame batches. */
export type FrameTiming = {
  batchFrames: number;
  batches: number;
  /** Frames per camera orbit (the path both runtimes follow). */
  orbitFrames: number;
  warmupFrames: number;
  warmupMs: number;
};
/** Bounds after pan/zoom agree when every edge is within this many screen pixels. */
export const BOUNDS_TOLERANCE_PX = 1;

/** Tiles are served by the runner (`oracle/tiles.ts`) through request interception. */
export const TILE_ORIGIN = "https://oracle-tiles.invalid";

export const DEAD_SEA_SCROLLS: LngLat = [35.458, 31.741];
export const KEVELAER_CHAPEL: LngLat = [6.2474, 51.5823];
/** On Natural Earth lines in `oracle/data/alpine-foreland.json`, ≥ 12 px from other lines at z8. */
export const MOTORWAY_VERTEX: LngLat = [9.0467, 47.6013];
export const RHINE_POINT: LngLat = [8.51405, 47.58135];

const MAP_SIZE = { height: 480, width: 720 };

/**
 * Scenes that leave Maps at Chromium's WebGPU canvas floor (#343): a clear-only WebGPU page
 * takes about 1.0 ms per uncapped frame where a WebGL2 one takes 0.12 ms, so these stay
 * above MapLibre's WebGL frame time while Maps waits in `getCurrentTexture`.
 */
const FRAME_TIME_GAP: KnownGap = {
  gate: "time",
  issue: 343,
  reason: "WebGPU canvas presentation floor (about 1.0 ms per frame) above MapLibre's WebGL frame",
};

export const scenarios: Scenario[] = [
  {
    camera: { center: DEAD_SEA_SCROLLS, zoom: 5 },
    capability: "single source point: hover, select, clear, pan, wheel zoom",
    knownGaps: [FRAME_TIME_GAP],
    name: "source-location",
    origin: "historical-source-atlas#63 source-location map (#232)",
    size: MAP_SIZE,
    steps: [
      { at: DEAD_SEA_SCROLLS, kind: "hover", label: "hover the source point" },
      { at: DEAD_SEA_SCROLLS, kind: "click", label: "select the source point" },
      { at: [37.2, 30.4], kind: "click", label: "click empty map (clears selection)" },
      { by: [-140, 90], kind: "pan", label: "drag pan" },
      { at: [60, -40], deltaY: -120, kind: "wheel", label: "wheel zoom in", ticks: 3 },
    ],
    basemap: "geographic",
  },
  {
    camera: { center: [10.4, 51.2], zoom: 5.55 },
    capability: "territory polygons, clustered sites and seat points: select and hover",
    knownGaps: [],
    name: "church-site-discovery",
    origin: "church-atlas#8 site discovery (#232)",
    size: MAP_SIZE,
    steps: [
      { at: KEVELAER_CHAPEL, kind: "hover", label: "hover the Kevelaer chapel" },
      { at: KEVELAER_CHAPEL, kind: "click", label: "select the Kevelaer chapel" },
      { at: [12.4, 49.2], kind: "click", label: "select a diocese territory" },
      { at: [7.6257, 51.9626], kind: "hover", label: "hover the Münster seat" },
      { by: [120, -60], kind: "pan", label: "drag pan" },
      { at: [-80, 30], deltaY: 120, kind: "wheel", label: "wheel zoom out", ticks: 2 },
    ],
    basemap: "geographic",
  },
  {
    camera: { center: [10.3, 50.4], zoom: 4.6 },
    capability: "raster tile zoom level and parent/child crossfade end state (#303)",
    knownGaps: [FRAME_TIME_GAP],
    name: "zoom-crossfade",
    origin: "maps#303 zoom-gap crossfade",
    size: MAP_SIZE,
    steps: [
      {
        at: [0, 0],
        deltaY: -120,
        kind: "wheel",
        label: "wheel zoom in across a tile level",
        ticks: 4,
      },
      { by: [-200, 0], kind: "pan", label: "drag pan" },
    ],
    basemap: "zoom-tinted",
  },
  {
    camera: { center: [11.2, 50.6], zoom: 5.2 },
    capability: "point labels placed on their points",
    knownGaps: [FRAME_TIME_GAP],
    name: "labels",
    origin: "PointLayer getPointLabel",
    size: MAP_SIZE,
    steps: [
      { at: [13.405, 52.52], kind: "hover", label: "hover Berlin" },
      { at: [11.582, 48.1351], kind: "click", label: "select Munich" },
    ],
    basemap: "geographic",
  },
  {
    camera: { center: [10.3, 50.4], zoom: 4.4 },
    capability: "density clusters: placement, counts, cluster and point picking",
    knownGaps: [FRAME_TIME_GAP],
    name: "clusters",
    origin: "demo/RendererComparison cluster journey",
    size: MAP_SIZE,
    steps: [
      { at: [13.405, 52.52], kind: "hover", label: "hover the Berlin cluster" },
      { at: [9.1829, 48.7758], kind: "click", label: "select the Stuttgart cluster" },
      { at: [-70, 20], deltaY: -120, kind: "wheel", label: "wheel zoom in", ticks: 3 },
    ],
    basemap: "geographic",
  },
  // ---- #320: vector tiles, lines, rotation, Atlas flows, and what Maps lacks ----
  {
    basemap: "vector",
    camera: { center: [9.0, 47.3], zoom: 7.6 },
    capability: "Shortbread MVT fills and lines, class palette by feature kind (lake/glacier)",
    knownGaps: [FRAME_TIME_GAP],
    name: "vector-tiles",
    origin: "Maps Tileset (#268); osmshrink#10 OSM preview (#232)",
    size: MAP_SIZE,
    steps: [
      { by: [160, -80], kind: "pan", label: "drag pan" },
      { at: [-60, 40], deltaY: -120, kind: "wheel", label: "wheel zoom in", ticks: 3 },
    ],
  },
  {
    basemap: "geographic",
    camera: { center: [9.0, 47.4], zoom: 8 },
    capability: "GeoJSON lines: width, colour and opacity per feature, round caps and joins",
    knownGaps: [FRAME_TIME_GAP],
    name: "line-styles",
    origin: "GeoJsonLayer getFeatureStyle lines; tlm-deutschland#235 venue routes (#232)",
    size: MAP_SIZE,
    steps: [
      { at: MOTORWAY_VERTEX, kind: "hover", label: "hover a motorway" },
      { at: RHINE_POINT, kind: "click", label: "select the Rhine" },
      { by: [-120, 60], kind: "pan", label: "drag pan" },
    ],
  },
  {
    basemap: "geographic",
    camera: { bearing: 35, center: [10.4, 51.2], zoom: 5.55 },
    capability: "rotated camera: raster, polygons and points; pick and rotate/pan/zoom",
    knownGaps: [],
    name: "bearing",
    origin: "church-atlas#8 site discovery with a rotated map (#232)",
    size: MAP_SIZE,
    steps: [
      { at: KEVELAER_CHAPEL, kind: "hover", label: "hover the Kevelaer chapel" },
      { at: [12.4, 49.2], kind: "click", label: "select a diocese territory" },
      { by: [80, 0], kind: "rotate", label: "right-drag rotate" },
      { by: [120, -60], kind: "pan", label: "drag pan" },
      { at: [-80, 30], deltaY: 120, kind: "wheel", label: "wheel zoom out", ticks: 2 },
    ],
  },
  {
    basemap: "geographic",
    camera: { bearing: -20, center: [10.4, 51.2], pitch: 50, zoom: 5.55 },
    capability: "pitched camera: minified far tiles, polygons and points; pick and pan",
    knownGaps: [],
    name: "pitch",
    origin:
      "church-atlas#8 site discovery with a pitched map (#232); camera #328; mipmaps #314; fill outlines #331",
    size: MAP_SIZE,
    steps: [
      { at: [7.6257, 51.9626], kind: "hover", label: "hover the Münster seat" },
      { at: [12.4, 49.2], kind: "click", label: "select a diocese territory" },
      { by: [-100, 40], kind: "pan", label: "drag pan" },
    ],
  },
  {
    basemap: "geographic",
    camera: { center: [19, 39.5], zoom: 3.9 },
    capability: "weighted flows with direction and endpoints, clustered entities, country overlay",
    knownGaps: [],
    name: "atlas-flows",
    origin: "historical-source-atlas#64 full Atlas map (#232)",
    size: MAP_SIZE,
    steps: [
      // Points on the straight (Mercator) flow segments.
      { at: [20.337, 37.2712], kind: "hover", label: "hover the Alexandria-Rome flow" },
      { at: [22.262, 42.3965], kind: "click", label: "select the Constantinople-Ravenna flow" },
      { at: [12.4964, 41.9028], kind: "hover", label: "hover the Rome cluster" },
      { at: [-60, 30], deltaY: -120, kind: "wheel", label: "wheel zoom in", ticks: 2 },
    ],
  },
  {
    basemap: "vector",
    camera: { center: [8.6, 47.3], zoom: 7.8 },
    capability: "symbol layer: SDF glyph labels, data-driven size, halo, collision",
    knownGaps: [FRAME_TIME_GAP],
    name: "symbols",
    origin: "Milestone E cartography (#80); place labels on any vector basemap; Tileset style layers #321",
    size: MAP_SIZE,
    steps: [],
  },
  {
    basemap: "vector",
    camera: { center: [9.0, 47.3], zoom: 7.6 },
    capability: "line layer: line-dasharray, caps, joins over Tileset vector tiles",
    knownGaps: [FRAME_TIME_GAP],
    name: "tileset-lines",
    origin: "Milestone D vector style (#79): boundary and track styling; Tileset style layers (#322)",
    size: MAP_SIZE,
    steps: [],
  },
  {
    basemap: "geographic",
    camera: { center: [9.0, 47.4], zoom: 8 },
    capability: "GeoJSON lines: line-dasharray, butt/round/square caps, miter/bevel/round joins",
    knownGaps: [FRAME_TIME_GAP],
    name: "line-dash-caps-joins",
    origin: "Milestone D vector style (#79): boundary and track styling (#322)",
    size: MAP_SIZE,
    steps: [
      { at: MOTORWAY_VERTEX, kind: "hover", label: "hover a square-capped motorway" },
      { at: RHINE_POINT, kind: "click", label: "select the dashed Rhine" },
      { by: [-120, 60], kind: "pan", label: "drag pan" },
    ],
  },
  {
    basemap: "vector",
    camera: { center: [8.4, 46.75], zoom: 8.4 },
    capability: "fill-pattern from a sprite: tileset fill layer and GeoJSON fills, with outlines",
    knownGaps: [FRAME_TIME_GAP],
    name: "fill-pattern",
    origin: "Milestone D vector style (#79): glacier/wetland hatching; sprites and patterns (#323)",
    size: MAP_SIZE,
    steps: [
      { at: [8.85, 46.94], kind: "hover", label: "hover the hatched hexagon" },
      { at: [7.87, 46.76], kind: "click", label: "select the hatched frame" },
      { at: [8.02, 46.76], kind: "click", label: "click the frame's hole (clears selection)" },
      { by: [-120, 60], kind: "pan", label: "drag pan" },
      { at: [40, -30], deltaY: -120, kind: "wheel", label: "wheel zoom in across zoom 9", ticks: 3 },
    ],
  },
  {
    basemap: "style",
    camera: { bearing: 20, center: [9.0, 47.2], zoom: 8 },
    capability: "raster-dem hillshade over a raster basemap, light anchored to the rotated viewport",
    knownGaps: [FRAME_TIME_GAP],
    name: "hillshade",
    origin: "derived hillshade tilesets (#282); raster-dem and hillshade (#324)",
    size: MAP_SIZE,
    steps: [],
  },
  {
    basemap: "style",
    camera: { bearing: 20, center: [9.0, 47.2], pitch: 55, zoom: 8 },
    capability: "raster-dem hillshade with 3D terrain under a pitched camera",
    knownGaps: [],
    name: "hillshade-terrain",
    origin: "Milestone F terrain (#81); derived hillshade tilesets (#282); raster-dem, hillshade and terrain (#324)",
    size: MAP_SIZE,
    steps: [],
  },
];

export function findScenario(name: string): Scenario {
  const scenario = scenarios.find((entry) => entry.name === name);
  if (!scenario) throw new Error(`unknown oracle scenario ${name}`);
  return scenario;
}

/** Web Mercator world size in CSS pixels at a zoom (512 px tiles, as MapLibre and Maps use). */
export function worldSize(zoom: number) {
  return 512 * 2 ** zoom;
}

export function project([longitude, latitude]: LngLat, zoom: number): [number, number] {
  const size = worldSize(zoom);
  const sin = Math.sin((latitude * Math.PI) / 180);
  return [
    ((longitude + 180) / 360) * size,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  ];
}

export function unproject([x, y]: [number, number], zoom: number): LngLat {
  const size = worldSize(zoom);
  const n = Math.PI - (2 * Math.PI * y) / size;
  return [(x / size) * 360 - 180, (180 / Math.PI) * Math.atan(Math.sinh(n))];
}

/** Screen point (CSS px inside the map) of a geographic point under a camera. */
export function toScreen(at: LngLat, camera: Scenario["camera"], size: Scenario["size"]) {
  const [cx, cy] = project(camera.center, camera.zoom);
  const [x, y] = project(at, camera.zoom);
  return { x: size.width / 2 + x - cx, y: size.height / 2 + y - cy };
}

/** [west, south, east, north] visible under a north-up camera. */
export function boundsOf(camera: Scenario["camera"], size: Scenario["size"]) {
  const [cx, cy] = project(camera.center, camera.zoom);
  const [west, north] = unproject([cx - size.width / 2, cy - size.height / 2], camera.zoom);
  const [east, south] = unproject([cx + size.width / 2, cy + size.height / 2], camera.zoom);
  return [west, south, east, north] as [number, number, number, number];
}
