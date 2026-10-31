import type { GeoJsonLayerFeature } from "@moritzbrantner/maps";

import { demoTimelineGeoJsonCollection, formatDemoTimelineTime } from "../data/demo-timeline";
import { countDemoGeometryParts, countDemoGeometryPositions } from "../lib/geojson-features";
import type { DemoGeoJsonProperties } from "../types";

export function renderDemoTimelineGeoJsonTooltip(
  feature: GeoJsonLayerFeature<DemoGeoJsonProperties>,
) {
  const properties = readDemoTimelineOutputProperties(feature);

  return `${properties.label} (${feature.geometry.type})`;
}

export function renderDemoTimelineGeoJsonPopup(
  feature: GeoJsonLayerFeature<DemoGeoJsonProperties>,
  activeTime: number,
) {
  const properties = readDemoTimelineOutputProperties(feature);
  const interpolation = getDemoTimelineInterpolationInfo(properties.trackId, activeTime);

  return (
    <div className="demo-popup">
      <strong>{properties.label}</strong>
      <span>{feature.geometry.type}</span>
      <span>
        {countDemoGeometryPositions(feature.geometry)} coordinates across{" "}
        {countDemoGeometryParts(feature.geometry)} part
        {countDemoGeometryParts(feature.geometry) === 1 ? "" : "s"}
      </span>
      <span>{interpolation.segment}</span>
      <span>{interpolation.method}</span>
    </div>
  );
}

function readDemoTimelineOutputProperties(feature: GeoJsonLayerFeature<DemoGeoJsonProperties>) {
  const properties = feature.properties as DemoGeoJsonProperties & {
    temporalLabel?: unknown;
    temporalTrackId?: unknown;
  };

  return {
    label: String(properties.temporalLabel ?? properties.label ?? feature.id),
    trackId: String(properties.temporalTrackId ?? properties.trackId ?? feature.id),
  };
}

function getDemoTimelineInterpolationInfo(trackId: string, activeTime: number) {
  const frames = demoTimelineGeoJsonCollection.features
    .flatMap((feature) => {
      if (feature.properties?.trackId !== trackId || !feature.geometry) {
        return [];
      }

      return [
        {
          geometryType: feature.geometry.type,
          time: feature.properties.time,
          visible: feature.properties.visible !== false,
        },
      ];
    })
    .sort((left, right) => left.time - right.time);

  if (frames.length === 0) {
    return {
      method: "No source keyframes found",
      segment: `Sampled at ${formatDemoTimelineTime(activeTime)}`,
    };
  }

  const previousIndex = findPreviousDemoTimelineFrameIndex(frames, activeTime);
  const nextIndex = frames.findIndex((frame) => frame.time > activeTime);

  if (previousIndex < 0) {
    return {
      method: "Waiting for first keyframe",
      segment: `Starts at ${formatDemoTimelineTime(frames[0]!.time)}`,
    };
  }

  if (nextIndex < 0) {
    const frame = frames[previousIndex]!;

    return {
      method: frame.visible ? "Holding final keyframe" : "Hidden after final keyframe",
      segment: `Last keyframe ${formatDemoTimelineTime(frame.time)}`,
    };
  }

  const previous = frames[previousIndex]!;
  const next = frames[nextIndex]!;
  const progress =
    next.time === previous.time
      ? 1
      : Math.min(Math.max((activeTime - previous.time) / (next.time - previous.time), 0), 1);
  const method =
    previous.geometryType === next.geometryType
      ? `${getDemoTimelineInterpolationMethod(previous.geometryType)} interpolation`
      : `Hold fallback from ${previous.geometryType} to ${next.geometryType}`;

  return {
    method,
    segment: `${formatDemoTimelineTime(previous.time)} to ${formatDemoTimelineTime(next.time)} (${Math.round(
      progress * 100,
    )}%)`,
  };
}

function getDemoTimelineInterpolationMethod(geometryType: string) {
  switch (geometryType) {
    case "LineString":
    case "MultiLineString":
    case "Polygon":
    case "MultiPolygon":
      return `Resampled ${geometryType}`;
    default:
      return `Compatible ${geometryType}`;
  }
}

function findPreviousDemoTimelineFrameIndex(frames: Array<{ time: number }>, activeTime: number) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (frames[index]!.time <= activeTime) {
      return index;
    }
  }

  return -1;
}

export function getDemoTimelineGeographyStyle(feature: {
  properties: Partial<DemoGeoJsonProperties>;
}) {
  switch (feature.properties.kind) {
    case "checkpoint":
      return {
        pointColor: "#be123c",
        pointRadius: 8,
      };
    case "relay-pair":
      return {
        pointColor: "#7c3aed",
        pointRadius: 6,
      };
    case "corridor":
      return {
        lineColor: "#0e7490",
        lineOpacity: 0.8,
        lineWidth: 4,
      };
    case "branch-corridors":
      return {
        lineColor: "#4f46e5",
        lineOpacity: 0.72,
        lineWidth: 3,
      };
    case "operating-area":
      return {
        polygonFillColor: "#f59e0b",
        polygonFillOpacity: 0.12,
        polygonStrokeColor: "#b45309",
        polygonStrokeWidth: 2,
      };
    default:
      return {
        polygonFillColor: "#14b8a6",
        polygonFillOpacity: 0.16,
        polygonStrokeColor: "#0f766e",
        polygonStrokeWidth: 2.5,
      };
  }
}
