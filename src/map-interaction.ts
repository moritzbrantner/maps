"use client";

import type React from "react";

export type MapFeatureInteractionState = {
  hovered: boolean;
  selected: boolean;
};

export type MapFeatureInteractionProps<TFeature> = {
  getFeatureId?: (feature: TFeature) => string;
  onFeatureHover?: (feature: TFeature | null) => void;
  renderFeatureTooltip?: (feature: TFeature) => React.ReactNode;
  renderFeaturePopup?: (feature: TFeature) => React.ReactNode;
  selectedFeatureId?: string | null;
};
