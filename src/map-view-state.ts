"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  MapDisplayMode,
  MapViewState,
  MapViewStateChangeReason,
  MapViewportProps,
} from "./map-display";

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
}: MapViewportProps & {
  display: MapDisplayMode;
  fallback?: MapViewState;
}) {
  const controlled = viewState !== undefined;
  const initial = useMemo(
    () => defaultViewState ?? initialViewState ?? fallback ?? fallbackViewState,
    [],
  );
  const [uncontrolledViewState, setUncontrolledViewState] = useState<MapViewState>(initial);
  const latestViewState = viewState ?? uncontrolledViewState;
  const lastEmissionRef = useRef<string | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);

  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  const setViewState = useCallback(
    (next: MapViewState, reason: MapViewStateChangeReason = "programmatic") => {
      if (!controlled) {
        setUncontrolledViewState(next);
      }

      const emissionKey = `${reason}:${serializeMapViewState(next)}`;

      if (lastEmissionRef.current !== emissionKey) {
        lastEmissionRef.current = emissionKey;
        onViewStateChangeRef.current?.(next, { display, reason });
      }
    },
    [controlled, display],
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
