import type {
  MapMetricRecord,
  PointAggregationIndexOptions,
  ViewportAggregationQuery,
} from "./aggregation";
import { loadMapsAggregationWasmRuntime } from "./aggregation-wasm";

export type MapsAggregationRuntimePoint = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  metrics: MapMetricRecord;
};

export type MapsAggregationRuntimeOptions = {
  extent: number;
  maxZoom: number;
  minZoom: number;
  radius: number;
};

type MapsAggregationRuntimeBuildOptions = Pick<
  PointAggregationIndexOptions,
  "extent" | "maxZoom" | "minZoom" | "radius"
>;

export type MapsAggregationRuntimeFeature =
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

export type MapsAggregationRuntimeResult = {
  features: MapsAggregationRuntimeFeature[];
  summary: {
    bounds: ViewportAggregationQuery["bounds"];
    metrics: MapMetricRecord;
    visibleClusterCount: number;
    visiblePointCount: number;
    visibleUnclusteredCount: number;
    zoom: number;
  };
};

export type MapsAggregationRuntimeIndex = {
  dispose(): void;
  getClusterExpansionZoom(clusterId: number): number;
  getClusterLeaves(clusterId: number, limit?: number, offset?: number): MapsAggregationRuntimePoint[];
  getPointById(pointId: string): MapsAggregationRuntimePoint | null;
  getViewportAggregation(query: ViewportAggregationQuery): MapsAggregationRuntimeResult;
};

export type MapsAggregationWasmRuntime = {
  createIndex(
    points: readonly MapsAggregationRuntimePoint[],
    options: MapsAggregationRuntimeOptions,
  ): MapsAggregationRuntimeIndex;
};

export type MapsAggregationDiagnostic = {
  backend: "wasm";
  fallbackReason?: string;
  featureCount?: number;
  mode: "authoritative" | "error" | "fallback";
};

export type MapsAggregationLoaderOptions = {
  onDiagnostic?: (event: MapsAggregationDiagnostic) => void;
  wasmPackage?: string;
};

let configuredOptions: MapsAggregationLoaderOptions = {};
let wasmRuntime: MapsAggregationWasmRuntime | null = null;
let wasmLoadError: unknown = null;

export function configureMapsAggregationRuntime(options: MapsAggregationLoaderOptions = {}) {
  configuredOptions = {
    ...configuredOptions,
    ...options,
  };
}

export async function initializeMapsAggregationWasm(options: MapsAggregationLoaderOptions = {}) {
  configureMapsAggregationRuntime(options);

  try {
    wasmRuntime = await loadMapsAggregationWasmRuntime(configuredOptions.wasmPackage);
    wasmLoadError = null;
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
}

export function setMapsAggregationWasmRuntimeForTests(runtime: MapsAggregationWasmRuntime | null) {
  wasmRuntime = runtime;
  wasmLoadError = null;
}

export function getMapsAggregationWasmLoadError() {
  return wasmLoadError;
}

/**
 * Returns the Maps-owned Rust/WASM aggregation index when that runtime has been
 * initialized. A missing runtime is the explicit no-WASM/SSR fallback boundary.
 * Once the Rust runtime is selected, construction and query errors fail closed.
 */
export function createMapsAggregationRuntimeIndex(
  points: readonly MapsAggregationRuntimePoint[],
  options: MapsAggregationRuntimeBuildOptions,
): MapsAggregationRuntimeIndex | null {
  if (!wasmRuntime) {
    return null;
  }

  const index = runAuthoritative(() =>
    wasmRuntime!.createIndex(
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
    ),
  );

  configuredOptions.onDiagnostic?.({
    backend: "wasm",
    mode: "authoritative",
  });

  return {
    dispose() {
      runAuthoritative(() => index.dispose());
    },
    getClusterExpansionZoom(clusterId) {
      return runAuthoritative(() => index.getClusterExpansionZoom(clusterId));
    },
    getClusterLeaves(clusterId, limit = 10, offset = 0) {
      return runAuthoritative(() => index.getClusterLeaves(clusterId, limit, offset));
    },
    getPointById(pointId) {
      return runAuthoritative(() => index.getPointById(pointId));
    },
    getViewportAggregation(query) {
      const result = runAuthoritative(() => index.getViewportAggregation(query));

      configuredOptions.onDiagnostic?.({
        backend: "wasm",
        featureCount: result.features.length,
        mode: "authoritative",
      });
      return result;
    },
  };
}

function runAuthoritative<TResult>(operation: () => TResult): TResult {
  try {
    return operation();
  } catch (error) {
    configuredOptions.onDiagnostic?.({
      backend: "wasm",
      fallbackReason: getErrorMessage(error),
      mode: "error",
    });
    throw error;
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
