"use client";

import { useContext, useEffect, useState } from "react";

import { toLeafletLatLng } from "./map-display";
import { MapSurfaceContext } from "./map-view";
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

export type BeeLineMeasurementLayerProps = MapMeasurementProps;

export function BeeLineMeasurementLayer({
  measurementDistanceFormat = "metric",
  measurementDraftLineColor,
  measurementLineColor = "#0f766e",
  measurementMode = "none",
  measurements = [],
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
}: BeeLineMeasurementLayerProps) {
  const surface = useContext(MapSurfaceContext);
  const [draft, setDraft] = useState<MapBeeLineMeasurementDraft | null>(null);
  const isMeasuring = measurementMode === "bee-line";
  const draftLineColor = measurementDraftLineColor ?? measurementLineColor;

  useEffect(() => {
    surface?.setMeasurementActive(isMeasuring);

    return () => {
      surface?.setMeasurementActive(false);
    };
  }, [isMeasuring, surface]);

  useEffect(() => {
    if (!isMeasuring && draft) {
      setDraft(null);
      onMeasurementDraftChange?.(null);
    }
  }, [draft, isMeasuring, onMeasurementDraftChange]);

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer("measurement-layer", ({ layer, leaflet, map }) => {
      layer.clearLayers();

      for (const measurement of measurements) {
        renderCompletedFlatMeasurement({
          leaflet,
          layer,
          measurement,
          measurementDistanceFormat,
          measurementLineColor,
          onSelect: onMeasurementSelect,
        });
      }

      if (draft?.to && draft.distanceMeters !== undefined) {
        renderDraftFlatMeasurement({
          draft,
          leaflet,
          layer,
          measurementDraftLineColor: draftLineColor,
        });
      }

      const container = map.getContainer();

      if (isMeasuring) {
        container.style.cursor = "crosshair";
      } else if (container.style.cursor === "crosshair") {
        container.style.cursor = "";
      }
    });
  }, [
    draft,
    draftLineColor,
    isMeasuring,
    measurementDistanceFormat,
    measurementLineColor,
    measurements,
    onMeasurementSelect,
    surface,
  ]);

  useEffect(() => {
    if (!surface || surface.display !== "flat" || !surface.leafletMap || !isMeasuring) {
      return;
    }

    const map = surface.leafletMap;
    let draftFrom: MapCoordinate | null = null;

    function clearDraft() {
      draftFrom = null;
      setDraft(null);
      onMeasurementDraftChange?.(null);
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
        onMeasurementDraftChange?.(nextDraft);
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

      onMeasurementCreate?.(result);
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
      onMeasurementDraftChange?.(nextDraft);
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
    isMeasuring,
    measurementDistanceFormat,
    onMeasurementCreate,
    onMeasurementDraftChange,
    surface,
  ]);

  useEffect(() => {
    if (!surface || surface.display !== "globe" || !isMeasuring) {
      return;
    }

    function clearDraft() {
      setDraft(null);
      onMeasurementDraftChange?.(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && draft) {
        clearDraft();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [draft, isMeasuring, onMeasurementDraftChange, surface]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

  return (
    <g
      className="mb-maps__globe-measurements"
      onClick={(event) => {
        if (!isMeasuring) {
          return;
        }

        event.stopPropagation();
        const coordinate = surface.getGlobePointerCoordinate(event as unknown as React.PointerEvent<SVGSVGElement>);

        if (!coordinate) {
          return;
        }

        if (!draft?.from) {
          const nextDraft = { from: coordinate };

          setDraft(nextDraft);
          onMeasurementDraftChange?.(nextDraft);
          return;
        }

        const result = createMeasurementResult(draft.from, coordinate, measurementDistanceFormat);

        if (result) {
          onMeasurementCreate?.(result);
        }

        setDraft(null);
        onMeasurementDraftChange?.(null);
      }}
      onPointerMove={(event) => {
        if (!isMeasuring || !draft?.from) {
          return;
        }

        const coordinate = surface.getGlobePointerCoordinate(event as unknown as React.PointerEvent<SVGSVGElement>);
        const result = coordinate
          ? createMeasurementResult(draft.from, coordinate, measurementDistanceFormat)
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
        onMeasurementDraftChange?.(nextDraft);
      }}
      pointerEvents={isMeasuring ? "all" : "none"}
    >
      {measurements.map((measurement) => (
        <GlobeMeasurement
          key={measurement.id}
          measurement={measurement}
          measurementDistanceFormat={measurementDistanceFormat}
          measurementLineColor={measurementLineColor}
          onMeasurementSelect={onMeasurementSelect}
        />
      ))}
      {draft?.to && draft.formattedDistance ? (
        <GlobeDraftMeasurement draft={draft} measurementDraftLineColor={draftLineColor} />
      ) : null}
    </g>
  );
}

function GlobeMeasurement({
  measurement,
  measurementDistanceFormat,
  measurementLineColor,
  onMeasurementSelect,
}: {
  measurement: MapBeeLineMeasurement;
  measurementDistanceFormat: MapDistanceFormat;
  measurementLineColor: string;
  onMeasurementSelect?: (measurement: MapBeeLineMeasurement | null) => void;
}) {
  const surface = useContext(MapSurfaceContext)!;
  const from = surface.projectGlobeCoordinate(measurement.from, surface.viewState);
  const to = surface.projectGlobeCoordinate(measurement.to, surface.viewState);
  const midpoint = getBeeLineMidpoint(measurement.from, measurement.to);
  const label = getBeeLineMeasurementLabel(measurement, measurementDistanceFormat);
  const projectedMidpoint = midpoint
    ? surface.projectGlobeCoordinate(midpoint, surface.viewState)
    : null;

  if (!from.visible || !to.visible || !projectedMidpoint?.visible || !label) {
    return null;
  }

  return (
    <g
      className="mb-maps__measurement"
      onClick={(event) => {
        event.stopPropagation();
        onMeasurementSelect?.(measurement);
      }}
    >
      <line
        className="mb-maps__measurement-line"
        stroke={measurementLineColor}
        x1={from.x}
        x2={to.x}
        y1={from.y}
        y2={to.y}
      />
      <circle className="mb-maps__measurement-endpoint" cx={from.x} cy={from.y} r={4} />
      <circle className="mb-maps__measurement-endpoint" cx={to.x} cy={to.y} r={4} />
      <text
        className="mb-maps__measurement-label"
        x={projectedMidpoint.x}
        y={projectedMidpoint.y}
      >
        {label}
      </text>
    </g>
  );
}

function GlobeDraftMeasurement({
  draft,
  measurementDraftLineColor,
}: {
  draft: MapBeeLineMeasurementDraft;
  measurementDraftLineColor: string;
}) {
  const surface = useContext(MapSurfaceContext)!;
  const from = draft.from ? surface.projectGlobeCoordinate(draft.from, surface.viewState) : null;
  const to = draft.to ? surface.projectGlobeCoordinate(draft.to, surface.viewState) : null;
  const midpoint = draft.to ? getBeeLineMidpoint(draft.from, draft.to) : null;
  const projectedMidpoint = midpoint
    ? surface.projectGlobeCoordinate(midpoint, surface.viewState)
    : null;

  if (!from?.visible || !to?.visible || !projectedMidpoint?.visible || !draft.formattedDistance) {
    return null;
  }

  return (
    <g className="mb-maps__measurement mb-maps__measurement--draft">
      <line
        className="mb-maps__measurement-line mb-maps__measurement-line--draft"
        stroke={measurementDraftLineColor}
        x1={from.x}
        x2={to.x}
        y1={from.y}
        y2={to.y}
      />
      <circle className="mb-maps__measurement-endpoint" cx={from.x} cy={from.y} r={4} />
      <circle className="mb-maps__measurement-endpoint" cx={to.x} cy={to.y} r={4} />
      <text
        className="mb-maps__measurement-label"
        x={projectedMidpoint.x}
        y={projectedMidpoint.y}
      >
        {draft.formattedDistance}
      </text>
    </g>
  );
}

function renderCompletedFlatMeasurement({
  leaflet,
  layer,
  measurement,
  measurementDistanceFormat,
  measurementLineColor,
  onSelect,
}: {
  leaflet: typeof import("leaflet");
  layer: import("leaflet").LayerGroup;
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
    onSelect?.(measurement);
  });
  line.addTo(layer);

  addEndpoint(leaflet, layer, from, measurementLineColor);
  addEndpoint(leaflet, layer, to, measurementLineColor);
}

function renderDraftFlatMeasurement({
  draft,
  leaflet,
  layer,
  measurementDraftLineColor,
}: {
  draft: MapBeeLineMeasurementDraft;
  leaflet: typeof import("leaflet");
  layer: import("leaflet").LayerGroup;
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
  layer: import("leaflet").LayerGroup,
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
