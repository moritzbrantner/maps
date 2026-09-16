export const MAP_LAYER_COMPONENT_KIND = Symbol("@moritzbrantner/maps/layer-component-kind");

export type MapLayerComponent = {
  [MAP_LAYER_COMPONENT_KIND]?: "heat";
};
