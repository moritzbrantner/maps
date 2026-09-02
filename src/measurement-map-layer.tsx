"use client";

import { useContext, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { toLatLng } from "./map-display";
import type { FlatLayer, FlatLayerFactory, FlatLayerGroup } from "./maplibre-compat";
import { MapSurfaceContext } from "./map-view";
import {
  createFlatLayerResourceState,
  reconcileFlatLayerEntries,
  removeFlatLayerEntry,
  resetFlatLayerResourceState,
} from "./flat-layer-reconciler";
import {
  formatMapDistance,
  getBeeLineDistanceMeters,
  getBeeLineMeasurementLabel,
  getBeeLineMidpoint,
  normalizeMapCoordinate,
  type MapBeeLineMeasurement,
  type MapBeeLineMeasurementDraft,
  type MapBeeLineMeasurementResult,
  type MapCoordinate,
  type MapDistanceFormat,
  type MapMeasurementProps,
} from "./measurement";

export type BeeLineMeasurementLayerProps = MapMeasurementProps & {
  layerId?: string;
};

export function BeeLineMeasurementLayer({
  measurementDistanceFormat = "metric",
  measurementDraftLineColor,
  measurementLineColor = "#0f766e",
  measurementMode = "none",
  measurements = [],
  layerId,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
}: BeeLineMeasurementLayerProps) {
  const surface = useContext(MapSurfaceContext);
  const display = surface?.display;
  const flatMap = surface?.flatMap;
  const registerMapLibreLayer = surface?.registerMapLibreLayer;
  const setMeasurementActive = surface?.setMeasurementActive;
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `measurement-layer-${generatedLayerId}`;
  const flatMeasurementCacheRef = useRef<Map<string, FlatMeasurementCacheEntry>>(new Map());
  const flatDraftStateRef = useRef(createFlatLayerResourceState<FlatMeasurementCacheEntry>());
  const [draft, setDraft] = useState<MapBeeLineMeasurementDraft | null>(null);
  const isMeasuring = measurementMode === "bee-line";
  const draftLineColor = measurementDraftLineColor ?? measurementLineColor;
  const emitCreate = useEffectEvent((measurement: MapBeeLineMeasurementResult) => {
    onMeasurementCreate?.(measurement);
  });
  const emitDraftChange = useEffectEvent((nextDraft: MapBeeLineMeasurementDraft | null) => {
    onMeasurementDraftChange?.(nextDraft);
  });
  const emitSelect = useEffectEvent((measurement: MapBeeLineMeasurement | null) => {
    onMeasurementSelect?.(measurement);
  });

  useEffect(() => {
    setMeasurementActive?.(isMeasuring);

    return () => {
      setMeasurementActive?.(false);
    };
  }, [isMeasuring, setMeasurementActive]);

  useEffect(() => {
    if (!registerMapLibreLayer || (display !== "flat" && display !== "globe")) {
      flatMeasurementCacheRef.current.clear();
      flatDraftStateRef.current.resource = null;
      flatDraftStateRef.current.signature = null;
      return;
    }

    return registerMapLibreLayer(resolvedLayerId, ({ layer, flat, map }) => {
      reconcileFlatLayerEntries<FlatMeasurementCacheEntry>({
        cache: flatMeasurementCacheRef.current,
        layer,
        plans: measurements.map((measurement) => {
          const signature = createFlatMeasurementSignature(
            measurement,
            measurementDistanceFormat,
            measurementLineColor,
          );

          return {
            key: measurement.id,
            render: () => {
              const layers = renderCompletedFlatMeasurement({
                flat,
                layer,
                measurement,
                measurementDistanceFormat,
                measurementLineColor,
                onSelect: emitSelect,
              });

              return layers.length > 0 ? { layers, signature } : null;
            },
            signature,
          };
        }),
      });

      if (draft?.to && draft.distanceMeters !== undefined) {
        const signature = createFlatMeasurementDraftSignature(draft, draftLineColor);
        const draftState = flatDraftStateRef.current;

        if (draftState.signature !== signature) {
          resetFlatLayerResourceState({
            remove: (entry) => removeFlatLayerEntry(layer, entry),
            state: draftState,
          });

          const layers = renderDraftFlatMeasurement({
            draft,
            flat,
            layer,
            measurementDraftLineColor: draftLineColor,
          });

          draftState.resource = layers.length > 0 ? { layers, signature } : null;
          draftState.signature = draftState.resource ? signature : null;
        }
      } else if (flatDraftStateRef.current.resource) {
        resetFlatLayerResourceState({
          remove: (entry) => removeFlatLayerEntry(layer, entry),
          state: flatDraftStateRef.current,
        });
      }

      const container = map.getContainer();

      if (isMeasuring) {
        container.style.cursor = "crosshair";
      } else if (container.style.cursor === "crosshair") {
        container.style.cursor = "";
      }
    }, { preserveOnRender: true, renderOnViewStateChange: false });
  }, [
    draft,
    draftLineColor,
    isMeasuring,
    measurementDistanceFormat,
    measurementLineColor,
    measurements,
    display,
    registerMapLibreLayer,
    resolvedLayerId,
  ]);

  useEffect(() => {
    if ((display !== "flat" && display !== "globe") || !flatMap || !isMeasuring) {
      return;
    }

    const map = flatMap;
    let draftFrom: MapCoordinate | null = null;

    function clearDraft() {
      draftFrom = null;
      setDraft(null);
      emitDraftChange(null);
    }

    function handleClick(event: { latlng?: { lat?: number; lng?: number } }) {
      const nextCoordinate = getEventCoordinate(event);

      if (!nextCoordinate) {
        return;
      }

      if (!draftFrom) {
        draftFrom = nextCoordinate;
        const nextDraft = { from: nextCoordinate };

        setDraft(nextDraft);
        emitDraftChange(nextDraft);
        return;
      }

      const result = createMeasurementResult(
        draftFrom,
        nextCoordinate,
        measurementDistanceFormat,
      );

      if (!result) {
        clearDraft();
        return;
      }

      emitCreate(result);
      clearDraft();
    }

    function handleMouseMove(event: { latlng?: { lat?: number; lng?: number } }) {
      if (!draftFrom) {
        return;
      }

      const nextCoordinate = getEventCoordinate(event);
      const result = nextCoordinate
        ? createMeasurementResult(draftFrom, nextCoordinate, measurementDistanceFormat)
        : null;

      if (!result) {
        return;
      }

      const nextDraft = {
        distanceMeters: result.distanceMeters,
        formattedDistance: result.formattedDistance,
        from: result.from,
        to: result.to,
      };

      setDraft(nextDraft);
      emitDraftChange(nextDraft);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && draftFrom) {
        clearDraft();
      }
    }

    map.on("click", handleClick);
    map.on("mousemove", handleMouseMove);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      map.off("click", handleClick);
      map.off("mousemove", handleMouseMove);
      document.removeEventListener("keydown", handleKeyDown);
      clearDraft();
    };
  }, [
    display,
    flatMap,
    isMeasuring,
    measurementDistanceFormat,
  ]);

  return null;
}

function renderCompletedFlatMeasurement({
  flat,
  layer,
  measurement,
  measurementDistanceFormat,
  measurementLineColor,
  onSelect,
}: {
  flat: FlatLayerFactory;
  layer: FlatLayerGroup;
  measurement: MapBeeLineMeasurement;
  measurementDistanceFormat: MapDistanceFormat;
  measurementLineColor: string;
  onSelect?: (measurement: MapBeeLineMeasurement | null) => void;
}) {
  const from = normalizeMapCoordinate(measurement.from);
  const to = normalizeMapCoordinate(measurement.to);
  const midpoint = getBeeLineMidpoint(measurement.from, measurement.to);
  const label = getBeeLineMeasurementLabel(measurement, measurementDistanceFormat);

  if (!from || !to || !midpoint || !label) {
    return [];
  }

  const layers: FlatLayer[] = [];
  const line = flat.polyline([toLatLng(from), toLatLng(to)], {
    className: "mb-maps__measurement-line",
    color: measurementLineColor,
    opacity: 0.92,
    weight: 3,
  });

  line.bindTooltip(label, {
    className: "mb-maps__measurement-label",
    direction: "center",
    permanent: true,
  });
  line.openTooltip(toLatLng(midpoint));
  line.on("click", () => {
    onSelect?.(measurement);
  });
  line.addTo(layer);
  layers.push(line);

  layers.push(addEndpoint(flat, layer, from, measurementLineColor));
  layers.push(addEndpoint(flat, layer, to, measurementLineColor));

  return layers;
}

function renderDraftFlatMeasurement({
  draft,
  flat,
  layer,
  measurementDraftLineColor,
}: {
  draft: MapBeeLineMeasurementDraft;
  flat: FlatLayerFactory;
  layer: FlatLayerGroup;
  measurementDraftLineColor: string;
}) {
  const from = normalizeMapCoordinate(draft.from);
  const to = normalizeMapCoordinate(draft.to);
  const midpoint = getBeeLineMidpoint(draft.from, draft.to);

  if (!from || !to || !midpoint || !draft.formattedDistance) {
    return [];
  }

  const layers: FlatLayer[] = [];
  const line = flat
    .polyline([toLatLng(from), toLatLng(to)], {
      className: "mb-maps__measurement-line mb-maps__measurement-line--draft",
      color: measurementDraftLineColor,
      opacity: 0.76,
      weight: 3,
    })
    .bindTooltip(draft.formattedDistance, {
      className: "mb-maps__measurement-label",
      direction: "center",
      permanent: true,
    })
    .openTooltip(toLatLng(midpoint))
    .addTo(layer);

  layers.push(line);
  layers.push(addEndpoint(flat, layer, from, measurementDraftLineColor));
  layers.push(addEndpoint(flat, layer, to, measurementDraftLineColor));

  return layers;
}

function addEndpoint(
  flat: FlatLayerFactory,
  layer: FlatLayerGroup,
  coordinate: MapCoordinate,
  color: string,
) {
  return flat
    .circleMarker(toLatLng(coordinate), {
      className: "mb-maps__measurement-endpoint",
      color: "#ffffff",
      fillColor: color,
      fillOpacity: 1,
      interactive: false,
      opacity: 1,
      radius: 4,
      weight: 1.5,
    })
    .addTo(layer);
}

type FlatMeasurementCacheEntry = {
  layers: FlatLayer[];
  signature: string;
};

function createFlatMeasurementSignature(
  measurement: MapBeeLineMeasurement,
  measurementDistanceFormat: MapDistanceFormat,
  measurementLineColor: string,
) {
  return JSON.stringify({
    label: getBeeLineMeasurementLabel(measurement, measurementDistanceFormat),
    measurement,
    measurementLineColor,
  });
}

function createFlatMeasurementDraftSignature(
  draft: MapBeeLineMeasurementDraft,
  measurementDraftLineColor: string,
) {
  return JSON.stringify({
    draft,
    measurementDraftLineColor,
  });
}

function getEventCoordinate(event: {
  latlng?: { lat?: number; lng?: number };
  lngLat?: { lat?: number; lng?: number };
}) {
  const latlng = event.latlng ?? event.lngLat;

  return normalizeMapCoordinate([latlng?.lng ?? Number.NaN, latlng?.lat ?? Number.NaN]);
}

function createMeasurementResult(
  from: MapCoordinate,
  to: MapCoordinate,
  measurementDistanceFormat: MapDistanceFormat,
): MapBeeLineMeasurementResult | null {
  const distanceMeters = getBeeLineDistanceMeters(from, to);

  if (distanceMeters === null) {
    return null;
  }

  return {
    distanceMeters,
    formattedDistance: formatMapDistance(distanceMeters, measurementDistanceFormat),
    from,
    to,
  };
}
