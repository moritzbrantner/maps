import type {
  MapsAggregationRuntimeIndex,
  MapsAggregationRuntimeOptions,
  MapsAggregationRuntimePoint,
  MapsAggregationRuntimeResult,
  MapsAggregationWasmRuntime,
} from "./aggregation-runtime";
import type { ViewportAggregationQuery } from "./aggregation";

const DEFAULT_MAPS_WASM_PACKAGE = "@moritzbrantner/maps/wasm";

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

type MapsAggregationWasmModule = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  MapsPointAggregationIndex?: MapsAggregationWasmIndexConstructor;
};

export async function loadMapsAggregationWasmRuntime(
  packageName = DEFAULT_MAPS_WASM_PACKAGE,
): Promise<MapsAggregationWasmRuntime> {
  const wasmModule = await importOptionalWasmModule(packageName);
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

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps WASM point aggregation index has been disposed.");
  }
}

async function importOptionalWasmModule(packageName: string): Promise<MapsAggregationWasmModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<MapsAggregationWasmModule>;

  return dynamicImport(packageName);
}
