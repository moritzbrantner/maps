import type {
  IndexedMapPoint,
  MapMetricRecord,
  PointAggregationIndexOptions,
  ViewportAggregation,
  ViewportAggregationQuery,
} from "./aggregation";
import { loadMapsAggregationWasmRuntime } from "./aggregation-wasm";

export type MapsAggregationCandidatePoint = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  metrics: MapMetricRecord;
};

export type MapsAggregationCandidateOptions = {
  extent: number;
  maxZoom: number;
  minZoom: number;
  radius: number;
};

export type MapsAggregationCandidateFeature =
  | {
      coordinates: [number, number];
      kind: "point";
      metrics: MapMetricRecord;
      pointId: string;
    }
  | {
      clusterId: number;
      coordinates: [number, number];
      expansionZoom: number;
      kind: "cluster";
      metrics: MapMetricRecord;
      pointCount: number;
      pointCountAbbreviated: string;
    };

export type MapsAggregationCandidateResult = {
  features: MapsAggregationCandidateFeature[];
  summary: {
    bounds: ViewportAggregationQuery["bounds"];
    metrics: MapMetricRecord;
    visibleClusterCount: number;
    visiblePointCount: number;
    visibleUnclusteredCount: number;
    zoom: number;
  };
};

export type MapsAggregationCandidateIndex = {
  dispose(): void;
  getClusterExpansionZoom(clusterId: number): number;
  getClusterLeaves(clusterId: number, limit?: number, offset?: number): MapsAggregationCandidatePoint[];
  getPointById(pointId: string): MapsAggregationCandidatePoint | null;
  getViewportAggregation(query: ViewportAggregationQuery): MapsAggregationCandidateResult;
};

export type MapsAggregationWasmRuntime = {
  createIndex(
    points: readonly MapsAggregationCandidatePoint[],
    options: MapsAggregationCandidateOptions,
  ): MapsAggregationCandidateIndex;
};

export type MapsAggregationDiagnostic = {
  backend: "wasm";
  candidateFeatureCount?: number;
  controlFeatureCount?: number;
  fallbackReason?: string;
  matched?: boolean;
  mode: "candidate" | "fallback";
};

export type MapsAggregationRuntimeOptions = {
  onDiagnostic?: (event: MapsAggregationDiagnostic) => void;
  wasmPackage?: string;
};

let configuredOptions: MapsAggregationRuntimeOptions = {};
let wasmRuntime: MapsAggregationWasmRuntime | null = null;
let wasmLoadError: unknown = null;
let wasmDisabledForSession = false;

export function configureMapsAggregationRuntime(options: MapsAggregationRuntimeOptions = {}) {
  configuredOptions = {
    ...configuredOptions,
    ...options,
  };
}

export async function initializeMapsAggregationWasm(options: MapsAggregationRuntimeOptions = {}) {
  configureMapsAggregationRuntime(options);

  try {
    wasmRuntime = await loadMapsAggregationWasmRuntime(configuredOptions.wasmPackage);
    wasmLoadError = null;
    wasmDisabledForSession = false;
    return true;
  } catch (error) {
    wasmRuntime = null;
    wasmLoadError = error;
    configuredOptions.onDiagnostic?.({
      backend: "wasm",
      fallbackReason: getErrorMessage(error),
      mode: "fallback",
    });
    return false;
  }
}

export function resetMapsAggregationRuntimeForTests() {
  configuredOptions = {};
  wasmRuntime = null;
  wasmLoadError = null;
  wasmDisabledForSession = false;
}

export function setMapsAggregationWasmRuntimeForTests(runtime: MapsAggregationWasmRuntime | null) {
  wasmRuntime = runtime;
  wasmLoadError = null;
  wasmDisabledForSession = false;
}

export function getMapsAggregationWasmLoadError() {
  return wasmLoadError;
}

export function createMapsAggregationCandidateIndex<TProperties>(
  points: readonly IndexedMapPoint<TProperties>[],
  options: PointAggregationIndexOptions<TProperties>,
): MapsAggregationCandidateIndex | null {
  if (!wasmRuntime || wasmDisabledForSession) {
    return null;
  }

  try {
    return wasmRuntime.createIndex(
      points.map((point) => ({
        id: point.id,
        label: point.label,
        latitude: point.latitude,
        longitude: point.longitude,
        metrics: point.metrics,
      })),
      {
        extent: options.extent ?? 512,
        maxZoom: options.maxZoom ?? 16,
        minZoom: options.minZoom ?? 0,
        radius: options.radius ?? 72,
      },
    );
  } catch (error) {
    disableCandidate(error);
    return null;
  }
}

export function compareMapsAggregationCandidate<TProperties>(
  candidate: MapsAggregationCandidateIndex | null,
  query: ViewportAggregationQuery,
  control: ViewportAggregation<TProperties>,
) {
  if (!candidate || wasmDisabledForSession) {
    return;
  }

  try {
    const candidateResult = candidate.getViewportAggregation(query);
    const matched = aggregationSemanticsMatch(control, candidateResult);

    configuredOptions.onDiagnostic?.({
      backend: "wasm",
      candidateFeatureCount: candidateResult.features.length,
      controlFeatureCount: control.features.length,
      matched,
      mode: "candidate",
    });

    if (!matched) {
      candidate.dispose();
      disableCandidate("WASM aggregation candidate did not match the Supercluster control");
    }
  } catch (error) {
    candidate.dispose();
    disableCandidate(error);
  }
}

function disableCandidate(error: unknown) {
  wasmDisabledForSession = true;
  configuredOptions.onDiagnostic?.({
    backend: "wasm",
    fallbackReason: getErrorMessage(error),
    mode: "fallback",
  });
}

function aggregationSemanticsMatch<TProperties>(
  control: ViewportAggregation<TProperties>,
  candidate: MapsAggregationCandidateResult,
) {
  const controlFeatures = control.features.map(toComparableControlFeature).sort(compareComparable);
  const candidateFeatures = candidate.features.map(toComparableCandidateFeature).sort(compareComparable);

  if (controlFeatures.length !== candidateFeatures.length) {
    return false;
  }

  return controlFeatures.every((feature, index) => {
    const candidateFeature = candidateFeatures[index];

    return (
      feature.key === candidateFeature.key &&
      nearlyEqual(feature.longitude, candidateFeature.longitude) &&
      nearlyEqual(feature.latitude, candidateFeature.latitude) &&
      metricsMatch(feature.metrics, candidateFeature.metrics)
    );
  });
}

type ComparableFeature = {
  key: string;
  latitude: number;
  longitude: number;
  metrics: MapMetricRecord;
};

function toComparableControlFeature<TProperties>(
  feature: ViewportAggregation<TProperties>["features"][number],
): ComparableFeature {
  if (feature.kind === "point") {
    return {
      key: `point:${feature.point.id}`,
      latitude: feature.coordinates[1],
      longitude: feature.coordinates[0],
      metrics: feature.metrics,
    };
  }

  return {
    key: `cluster:${feature.pointCount}`,
    latitude: feature.coordinates[1],
    longitude: feature.coordinates[0],
    metrics: feature.metrics,
  };
}

function toComparableCandidateFeature(feature: MapsAggregationCandidateFeature): ComparableFeature {
  if (feature.kind === "point") {
    return {
      key: `point:${feature.pointId}`,
      latitude: feature.coordinates[1],
      longitude: feature.coordinates[0],
      metrics: feature.metrics,
    };
  }

  return {
    key: `cluster:${feature.pointCount}`,
    latitude: feature.coordinates[1],
    longitude: feature.coordinates[0],
    metrics: feature.metrics,
  };
}

function compareComparable(left: ComparableFeature, right: ComparableFeature) {
  return (
    left.key.localeCompare(right.key) ||
    left.longitude - right.longitude ||
    left.latitude - right.latitude
  );
}

function metricsMatch(left: MapMetricRecord, right: MapMetricRecord) {
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();

  return keys.every((key) => nearlyEqual(left[key] ?? 0, right[key] ?? 0));
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 1e-6;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
