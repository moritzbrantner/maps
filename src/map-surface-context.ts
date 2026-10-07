"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
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

/**
 * Surface capabilities and interaction commands. The value changes only when a
 * capability changes (readiness, display, interaction mode), never for camera or
 * hover updates: those have their own subscriptions below (#119).
 */
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
  /** Reads the current hover state when called; subscribe with `useMapHoveredFeature`. */
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
};

export const MapSurfaceContext = createContext<MapSurfaceContextValue | null>(null);

/** Camera subscription: only consumers that render from the Map View state read it. */
export const MapViewStateContext = createContext<MapViewState | null>(null);

export function useMapSurfaceViewState() {
  return useContext(MapViewStateContext);
}

export type MapHoveredFeature = { feature: unknown; id: string | null };

/**
 * The surface's hovered feature. Hover is written from pointer handlers, so it is an
 * external store: commands read the latest value, and only hover-rendering consumers
 * subscribe to it.
 */
export type MapHoverStore = {
  get(): MapHoveredFeature | null;
  set(next: MapHoveredFeature | null): void;
  subscribe(listener: () => void): () => void;
};

export function createMapHoverStore(): MapHoverStore {
  let current: MapHoveredFeature | null = null;
  const listeners = new Set<() => void>();

  return {
    get: () => current,
    set(next) {
      // Pointer moves within one feature are not hover changes.
      if (next === current || (next?.id === current?.id && next?.feature === current?.feature)) {
        return;
      }
      current = next;
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const MapHoverContext = createContext<MapHoverStore | null>(null);

const noHoverSubscription = () => () => {};
const noHover = () => null;

/** Subscribes a hover-rendering consumer; returns the hovered feature, or null. */
export function useMapHoveredFeature() {
  const store = useContext(MapHoverContext);
  return useSyncExternalStore(
    store?.subscribe ?? noHoverSubscription,
    store?.get ?? noHover,
    store?.get ?? noHover,
  );
}

export function isMapFeatureHovered(
  hovered: MapHoveredFeature | null,
  featureId: string,
  feature: unknown,
) {
  if (!hovered) return false;
  return featureId ? hovered.id === featureId : hovered.feature === feature;
}
