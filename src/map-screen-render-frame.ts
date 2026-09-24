import type { MapVectorRenderPrimitive } from "./map-render-frame";

export type MapScreenPoint = { x: number; y: number };
export type MapScreenProject = ((
  coordinate: [longitude: number, latitude: number],
) => MapScreenPoint | null) & {
  /** Projects interleaved longitude/latitude pairs in one Maps runtime call. */
  projectPacked?: (coordinates: Float64Array) => Float64Array | null;
};

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
export type MapScreenRenderFrame<TFeature = unknown> = {
  height: number;
  primitives: Array<MapScreenRenderPrimitive<TFeature>>;
  width: number;
};
