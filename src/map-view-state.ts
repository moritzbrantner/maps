"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  MapDisplayMode,
  MapViewState,
  MapViewStateChangeReason,
  MapViewportProps,
} from "./map-display";
import { constrainMapViewState } from "./map-display";

const fallbackViewState: MapViewState = {
  center: [12, 25],
  zoom: 1.6,
};

export function useControllableMapViewState({
  display,
  fallback,
  onViewStateChange,
  viewState,
  defaultViewState,
  initialViewState,
  maxBounds,
  maxZoom,
  minZoom,
}: MapViewportProps & {
  display: MapDisplayMode;
  fallback?: MapViewState;
  minZoom?: number;
}) {
  const controlled = viewState !== undefined;
  const initial = useMemo(
    () =>
      constrainMapViewState(
        defaultViewState ?? initialViewState ?? fallback ?? fallbackViewState,
        { maxBounds, maxZoom, minZoom },
      ),
    [],
  );
  const [uncontrolledViewState, setUncontrolledViewState] = useState<MapViewState>(initial);
  const latestViewState = constrainMapViewState(viewState ?? uncontrolledViewState, {
    maxBounds,
    maxZoom,
    minZoom,
  });
  const lastEmissionRef = useRef<string | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  useEffect(() => {
    if (controlled || areMapViewStatesEqual(uncontrolledViewState, latestViewState)) {
      return;
    }

    setUncontrolledViewState(latestViewState);
  }, [controlled, latestViewState, uncontrolledViewState]);

  const setViewState = useCallback(
    (next: MapViewState, reason: MapViewStateChangeReason = "programmatic") => {
      const constrainedNext = constrainMapViewState(next, { maxBounds, maxZoom, minZoom });

      if (!controlled) {
        setUncontrolledViewState(constrainedNext);
      }

      const emissionKey = `${reason}:${serializeMapViewState(constrainedNext)}`;

      if (lastEmissionRef.current !== emissionKey) {
        lastEmissionRef.current = emissionKey;
        onViewStateChangeRef.current?.(constrainedNext, { display, reason });
      }
    },
    [controlled, display, maxBounds, maxZoom, minZoom],
  );

  return {
    controlled,
    setViewState,
    viewState: latestViewState,
  };
}

export function areMapViewStatesEqual(left: MapViewState, right: MapViewState) {
  return serializeMapViewState(left) === serializeMapViewState(right);
}

export function serializeMapViewState(viewState: MapViewState) {
  return JSON.stringify({
    center: viewState.center.map((value) => Number(value.toFixed(8))),
    zoom: Number(viewState.zoom.toFixed(8)),
  });
}
