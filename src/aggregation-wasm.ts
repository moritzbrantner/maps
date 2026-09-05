import type {
  MapsAggregationCandidateResult,
  MapsAggregationCandidateOptions,
  MapsAggregationCandidatePoint,
  MapsAggregationWasmRuntime,
} from "./aggregation-runtime";
import type { ViewportAggregationQuery } from "./aggregation";

type MapsAggregationWasmModule = {
  aggregateViewport: (
    points: readonly MapsAggregationCandidatePoint[],
    query: ViewportAggregationQuery,
    options: MapsAggregationCandidateOptions,
  ) => MapsAggregationCandidateResult;
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
};

export async function loadMapsAggregationWasmRuntime(
  packageName?: string,
): Promise<MapsAggregationWasmRuntime> {
  if (!packageName) {
    throw new Error("No public Maps WASM package configured.");
  }

  const wasmModule = await importOptionalWasmModule(packageName);
  await wasmModule.default?.();

  return {
    aggregateViewport(points, query, options) {
      return wasmModule.aggregateViewport(points, query, options);
    },
  };
}

async function importOptionalWasmModule(packageName: string): Promise<MapsAggregationWasmModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<MapsAggregationWasmModule>;

  return dynamicImport(packageName);
}
