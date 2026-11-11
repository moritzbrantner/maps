import type {
  MapsAggregationRuntimeIndex,
  MapsAggregationRuntimeOptions,
  MapsAggregationRuntimePoint,
  MapsAggregationRuntimeResult,
  MapsAggregationWasmRuntime,
} from "./aggregation-runtime";
import type { ViewportAggregationQuery } from "./aggregation";

/** The full renderer module: every core export plus the WebGPU base renderer. */
export const DEFAULT_MAPS_WASM_PACKAGE = "@moritzbrantner/maps/wasm";
/** The WebGPU-free core module (#305): flat runtime, aggregation, temporal points, MVT decode. */
export const DEFAULT_MAPS_WASM_CORE_PACKAGE = "@moritzbrantner/maps/wasm/core";

/**
 * Which Maps WASM module a runtime loader needs. `core` loaders work with either module;
 * only the WebGPU base renderer needs the `renderer` module.
 */
export type MapsWasmCapability = "core" | "renderer";

/**
 * A Maps WASM module location. A string is one module URL (or package specifier) for every
 * loader, which must then be the full renderer module. The object form names the two
 * capability modules separately; an omitted entry keeps its package self-reference.
 */
export type MapsWasmPackage = string | { core?: string; renderer?: string };

let configuredMapsWasmPackage: MapsWasmPackage | undefined;
// Set once a WebGPU Map View is about to load the renderer module, so core loaders share that
// module instead of downloading the core module as well (the WebGPU path must not grow).
let rendererModulePreferred = false;

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

/**
 * Configures where every Maps runtime loader imports its WASM module from. A string keeps the
 * single-module behavior (one full module for all loaders); `{ core, renderer }` lets
 * Canvas2D Map Views and data-only loaders fetch the smaller WebGPU-free core module.
 */
export function configureMapsWasmPackage(packageName?: MapsWasmPackage) {
  configuredMapsWasmPackage = packageName;
}

/** Whether this browser exposes WebGPU, the only backend of the Maps base renderer. */
export function isMapsWebGpuAvailable() {
  return typeof navigator !== "undefined" && (navigator as { gpu?: unknown }).gpu != null;
}

/**
 * Declares that this page loads the full renderer module (a WebGPU Map View). Core loaders
 * resolve to it from then on, so a WebGPU page downloads one module, as before the split.
 */
export function preferMapsWasmRendererModule() {
  rendererModulePreferred = true;
}

export function resetMapsWasmModulesForTests() {
  configuredMapsWasmPackage = undefined;
  rendererModulePreferred = false;
  initializedModules.clear();
}

/**
 * Resolves the module a loader with `capability` imports. Core loaders use the core module
 * unless the renderer module is preferred or already loading on this page; the renderer
 * module carries every core export.
 */
export function resolveMapsWasmModule(
  capability: MapsWasmCapability,
  packageName?: MapsWasmPackage,
): string {
  const configured = packageName ?? configuredMapsWasmPackage;
  if (typeof configured === "string") return configured;

  const renderer = configured?.renderer ?? DEFAULT_MAPS_WASM_PACKAGE;
  if (capability === "renderer" || rendererModulePreferred || initializedModules.has(renderer)) {
    return renderer;
  }
  return configured?.core ?? DEFAULT_MAPS_WASM_CORE_PACKAGE;
}

export async function loadMapsAggregationWasmRuntime(
  packageName?: MapsWasmPackage,
): Promise<MapsAggregationWasmRuntime> {
  const wasmModule = await importMapsWasmModule<MapsAggregationWasmModule>("core", packageName);
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
 * loaders, or one per capability, while published consumers keep the package
 * self-reference defaults. Initialization is shared even while pending; failed
 * attempts can be retried.
 */
export async function importMapsWasmModule<TModule extends MapsWasmModuleBase>(
  capability: MapsWasmCapability,
  packageName?: MapsWasmPackage,
): Promise<TModule> {
  const resolvedPackage = resolveMapsWasmModule(capability, packageName);
  let initialized = initializedModules.get(resolvedPackage);

  if (!initialized) {
    initialized = importMapsWasmSpecifier(resolvedPackage)
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

/**
 * The published defaults are literal package self-references, so consumer bundlers resolve
 * `@moritzbrantner/maps/wasm` and `@moritzbrantner/maps/wasm/core` (and their `.wasm` assets)
 * like any other import, each as its own lazily fetched chunk; a configured module URL stays a
 * runtime import that bundlers leave alone.
 */
function importMapsWasmSpecifier(specifier: string): Promise<MapsWasmModuleBase> {
  if (specifier === DEFAULT_MAPS_WASM_PACKAGE) {
    return import("@moritzbrantner/maps/wasm") as Promise<MapsWasmModuleBase>;
  }
  if (specifier === DEFAULT_MAPS_WASM_CORE_PACKAGE) {
    return import("@moritzbrantner/maps/wasm/core") as Promise<MapsWasmModuleBase>;
  }

  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<MapsWasmModuleBase>;
  return dynamicImport(specifier);
}

function assertLive(disposed: boolean) {
  if (disposed) {
    throw new Error("Maps WASM point aggregation index has been disposed.");
  }
}
