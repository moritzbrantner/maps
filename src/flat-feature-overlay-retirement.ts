"use client";

import { useCallback, useEffect, useRef } from "react";

import type { MapSurfaceContextValue } from "./map-surface-context";

type OpenedPopup = { feature: unknown; key: string; wasSelected: boolean };

/**
 * Retires a MapLibre-path Map Layer's anchored feature overlays once their Map Feature is no
 * longer an interactive feature of the layer, matching the Maps runtime: the popup this layer
 * opened closes, and a hover this layer delivered clears (MapLibre fires no `mouseleave` for
 * a removed layer). A popup also closes when the layer's controlled `selectedFeatureId` had
 * selected its feature and no longer does.
 *
 * Returns `trackPopup`, to call when the layer opens a popup for a feature.
 */
export function useFlatFeatureOverlayRetirement({
  clearHover,
  deliveredHoverKeyRef,
  interactiveFeatureKeys,
  selectedFeatureId,
  surface,
}: {
  /** Reports the cleared hover to the surface and the layer's hover callbacks. */
  clearHover: () => void;
  deliveredHoverKeyRef: { current: string | null };
  interactiveFeatureKeys: ReadonlySet<string>;
  selectedFeatureId: string | null | undefined;
  surface: MapSurfaceContextValue | null;
}) {
  const openedPopupRef = useRef<OpenedPopup | null>(null);
  const selectedFeatureIdRef = useRef(selectedFeatureId);
  const clearHoverRef = useRef(clearHover);

  useEffect(() => {
    selectedFeatureIdRef.current = selectedFeatureId;
    clearHoverRef.current = clearHover;
  });

  useEffect(() => {
    const opened = openedPopupRef.current;

    if (opened) {
      if (selectedFeatureId === opened.key) {
        opened.wasSelected = true;
      }

      const deselected = opened.wasSelected && selectedFeatureId !== opened.key;

      if (deselected || !interactiveFeatureKeys.has(opened.key)) {
        openedPopupRef.current = null;
        surface?.closeFeaturePopup(opened.feature);
      }
    }

    const hoveredKey = deliveredHoverKeyRef.current;

    if (hoveredKey !== null && !interactiveFeatureKeys.has(hoveredKey)) {
      deliveredHoverKeyRef.current = null;
      clearHoverRef.current();
    }
  }, [deliveredHoverKeyRef, interactiveFeatureKeys, selectedFeatureId, surface]);

  return useCallback((key: string, feature: unknown) => {
    openedPopupRef.current = {
      feature,
      key,
      wasSelected: selectedFeatureIdRef.current === key,
    };
  }, []);
}
