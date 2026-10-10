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

/**
 * Where the Rust/WASM aggregation runtime stands:
 *
 * - `idle`: nothing has asked for it yet (also the SSR state);
 * - `loading`: a Map View (or `ensureMapsAggregationWasm`) started loading it;
 * - `ready`: Rust is the clustering authority;
 * - `unavailable`: loading failed, so indexes use the explicit unclustered fallback.
 *
 * `idle` and `loading` are *pending*: Map Layers render no aggregated output yet rather than
 * every point individually, and rebuild once the status settles on `ready` or `unavailable`.
 */
export type MapsAggregationRuntimeStatus = "idle" | "loading" | "ready" | "unavailable";

let configuredOptions: MapsAggregationLoaderOptions = {};
let wasmRuntime: MapsAggregationWasmRuntime | null = null;
let wasmLoadError: unknown = null;
let pendingInitialization: Promise<boolean> | null = null;
let runtimeStatus: MapsAggregationRuntimeStatus = "idle";
let runtimeVersion = 0;
// Bumped whenever the runtime is installed or reset directly, so a load started before that
// cannot overwrite it when it settles.
let installEpoch = 0;
// Every load attempt (from `ensureMapsAggregationWasm` or a direct
// `initializeMapsAggregationWasm` call) gets its own ordering token.
let latestLoadAttempt = 0;
// The attempt whose runtime is installed, so an older attempt cannot replace a newer one.
let installedLoadAttempt = 0;
const runtimeListeners = new Set<() => void>();

function setWasmRuntime(runtime: MapsAggregationWasmRuntime | null, loadError: unknown) {
  setRuntimeState(
    runtime,
    loadError,
    runtime ? "ready" : loadError === null ? "idle" : "unavailable",
  );
}

function setRuntimeState(
  runtime: MapsAggregationWasmRuntime | null,
  loadError: unknown,
  status: MapsAggregationRuntimeStatus,
) {
  const changed = runtime !== wasmRuntime || status !== runtimeStatus;

  wasmRuntime = runtime;
  wasmLoadError = loadError;
  runtimeStatus = status;

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

/**
 * Loads the aggregation WASM runtime and resolves to whether Rust clustering is available.
 * Each call is its own load attempt with its own ordering token: a successful attempt installs
 * its runtime unless a newer attempt already did (or the runtime was installed or reset
 * directly since it started), and a failed attempt never replaces an installed runtime and
 * reports `unavailable` only when it is the newest attempt. `ensureMapsAggregationWasm` reuses
 * the attempt in flight.
 */
export function initializeMapsAggregationWasm(
  options: MapsAggregationLoaderOptions = {},
): Promise<boolean> {
  configureMapsAggregationRuntime(options);
  const attempt = ++latestLoadAttempt;
  const epoch = installEpoch;

  // A first load is pending; a retry after a failure keeps the explicit fallback in place
  // instead of flickering Map Layers back to the pending state.
  if (runtimeStatus === "idle") {
    setRuntimeState(wasmRuntime, wasmLoadError, "loading");
  }

  const initialization = loadMapsAggregationWasmRuntime(configuredOptions.wasmPackage).then(
    (runtime) => {
      if (epoch !== installEpoch) return wasmRuntime !== null;
      if (wasmRuntime && installedLoadAttempt > attempt) return true;
      installedLoadAttempt = attempt;
      setWasmRuntime(runtime, null);
      return true;
    },
    (error: unknown) => {
      if (epoch !== installEpoch || wasmRuntime) return wasmRuntime !== null;
      configuredOptions.onDiagnostic?.({
        backend: "wasm",
        fallbackReason: getErrorMessage(error),
        mode: "fallback",
      });
      // A newer attempt is still in flight or already settled; it decides the status.
      if (attempt === latestLoadAttempt) setWasmRuntime(null, error);
      return false;
    },
  );
  const owned: Promise<boolean> = initialization.finally(() => {
    // Settled attempts never block a later `ensureMapsAggregationWasm` retry.
    if (pendingInitialization === owned) pendingInitialization = null;
  });

  pendingInitialization = owned;
  return owned;
}

/**
 * Starts loading the aggregation WASM runtime unless one is installed or loading, and resolves
 * to whether Rust clustering is available. Map Views call this on mount; consumers may await it
 * to sequence work after the runtime. While it loads, Map Layers stay pending (no aggregated
 * output); `createPointAggregationIndex` called directly in that window returns the unclustered
 * fallback. After a failed load, a later call retries.
 */
export function ensureMapsAggregationWasm(): Promise<boolean> {
  if (wasmRuntime) {
    return Promise.resolve(true);
  }

  return pendingInitialization ?? initializeMapsAggregationWasm();
}

/**
 * Changes whenever the installed aggregation runtime or its status changes, so indexes can be
 * rebuilt.
 */
export function getMapsAggregationRuntimeVersion() {
  return runtimeVersion;
}

export function getMapsAggregationRuntimeStatus(): MapsAggregationRuntimeStatus {
  return runtimeStatus;
}

/**
 * True while no aggregation authority is settled (`idle` or `loading`). Map Layers render no
 * aggregated output in this state instead of drawing a dense dataset point by point.
 */
export function isMapsAggregationRuntimePending(
  status: MapsAggregationRuntimeStatus = runtimeStatus,
) {
  return status === "idle" || status === "loading";
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
  installEpoch += 1;
  setWasmRuntime(null, null);
}

/**
 * Installs (or removes) a runtime directly. `null` reports the runtime as `unavailable`, the
 * explicit unclustered fallback, so tests can exercise that path deterministically.
 */
export function setMapsAggregationWasmRuntimeForTests(runtime: MapsAggregationWasmRuntime | null) {
  pendingInitialization = null;
  installEpoch += 1;
  setRuntimeState(runtime, null, runtime ? "ready" : "unavailable");
}

export function getMapsAggregationWasmLoadError() {
  return wasmLoadError;
}

/**
 * Returns the Maps-owned Rust/WASM aggregation index when that runtime has been
 * initialized. A missing runtime is the explicit no-WASM/SSR fallback boundary: it reports a
 * `fallback` diagnostic and the caller returns points unclustered. Map Layers do not reach this
 * boundary while the runtime is pending (see `isMapsAggregationRuntimePending`).
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
