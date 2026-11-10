import { importMapsWasmModule, type MapsWasmModuleBase } from "./aggregation-wasm";

/**
 * A Rust/WASM moving point track index (#172). Keyframes cross the boundary once, packed as
 * `[time, longitude, latitude, visible]`; each sample returns
 * `[kind, previous, next, progress, longitude, latitude]` per track, where kind `0` is absent,
 * `1` a keyframe and `2` an interpolated position, and `previous`/`next` are supplied keyframe
 * numbers.
 */
export type MapsTemporalPointWasmIndex = {
  free?: () => void;
  sample(time: number): Float64Array;
  timeRange(): Float64Array;
};

export type MapsTemporalWasmRuntime = {
  createPointIndex(keyframes: Float64Array, frameCounts: Uint32Array): MapsTemporalPointWasmIndex;
};

/**
 * Where the Rust/WASM temporal runtime stands. Until it is `ready` (and for good once it is
 * `unavailable`, or during SSR) temporal playback indexes use the TypeScript reference
 * implementation, which samples identical positions.
 */
export type MapsTemporalRuntimeStatus = "idle" | "loading" | "ready" | "unavailable";

type MapsTemporalWasmModule = MapsWasmModuleBase & {
  MapsTemporalPointIndex?: new (
    keyframes: Float64Array,
    frameCounts: Uint32Array,
  ) => MapsTemporalPointWasmIndex;
};

let temporalRuntime: MapsTemporalWasmRuntime | null = null;
let temporalStatus: MapsTemporalRuntimeStatus = "idle";
let temporalVersion = 0;
let pendingInitialization: Promise<boolean> | null = null;
// Bumped whenever the runtime is installed or reset directly, so a load started before that
// cannot overwrite it when it settles.
let installEpoch = 0;
let latestLoadAttempt = 0;
let installedLoadAttempt = 0;
const listeners = new Set<() => void>();

function setTemporalRuntimeState(
  runtime: MapsTemporalWasmRuntime | null,
  status: MapsTemporalRuntimeStatus,
) {
  if (runtime === temporalRuntime && status === temporalStatus) return;

  temporalRuntime = runtime;
  temporalStatus = status;
  temporalVersion += 1;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Loads the Rust/WASM temporal runtime from the configured Maps WASM package and resolves to
 * whether Rust samples moving point tracks. Each call is its own attempt: an older attempt never
 * replaces a newer installed runtime, and a failure never replaces an installed one.
 */
export function initializeMapsTemporalWasm(packageName?: string): Promise<boolean> {
  const attempt = ++latestLoadAttempt;
  const epoch = installEpoch;

  if (temporalStatus === "idle") {
    setTemporalRuntimeState(temporalRuntime, "loading");
  }

  const initialization = importMapsWasmModule<MapsTemporalWasmModule>(packageName).then(
    (wasmModule) => {
      const Constructor = wasmModule.MapsTemporalPointIndex;

      if (!Constructor) {
        throw new Error("Maps WASM temporal point index is unavailable.");
      }

      if (epoch !== installEpoch) return temporalRuntime !== null;
      if (temporalRuntime && installedLoadAttempt > attempt) return true;
      installedLoadAttempt = attempt;
      setTemporalRuntimeState(
        { createPointIndex: (keyframes, frameCounts) => new Constructor(keyframes, frameCounts) },
        "ready",
      );
      return true;
    },
  ).catch(() => {
    if (epoch !== installEpoch || temporalRuntime) return temporalRuntime !== null;
    if (attempt === latestLoadAttempt) setTemporalRuntimeState(null, "unavailable");
    return false;
  });
  const owned: Promise<boolean> = initialization.finally(() => {
    if (pendingInitialization === owned) pendingInitialization = null;
  });

  pendingInitialization = owned;
  return owned;
}

/**
 * Starts loading the Rust/WASM temporal runtime unless it is installed or loading. Temporal
 * Convenience Maps call this on mount and rebuild their playback index once it settles.
 */
export function ensureMapsTemporalWasm(): Promise<boolean> {
  if (temporalRuntime) return Promise.resolve(true);
  return pendingInitialization ?? initializeMapsTemporalWasm();
}

export function getMapsTemporalRuntimeStatus(): MapsTemporalRuntimeStatus {
  return temporalStatus;
}

/** Changes whenever the installed temporal runtime or its status changes. */
export function getMapsTemporalRuntimeVersion() {
  return temporalVersion;
}

export function subscribeMapsTemporalRuntime(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @internal The installed runtime, or `null` for the TypeScript reference implementation. */
export function getMapsTemporalWasmRuntime() {
  return temporalRuntime;
}

/** Installs (or, with `null`, removes as `unavailable`) a runtime directly. */
export function setMapsTemporalWasmRuntimeForTests(runtime: MapsTemporalWasmRuntime | null) {
  pendingInitialization = null;
  installEpoch += 1;
  setTemporalRuntimeState(runtime, runtime ? "ready" : "unavailable");
}

export function resetMapsTemporalWasmRuntimeForTests() {
  pendingInitialization = null;
  installEpoch += 1;
  setTemporalRuntimeState(null, "idle");
}
