import type {
  FlatLayer,
  FlatLayerFactory,
  FlatLayerGroup,
  FlatLayerOptions,
  FlatMapAdapter,
} from "./maplibre-compat";

export type Layer = FlatLayer;
export type LayerGroup = FlatLayerGroup;
export type Map = FlatMapAdapter;
export type PathOptions = FlatLayerOptions;

export const circleMarker: FlatLayerFactory["circleMarker"] = unsupported;
export const divIcon: FlatLayerFactory["divIcon"] = unsupported;
export const imageOverlay: FlatLayerFactory["imageOverlay"] = unsupported;
export const layerGroup: FlatLayerFactory["layerGroup"] = unsupported;
export const marker: FlatLayerFactory["marker"] = unsupported;
export const polygon: FlatLayerFactory["polygon"] = unsupported;
export const polyline: FlatLayerFactory["polyline"] = unsupported;

function unsupported(): never {
  throw new Error("The internal flat shim is type-only; use MapView's MapLibre flat adapter.");
}
