"use client";

import { useEffect, useEffectEvent, useState, type MutableRefObject } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

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

export function useLeafletBeeLineMeasurementLayer(options: {
  leafletRef: MutableRefObject<typeof import("leaflet") | null>;
  mapRef: MutableRefObject<LeafletMap | null>;
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
    leafletRef,
    layerRef,
    mapRef,
    measurementMode = "none",
    measurements = [],
    measurementDistanceFormat = "metric",
    measurementLineColor = "#0f766e",
    measurementDraftLineColor = measurementLineColor,
  } = options;
  const leaflet = leafletRef.current;
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
    if (isMeasuring) {
      return;
    }

    setDraft((current) => {
      if (current) {
        emitDraftChange(null);
      }

      return null;
    });
  }, [emitDraftChange, isMeasuring]);

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
    if (!leaflet || !layer) {
      return;
    }

    layer.clearLayers();

    for (const measurement of measurements) {
      renderCompletedMeasurement({
        leaflet,
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
        leaflet,
        layer,
        measurementDraftLineColor,
      });
    }
  }, [
    draft,
    emitSelect,
    layer,
    leaflet,
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
  leaflet,
  layer,
  measurement,
  measurementDistanceFormat,
  measurementLineColor,
  onSelect,
}: {
  leaflet: typeof import("leaflet");
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

  const line = leaflet.polyline([toLeafletLatLng(from), toLeafletLatLng(to)], {
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
  line.openTooltip(toLeafletLatLng(midpoint));
  line.on("click", () => {
    onSelect(measurement);
  });
  line.addTo(layer);

  addEndpoint(leaflet, layer, from, measurementLineColor);
  addEndpoint(leaflet, layer, to, measurementLineColor);
}

function renderDraftMeasurement({
  draft,
  leaflet,
  layer,
  measurementDraftLineColor,
}: {
  draft: MapBeeLineMeasurementDraft;
  leaflet: typeof import("leaflet");
  layer: LayerGroup;
  measurementDraftLineColor: string;
}) {
  const from = normalizeMapCoordinate(draft.from);
  const to = normalizeMapCoordinate(draft.to);
  const midpoint = getBeeLineMidpoint(draft.from, draft.to);

  if (!from || !to || !midpoint || !draft.formattedDistance) {
    return;
  }

  leaflet
    .polyline([toLeafletLatLng(from), toLeafletLatLng(to)], {
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
    .openTooltip(toLeafletLatLng(midpoint))
    .addTo(layer);

  addEndpoint(leaflet, layer, from, measurementDraftLineColor);
  addEndpoint(leaflet, layer, to, measurementDraftLineColor);
}

function addEndpoint(
  leaflet: typeof import("leaflet"),
  layer: LayerGroup,
  coordinate: MapCoordinate,
  color: string,
) {
  leaflet
    .circleMarker(toLeafletLatLng(coordinate), {
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

function getEventCoordinate(event: { latlng?: { lat?: number; lng?: number } }) {
  const { latlng } = event;

  return normalizeMapCoordinate([latlng?.lng ?? Number.NaN, latlng?.lat ?? Number.NaN]);
}

function toLeafletLatLng([longitude, latitude]: MapCoordinate): [number, number] {
  return [latitude, longitude];
}
