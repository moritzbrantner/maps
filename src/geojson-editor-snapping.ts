"use client";

import { toLatLng } from "./map-display";
import type { FlatMapAdapter } from "./maplibre-compat";
import type {
  GeoJsonPosition,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type GeoJsonEditorSnapMode = "vertex" | "midpoint" | "segment" | "grid";

export type GeoJsonSnapTarget = {
  coordinates: GeoJsonPosition;
  distancePixels: number;
  featureId?: string;
  mode: GeoJsonEditorSnapMode;
};

export type GeoJsonEditorSnapOptions = {
  enabled?: boolean;
  gridSizeDegrees?: number;
  includeDraft?: boolean;
  includeSelectedFeature?: boolean;
  modes?: readonly GeoJsonEditorSnapMode[];
  pixelTolerance?: number;
};

export type GeoJsonSnapFeature = {
  geometry: TemporalGeoJsonSupportedGeometry;
  id: string;
};

export const DEFAULT_GEOJSON_EDITOR_SNAP_OPTIONS = {
  enabled: false,
  gridSizeDegrees: 0.01,
  includeDraft: true,
  includeSelectedFeature: true,
  modes: ["vertex", "midpoint"] as const,
  pixelTolerance: 12,
} satisfies Required<GeoJsonEditorSnapOptions>;

export function resolveGeoJsonSnapTarget({
  coordinate,
  draft,
  features,
  map,
  options,
  selectedFeatureIds = new Set(),
}: {
  coordinate: GeoJsonPosition;
  draft?: readonly GeoJsonPosition[];
  features: readonly GeoJsonSnapFeature[];
  map: Pick<FlatMapAdapter, "latLngToContainerPoint">;
  options?: GeoJsonEditorSnapOptions;
  selectedFeatureIds?: ReadonlySet<string>;
}): GeoJsonSnapTarget | null {
  const resolvedOptions = resolveSnapOptions(options);

  if (!resolvedOptions.enabled) {
    return null;
  }

  const modes = new Set<GeoJsonEditorSnapMode>(resolvedOptions.modes);
  const sourcePoint = projectCoordinate(map, coordinate);
  let bestTarget: GeoJsonSnapTarget | null = null;

  for (const feature of features) {
    if (!resolvedOptions.includeSelectedFeature && selectedFeatureIds.has(feature.id)) {
      continue;
    }

    bestTarget = getBestTarget(
      bestTarget,
      resolveFeatureSnapTarget({
        feature,
        map,
        modes,
        sourcePoint,
      }),
    );
  }

  if (resolvedOptions.includeDraft && draft && draft.length > 0) {
    bestTarget = getBestTarget(
      bestTarget,
      resolveCoordinateSequenceSnapTarget({
        coordinates: draft,
        featureId: undefined,
        map,
        modes,
        sourcePoint,
      }),
    );
  }

  if (bestTarget && bestTarget.distancePixels <= resolvedOptions.pixelTolerance) {
    return bestTarget;
  }

  if (!modes.has("grid")) {
    return null;
  }

  return resolveGridSnapTarget(coordinate, map, resolvedOptions.gridSizeDegrees);
}

export function resolveGeoJsonSnappedCoordinate(
  input: {
    coordinate: GeoJsonPosition;
    draft?: readonly GeoJsonPosition[];
    features: readonly GeoJsonSnapFeature[];
    map: Pick<FlatMapAdapter, "latLngToContainerPoint">;
    options?: GeoJsonEditorSnapOptions;
    selectedFeatureIds?: ReadonlySet<string>;
  },
): { coordinate: GeoJsonPosition; target: GeoJsonSnapTarget | null } {
  const target = resolveGeoJsonSnapTarget(input);

  return {
    coordinate: target?.coordinates ?? input.coordinate,
    target,
  };
}

function resolveSnapOptions(options: GeoJsonEditorSnapOptions | undefined) {
  return {
    ...DEFAULT_GEOJSON_EDITOR_SNAP_OPTIONS,
    ...options,
    modes: options?.modes ?? DEFAULT_GEOJSON_EDITOR_SNAP_OPTIONS.modes,
  };
}

function resolveFeatureSnapTarget({
  feature,
  map,
  modes,
  sourcePoint,
}: {
  feature: GeoJsonSnapFeature;
  map: Pick<FlatMapAdapter, "latLngToContainerPoint">;
  modes: ReadonlySet<GeoJsonEditorSnapMode>;
  sourcePoint: ScreenPoint;
}) {
  let bestTarget: GeoJsonSnapTarget | null = null;

  for (const sequence of getGeometryCoordinateSequences(feature.geometry)) {
    bestTarget = getBestTarget(
      bestTarget,
      resolveCoordinateSequenceSnapTarget({
        coordinates: sequence,
        featureId: feature.id,
        map,
        modes,
        sourcePoint,
      }),
    );
  }

  return bestTarget;
}

function resolveCoordinateSequenceSnapTarget({
  coordinates,
  featureId,
  map,
  modes,
  sourcePoint,
}: {
  coordinates: readonly GeoJsonPosition[];
  featureId: string | undefined;
  map: Pick<FlatMapAdapter, "latLngToContainerPoint">;
  modes: ReadonlySet<GeoJsonEditorSnapMode>;
  sourcePoint: ScreenPoint;
}) {
  let bestTarget: GeoJsonSnapTarget | null = null;

  if (modes.has("vertex")) {
    for (const coordinate of coordinates) {
      bestTarget = getBestTarget(bestTarget, createSnapTarget("vertex", coordinate, sourcePoint, map, featureId));
    }
  }

  if (modes.has("midpoint") || modes.has("segment")) {
    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const start = coordinates[index]!;
      const end = coordinates[index + 1]!;

      if (modes.has("midpoint")) {
        bestTarget = getBestTarget(
          bestTarget,
          createSnapTarget("midpoint", getMidpoint(start, end), sourcePoint, map, featureId),
        );
      }

      if (modes.has("segment")) {
        bestTarget = getBestTarget(
          bestTarget,
          createSegmentSnapTarget(start, end, sourcePoint, map, featureId),
        );
      }
    }
  }

  return bestTarget;
}

function createSegmentSnapTarget(
  start: GeoJsonPosition,
  end: GeoJsonPosition,
  sourcePoint: ScreenPoint,
  map: Pick<FlatMapAdapter, "latLngToContainerPoint">,
  featureId: string | undefined,
): GeoJsonSnapTarget {
  const startPoint = projectCoordinate(map, start);
  const endPoint = projectCoordinate(map, end);
  const deltaX = endPoint.x - startPoint.x;
  const deltaY = endPoint.y - startPoint.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  const ratio = lengthSquared <= 1e-12
    ? 0
    : Math.max(0, Math.min(1, ((sourcePoint.x - startPoint.x) * deltaX + (sourcePoint.y - startPoint.y) * deltaY) / lengthSquared));
  const coordinates: GeoJsonPosition = [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
  const projected = {
    x: startPoint.x + deltaX * ratio,
    y: startPoint.y + deltaY * ratio,
  };

  return {
    coordinates,
    distancePixels: getScreenDistance(sourcePoint, projected),
    featureId,
    mode: "segment",
  };
}

function createSnapTarget(
  mode: "vertex" | "midpoint",
  coordinates: GeoJsonPosition,
  sourcePoint: ScreenPoint,
  map: Pick<FlatMapAdapter, "latLngToContainerPoint">,
  featureId: string | undefined,
): GeoJsonSnapTarget {
  return {
    coordinates: [...coordinates],
    distancePixels: getScreenDistance(sourcePoint, projectCoordinate(map, coordinates)),
    featureId,
    mode,
  };
}

function resolveGridSnapTarget(
  coordinate: GeoJsonPosition,
  map: Pick<FlatMapAdapter, "latLngToContainerPoint">,
  gridSizeDegrees: number,
): GeoJsonSnapTarget | null {
  const gridSize = Number.isFinite(gridSizeDegrees) && gridSizeDegrees > 0 ? gridSizeDegrees : 0.01;
  const snapped: GeoJsonPosition = [
    Math.round(coordinate[0] / gridSize) * gridSize,
    Math.round(coordinate[1] / gridSize) * gridSize,
  ];

  return {
    coordinates: snapped,
    distancePixels: getScreenDistance(projectCoordinate(map, coordinate), projectCoordinate(map, snapped)),
    mode: "grid",
  };
}

function getGeometryCoordinateSequences(
  geometry: TemporalGeoJsonSupportedGeometry,
): GeoJsonPosition[][] {
  switch (geometry.type) {
    case "Point":
      return [[geometry.coordinates]];
    case "MultiPoint":
      return [geometry.coordinates.map(clonePosition)];
    case "LineString":
      return [geometry.coordinates.map(clonePosition)];
    case "MultiLineString":
      return geometry.coordinates.map((line) => line.map(clonePosition));
    case "Polygon":
      return geometry.coordinates.map((ring) => ring.map(clonePosition));
    case "MultiPolygon":
      return geometry.coordinates.flatMap((polygon) => polygon.map((ring) => ring.map(clonePosition)));
  }
}

function getBestTarget(
  current: GeoJsonSnapTarget | null,
  candidate: GeoJsonSnapTarget | null,
) {
  if (!candidate) {
    return current;
  }

  if (!current || candidate.distancePixels < current.distancePixels) {
    return candidate;
  }

  return current;
}

function getMidpoint(start: GeoJsonPosition, end: GeoJsonPosition): GeoJsonPosition {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function clonePosition(position: GeoJsonPosition): GeoJsonPosition {
  return [...position];
}

type ScreenPoint = {
  x: number;
  y: number;
};

function projectCoordinate(
  map: Pick<FlatMapAdapter, "latLngToContainerPoint">,
  coordinate: GeoJsonPosition,
): ScreenPoint {
  return map.latLngToContainerPoint(toLatLng(coordinate));
}

function getScreenDistance(left: ScreenPoint, right: ScreenPoint) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
