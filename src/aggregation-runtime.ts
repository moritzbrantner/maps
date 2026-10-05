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
let pendingInitialization: Promise<boolean> | null = null;
let runtimeVersion = 0;
const runtimeListeners = new Set<() => void>();

function setWasmRuntime(runtime: MapsAggregationWasmRuntime | null, loadError: unknown) {
  const changed = runtime !== wasmRuntime;

  wasmRuntime = runtime;
  wasmLoadError = loadError;

  if (changed) {
    runtimeVersion += 1;
    for (const listener of runtimeListeners) {
      listener();
    }
  }
}

export function configureMapsAggregationRuntime(options: MapsAggregationLoaderOptions = {}) {
  configuredOptions = {
    ...configuredOptions,
    ...options,
  };
}

export async function initializeMapsAggregationWasm(options: MapsAggregationLoaderOptions = {}) {
  configureMapsAggregationRuntime(options);

  try {
    setWasmRuntime(await loadMapsAggregationWasmRuntime(configuredOptions.wasmPackage), null);
    return true;
  } catch (error) {
    setWasmRuntime(null, error);
    configuredOptions.onDiagnostic?.({
      backend: "wasm",
      fallbackReason: getErrorMessage(error),
      mode: "fallback",
    });
    return false;
  }
}

/**
 * Starts loading the aggregation WASM runtime unless one is installed or loading. Map Views
 * call this on mount; until it loads, indexes are unclustered.
 */
export function ensureMapsAggregationWasm(): Promise<boolean> {
  if (wasmRuntime) {
    return Promise.resolve(true);
  }

  // A failed load is reported once per attempt; a later Map View mount may retry.
  pendingInitialization ??= initializeMapsAggregationWasm().then((ready) => {
    if (!ready) pendingInitialization = null;
    return ready;
  });
  return pendingInitialization;
}

/** Changes whenever the installed aggregation runtime changes, so indexes can be rebuilt. */
export function getMapsAggregationRuntimeVersion() {
  return runtimeVersion;
}

export function subscribeMapsAggregationRuntime(listener: () => void) {
  runtimeListeners.add(listener);
  return () => {
    runtimeListeners.delete(listener);
  };
}

export function resetMapsAggregationRuntimeForTests() {
  configuredOptions = {};
  pendingInitialization = null;
  setWasmRuntime(null, null);
}

export function setMapsAggregationWasmRuntimeForTests(runtime: MapsAggregationWasmRuntime | null) {
  setWasmRuntime(runtime, null);
}

export function getMapsAggregationWasmLoadError() {
  return wasmLoadError;
}

/**
 * Returns the Maps-owned Rust/WASM aggregation index when that runtime has been
 * initialized. A missing runtime is the explicit no-WASM/SSR fallback boundary: it reports a
 * `fallback` diagnostic and the caller returns points unclustered.
 * Once the Rust runtime is selected, construction and query errors fail closed.
 */
export function createMapsAggregationRuntimeIndex(
  points: readonly MapsAggregationRuntimePoint[],
  options: MapsAggregationRuntimeBuildOptions,
): MapsAggregationRuntimeIndex | null {
  if (!wasmRuntime) {
    configuredOptions.onDiagnostic?.({
      backend: "wasm",
      fallbackReason: wasmLoadError
        ? `Maps aggregation WASM runtime failed to load (${getErrorMessage(wasmLoadError)}); points are unclustered.`
        : "Maps aggregation WASM runtime is not initialized; points are unclustered.",
      mode: "fallback",
    });
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
