import type {
  MapsAggregationRuntimeIndex,
  MapsAggregationRuntimeOptions,
  MapsAggregationRuntimePoint,
  MapsAggregationRuntimeResult,
  MapsAggregationWasmRuntime,
} from "./aggregation-runtime";
import type { ViewportAggregationQuery } from "./aggregation";

export const DEFAULT_MAPS_WASM_PACKAGE = "@moritzbrantner/maps/wasm";

export type MapsWasmModuleBase = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
};

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

export async function loadMapsAggregationWasmRuntime(
  packageName = DEFAULT_MAPS_WASM_PACKAGE,
): Promise<MapsAggregationWasmRuntime> {
  const wasmModule = await importMapsWasmModule<MapsAggregationWasmModule>(packageName);
  await wasmModule.default?.();
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
 */
export async function importMapsWasmModule<TModule extends MapsWasmModuleBase>(
  packageName = DEFAULT_MAPS_WASM_PACKAGE,
): Promise<TModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<TModule>;

  return dynamicImport(packageName);
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps WASM point aggregation index has been disposed.");
  }
}
