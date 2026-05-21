"use client";

import type React from "react";

export type MapFeatureInteractionState = {
  hovered: boolean;
  selected: boolean;
};

export type MapContextMenuContext = {
  close: () => void;
  coordinates: [longitude: number, latitude: number];
  position: { x: number; y: number };
};

export type MapFeatureContextMenuContext<TFeature> = MapContextMenuContext & {
  feature: TFeature;
};

export type MapFeatureInteractionProps<TFeature> = {
  getFeatureId?: (feature: TFeature) => string;
  onFeatureContextMenu?: (feature: TFeature) => void;
  onFeatureHover?: (feature: TFeature | null) => void;
  renderFeatureTooltip?: (feature: TFeature) => React.ReactNode;
  renderFeaturePopup?: (feature: TFeature) => React.ReactNode;
  renderFeatureContextMenu?: (
    feature: TFeature,
    context: MapFeatureContextMenuContext<TFeature>,
  ) => React.ReactNode;
  selectedFeatureId?: string | null;
};
