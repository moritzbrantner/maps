import type {
  MapsAggregationRuntimeIndex,
  MapsAggregationRuntimeOptions,
  MapsAggregationRuntimePoint,
  MapsAggregationRuntimeResult,
  MapsAggregationWasmRuntime,
} from "./aggregation-runtime";
import type { ViewportAggregationQuery } from "./aggregation";

export const DEFAULT_MAPS_WASM_PACKAGE = "@moritzbrantner/maps/wasm";

let configuredMapsWasmPackage: string | undefined;

export type MapsWasmModuleBase = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
};

const initializedModules = new Map<string, Promise<MapsWasmModuleBase>>();

type MapsAggregationWasmIndex = {
  free?: () => void;
  getClusterExpansionZoom(clusterId: number): number;
  getClusterLeaves(clusterId: number, limit: number, offset: number): MapsAggregationRuntimePoint[];
  getPointById(pointId: string): MapsAggregationRuntimePoint | null;
  getViewportAggregation(query: ViewportAggregationQuery): MapsAggregationRuntimeResult;
};

type MapsAggregationWasmIndexConstructor = new (
  points: readonly MapsAggregationRuntimePoint[],
  options: MapsAggregationRuntimeOptions,
) => MapsAggregationWasmIndex;

type MapsAggregationWasmModule = MapsWasmModuleBase & {
  MapsPointAggregationIndex?: MapsAggregationWasmIndexConstructor;
};

export function configureMapsWasmPackage(packageName?: string) {
  configuredMapsWasmPackage = packageName;
}

export async function loadMapsAggregationWasmRuntime(
  packageName?: string,
): Promise<MapsAggregationWasmRuntime> {
  const wasmModule = await importMapsWasmModule<MapsAggregationWasmModule>(packageName);
  const Constructor = wasmModule.MapsPointAggregationIndex;

  if (!Constructor) {
    throw new Error("Maps WASM point aggregation index is unavailable.");
  }

  return {
    createIndex(points, options): MapsAggregationRuntimeIndex {
      const index = new Constructor(points, options);
      let disposed = false;

      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          index.free?.();
        },
        getClusterExpansionZoom(clusterId) {
          assertLive(disposed);
          return index.getClusterExpansionZoom(clusterId);
        },
        getClusterLeaves(clusterId, limit = 10, offset = 0) {
          assertLive(disposed);
          return index.getClusterLeaves(clusterId, limit, offset);
        },
        getPointById(pointId) {
          assertLive(disposed);
          return index.getPointById(pointId);
        },
        getViewportAggregation(query) {
          assertLive(disposed);
          return index.getViewportAggregation(query);
        },
      };
    },
  };
}

/**
 * Single reviewed dynamic-import boundary for the version-matched Maps WASM
 * package. Runtime-specific loaders reuse this function instead of creating
 * additional constructor-based import sites or independent package resolution.
 * Hosted applications can configure one exact module URL for all Maps runtime
 * loaders while published consumers keep the package self-reference default.
 * Initialization is shared even while pending; failed attempts can be retried.
 */
export async function importMapsWasmModule<TModule extends MapsWasmModuleBase>(
  packageName?: string,
): Promise<TModule> {
  const resolvedPackage = packageName ?? configuredMapsWasmPackage ?? DEFAULT_MAPS_WASM_PACKAGE;
  let initialized = initializedModules.get(resolvedPackage);

  if (!initialized) {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<MapsWasmModuleBase>;
    initialized = dynamicImport(resolvedPackage)
      .then(async (module) => {
        await module.default?.();
        return module;
      })
      .catch((error: unknown) => {
        initializedModules.delete(resolvedPackage);
        throw error;
      });
    initializedModules.set(resolvedPackage, initialized);
  }

  // Each runtime loader validates the capability it needs on this module.
  return (await initialized) as TModule;
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps WASM point aggregation index has been disposed.");
  }
}
