"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  MapDisplayMode,
  MapViewState,
  MapViewStateChangeReason,
  MapViewportProps,
} from "./map-display";
import {
  constrainMapViewState,
  normalizeMapMaxZoom,
  normalizeMapMinZoom,
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
  const [runtimeMinZoom, setRuntimeMinZoom] = useState<number | undefined>();
  const normalizedMaxZoom = normalizeMapMaxZoom(maxZoom);
  const configuredMinZoom = normalizeMapMinZoom(minZoom);
  const activeRuntimeMinZoom =
    runtimeMinZoom !== undefined &&
    normalizedMaxZoom !== undefined &&
    runtimeMinZoom > normalizedMaxZoom
      ? runtimeMinZoom
      : undefined;
  const effectiveMinZoom =
    activeRuntimeMinZoom === undefined
      ? configuredMinZoom
      : Math.max(configuredMinZoom ?? 0, activeRuntimeMinZoom);
  const requestedViewState = viewState ?? uncontrolledViewState;
  const constraintInput =
    activeRuntimeMinZoom === undefined
      ? requestedViewState
      : { ...requestedViewState, zoom: activeRuntimeMinZoom };
  const latestViewState = constrainMapViewState(constraintInput, {
    maxBounds,
    maxZoom,
    minZoom: effectiveMinZoom,
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
      const canCarryRuntimeConstraint = ![
        "cluster-expand",
        "fly-to",
        "programmatic",
      ].includes(reason);
      const nextRuntimeMinZoom =
        canCarryRuntimeConstraint &&
        normalizedMaxZoom !== undefined &&
        next.zoom > normalizedMaxZoom
          ? next.zoom
          : canCarryRuntimeConstraint
            ? undefined
            : activeRuntimeMinZoom;
      const nextEffectiveMinZoom =
        nextRuntimeMinZoom === undefined
          ? configuredMinZoom
          : Math.max(configuredMinZoom ?? 0, nextRuntimeMinZoom);
      const nextConstraintInput =
        nextRuntimeMinZoom !== undefined &&
        normalizedMaxZoom !== undefined &&
        nextRuntimeMinZoom > normalizedMaxZoom
          ? { ...next, zoom: nextRuntimeMinZoom }
          : next;
      const constrainedNext = constrainMapViewState(nextConstraintInput, {
        maxBounds,
        maxZoom,
        minZoom: nextEffectiveMinZoom,
      });

      if (runtimeMinZoom !== nextRuntimeMinZoom) {
        setRuntimeMinZoom(nextRuntimeMinZoom);
      }

      if (!controlled) {
        setUncontrolledViewState(constrainedNext);
      }

      const emissionKey = `${reason}:${serializeMapViewState(constrainedNext)}`;

      if (lastEmissionRef.current !== emissionKey) {
        lastEmissionRef.current = emissionKey;
        onViewStateChangeRef.current?.(constrainedNext, { display, reason });
      }
    },
    [
      activeRuntimeMinZoom,
      configuredMinZoom,
      controlled,
      display,
      maxBounds,
      maxZoom,
      normalizedMaxZoom,
      runtimeMinZoom,
    ],
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
