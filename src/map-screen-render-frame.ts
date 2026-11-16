import type { MapVectorRenderPrimitive } from "./map-render-frame";

export type MapScreenPoint = { x: number; y: number };
export type MapScreenProject = ((
  coordinate: [longitude: number, latitude: number],
) => MapScreenPoint | null) & {
  /** Projects interleaved longitude/latitude pairs in one Maps runtime call. */
  projectPacked?: (coordinates: Float64Array) => Float64Array | null;
};

/**
 * The local linear map from screen offsets to map-plane offsets at one screen point, row-major
 * `[a, b, c, d]`: a screen offset `(dx, dy)` spans `(a·dx + b·dy, c·dx + d·dy)` CSS pixels on
 * the map plane at the camera zoom. Rust derives it from the pitched camera (#386); picking
 * measures line widths with it as MapLibre does in tile space, so they shrink with distance.
 */
export type MapScreenMapPlaneScale = readonly [a: number, b: number, c: number, d: number];

export type MapScreenInteractionState = {
  hoveredPrimitiveIds?: ReadonlySet<string>;
  selectedPrimitiveIds?: ReadonlySet<string>;
};

type MapScreenPrimitiveBase<TFeature> = {
  renderPrimitive: MapVectorRenderPrimitive<TFeature>;
};

export type MapScreenCircle<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  kind: "circle";
  x: number;
  y: number;
};

export type MapScreenDirectionMarker<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  angle: number;
  kind: "direction-marker";
  x: number;
  y: number;
};

export type MapScreenLine<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  kind: "line";
  points: MapScreenPoint[];
};

export type MapScreenPolygon<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  kind: "polygon";
  rings: MapScreenPoint[][];
};

export type MapScreenRenderPrimitive<TFeature = unknown> =
  | MapScreenCircle<TFeature>
  | MapScreenDirectionMarker<TFeature>
  | MapScreenLine<TFeature>
  | MapScreenPolygon<TFeature>;

/**
 * Maps-owned screen-space frame shared by concrete pixel backends and hit testing.
 * Geographic projection remains authoritative in Maps; renderers only consume finite
 * projected positions plus the original semantic primitive identity.
 */
/** Prepared pixels and projected triangles; each vertex is CSS x/y followed by texture u/v. */
export type MapScreenRaster = {
  before: number;
  uploaded?: (bytes: number) => void;
  released?: () => void;
  image: HTMLImageElement;
  opacity: number;
  vertices: number[];
};

export type MapScreenRenderFrame<TFeature = unknown> = {
  rasters?: MapScreenRaster[];
  height: number;
  primitives: Array<MapScreenRenderPrimitive<TFeature>>;
  width: number;
};
