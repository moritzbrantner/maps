"use client";

import { createContext, type ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import type {
  MapDisplayMode,
  MapViewState,
  MapViewStateChangeReason,
} from "./map-display";
import type {
  FlatLayerFactory,
  FlatLayerGroup,
  FlatMapAdapter,
} from "./maplibre-compat";
import type {
  MapFeatureContextMenuContext,
  MapFeatureInteractionChange,
} from "./map-interaction";

export type MapLibreLayerRender = (context: {
  flat: FlatLayerFactory;
  interactionMode: MapInteractionMode;
  isMeasuring: boolean;
  layer: FlatLayerGroup;
  map: FlatMapAdapter;
  maplibre: typeof import("maplibre-gl");
  maplibreMap: MapLibreMap;
}) => void;

export type MapLibreLayerRegistrationOptions = {
  preserveOnRender?: boolean;
  renderOnViewStateChange?: boolean;
};

export type MapInteractionMode = "none" | "measurement" | "editing";

export type MapSurfaceContextValue = {
  closeFeaturePopup: () => void;
  display: MapDisplayMode;
  handleBackgroundClick: () => void;
  handleFeatureClick: <TFeature>(
    feature: TFeature,
    position: { x: number; y: number },
    options?: {
      getFeatureId?: (feature: TFeature) => string;
      onSelectedFeatureIdChange?: (
        featureId: string | null,
        context: MapFeatureInteractionChange<TFeature>,
      ) => void;
      onFeatureSelect?: (feature: TFeature | null) => void;
      renderFeaturePopup?: (feature: TFeature) => ReactNode;
      suppress?: boolean;
    },
  ) => void;
  handleFeatureContextMenu: <TFeature>(
    feature: TFeature,
    position: { x: number; y: number },
    options?: {
      coordinates?: [longitude: number, latitude: number];
      getFeatureId?: (feature: TFeature) => string;
      onFeatureContextMenu?: (feature: TFeature) => void;
      onSelectedFeatureIdChange?: (
        featureId: string | null,
        context: MapFeatureInteractionChange<TFeature>,
      ) => void;
      onFeatureSelect?: (feature: TFeature | null) => void;
      renderFeatureContextMenu?: (
        feature: TFeature,
        context: MapFeatureContextMenuContext<TFeature>,
      ) => ReactNode;
      renderFeaturePopup?: (feature: TFeature) => ReactNode;
      suppress?: boolean;
    },
  ) => void;
  handleFeatureHover: <TFeature>(
    feature: TFeature | null,
    position: { x: number; y: number } | null,
    options?: {
      getFeatureId?: (feature: TFeature) => string;
      onHoveredFeatureIdChange?: (
        featureId: string | null,
        context: MapFeatureInteractionChange<TFeature>,
      ) => void;
      onFeatureHover?: (feature: TFeature | null) => void;
      renderFeatureTooltip?: (feature: TFeature) => ReactNode;
    },
  ) => void;
  isFeatureHovered: <TFeature>(
    feature: TFeature,
    hoveredFeatureId?: string | null,
    getFeatureId?: (feature: TFeature) => string,
  ) => boolean;
  isFeatureSelected: <TFeature>(
    feature: TFeature,
    selectedFeatureId?: string | null,
    getFeatureId?: (feature: TFeature) => string,
  ) => boolean;
  isMeasuring: boolean;
  interactionMode: MapInteractionMode;
  flatMap: FlatMapAdapter | null;
  maplibre: typeof import("maplibre-gl") | null;
  maplibreMap: MapLibreMap | null;
  registerMapLibreLayer: (
    id: string,
    render: MapLibreLayerRender,
    options?: MapLibreLayerRegistrationOptions,
  ) => () => void;
  registerInteractionMode: (id: string, mode: Exclude<MapInteractionMode, "none">) => () => void;
  requestRender: () => void;
  setMeasurementActive: (active: boolean) => void;
  setViewState: (next: MapViewState, reason: MapViewStateChangeReason) => void;
  viewState: MapViewState;
};

export const MapSurfaceContext = createContext<MapSurfaceContextValue | null>(null);
