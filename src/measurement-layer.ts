"use client";

import { useEffect, useEffectEvent, useState, type MutableRefObject } from "react";
import type { LayerGroup, Map as FlatMap } from "flat";

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
  type MapMeasurementMode,
} from "./measurement";

export function useFlatBeeLineMeasurementLayer(options: {
  flatRef: MutableRefObject<typeof import("flat") | null>;
  mapRef: MutableRefObject<FlatMap | null>;
  layerRef: MutableRefObject<LayerGroup | null>;
  measurementMode?: MapMeasurementMode;
  measurements?: readonly MapBeeLineMeasurement[];
  measurementDistanceFormat?: MapDistanceFormat;
  measurementLineColor?: string;
  measurementDraftLineColor?: string;
  onMeasurementCreate?: (measurement: MapBeeLineMeasurementResult) => void;
  onMeasurementDraftChange?: (draft: MapBeeLineMeasurementDraft | null) => void;
  onMeasurementSelect?: (measurement: MapBeeLineMeasurement | null) => void;
}): {
  isMeasuring: boolean;
} {
  const {
    flatRef,
    layerRef,
    mapRef,
    measurementMode = "none",
    measurements = [],
    measurementDistanceFormat = "metric",
    measurementLineColor = "#0f766e",
    measurementDraftLineColor = measurementLineColor,
  } = options;
  const flat = flatRef.current;
  const layer = layerRef.current;
  const map = mapRef.current;
  const [draft, setDraft] = useState<MapBeeLineMeasurementDraft | null>(null);
  const isMeasuring = measurementMode === "bee-line";

  const emitCreate = useEffectEvent((measurement: MapBeeLineMeasurementResult) => {
    options.onMeasurementCreate?.(measurement);
  });
  const emitDraftChange = useEffectEvent((nextDraft: MapBeeLineMeasurementDraft | null) => {
    options.onMeasurementDraftChange?.(nextDraft);
  });
  const emitSelect = useEffectEvent((measurement: MapBeeLineMeasurement | null) => {
    options.onMeasurementSelect?.(measurement);
  });

  useEffect(() => {
    if (!map) {
      return;
    }

    const container = map.getContainer();

    if (!isMeasuring) {
      container.style.cursor = "";
      return;
    }

    container.style.cursor = "crosshair";

    return () => {
      container.style.cursor = "";
    };
  }, [isMeasuring, map]);

  useEffect(() => {
    if (!flat || !layer) {
      return;
    }

    layer.clearLayers();

    for (const measurement of measurements) {
      renderCompletedMeasurement({
        flat,
        layer,
        measurement,
        measurementDistanceFormat,
        measurementLineColor,
        onSelect: emitSelect,
      });
    }

    if (draft?.to && draft.distanceMeters !== undefined) {
      renderDraftMeasurement({
        draft,
        flat,
        layer,
        measurementDraftLineColor,
      });
    }
  }, [
    draft,
    emitSelect,
    layer,
    flat,
    measurementDistanceFormat,
    measurementDraftLineColor,
    measurementLineColor,
    measurements,
  ]);

  useEffect(() => {
    if (!isMeasuring || !map) {
      return;
    }

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

      const distanceMeters = getBeeLineDistanceMeters(draftFrom, nextCoordinate);

      if (distanceMeters === null) {
        clearDraft();
        return;
      }

      const result = {
        distanceMeters,
        formattedDistance: formatMapDistance(distanceMeters, measurementDistanceFormat),
        from: draftFrom,
        to: nextCoordinate,
      };

      emitCreate(result);
      clearDraft();
    }

    function handleMouseMove(event: { latlng?: { lat?: number; lng?: number } }) {
      if (!draftFrom) {
        return;
      }

      const nextCoordinate = getEventCoordinate(event);

      if (!nextCoordinate) {
        return;
      }

      const distanceMeters = getBeeLineDistanceMeters(draftFrom, nextCoordinate);

      if (distanceMeters === null) {
        return;
      }

      const nextDraft = {
        distanceMeters,
        formattedDistance: formatMapDistance(distanceMeters, measurementDistanceFormat),
        from: draftFrom,
        to: nextCoordinate,
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
  }, [emitCreate, emitDraftChange, isMeasuring, map, measurementDistanceFormat]);

  return {
    isMeasuring,
  };
}

function renderCompletedMeasurement({
  flat,
  layer,
  measurement,
  measurementDistanceFormat,
  measurementLineColor,
  onSelect,
}: {
  flat: typeof import("flat");
  layer: LayerGroup;
  measurement: MapBeeLineMeasurement;
  measurementDistanceFormat: MapDistanceFormat;
  measurementLineColor: string;
  onSelect: (measurement: MapBeeLineMeasurement | null) => void;
}) {
  const from = normalizeMapCoordinate(measurement.from);
  const to = normalizeMapCoordinate(measurement.to);
  const midpoint = getBeeLineMidpoint(measurement.from, measurement.to);
  const label = getBeeLineMeasurementLabel(measurement, measurementDistanceFormat);

  if (!from || !to || !midpoint || !label) {
    return;
  }

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
    onSelect(measurement);
  });
  line.addTo(layer);

  addEndpoint(flat, layer, from, measurementLineColor);
  addEndpoint(flat, layer, to, measurementLineColor);
}

function renderDraftMeasurement({
  draft,
  flat,
  layer,
  measurementDraftLineColor,
}: {
  draft: MapBeeLineMeasurementDraft;
  flat: typeof import("flat");
  layer: LayerGroup;
  measurementDraftLineColor: string;
}) {
  const from = normalizeMapCoordinate(draft.from);
  const to = normalizeMapCoordinate(draft.to);
  const midpoint = getBeeLineMidpoint(draft.from, draft.to);

  if (!from || !to || !midpoint || !draft.formattedDistance) {
    return;
  }

  flat
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

  addEndpoint(flat, layer, from, measurementDraftLineColor);
  addEndpoint(flat, layer, to, measurementDraftLineColor);
}

function addEndpoint(
  flat: typeof import("flat"),
  layer: LayerGroup,
  coordinate: MapCoordinate,
  color: string,
) {
  flat
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

function getEventCoordinate(event: {
  latlng?: { lat?: number; lng?: number };
  lngLat?: { lat?: number; lng?: number };
}) {
  const latlng = event.latlng ?? event.lngLat;

  return normalizeMapCoordinate([latlng?.lng ?? Number.NaN, latlng?.lat ?? Number.NaN]);
}

function toLatLng([longitude, latitude]: MapCoordinate): [number, number] {
  return [latitude, longitude];
}
