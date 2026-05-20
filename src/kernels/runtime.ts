import {
  compareFlatKernelOutputs,
  createKernelDiagnostic,
  createKernelFallbackDiagnostic,
  shouldSampleKernelAbTest,
} from "./ab-test";
import { resampleLineFlat, resampleRingFlat } from "./typescript-kernels";
import { loadMapsWasmKernelRuntime } from "./wasm-kernels";

export type MapsKernelBackend = "typescript" | "wasm";
export type MapsKernelBackendPreference = MapsKernelBackend | "auto";
export type MapsKernelName = "resampleLine" | "resampleRing";

export type MapsKernelDiagnostic = {
  backend: MapsKernelBackend;
  coordinateCount: number;
  durationMs: number;
  fallbackReason?: string;
  kernel: MapsKernelName;
  matched?: boolean;
  maxAbsoluteError?: number;
  mode: "control" | "candidate" | "fallback";
};

export type MapsKernelRuntime = {
  backend: MapsKernelBackend;
  resampleLineFlat(coordinates: Float64Array, coordinateCount: number): Float64Array;
  resampleRingFlat(coordinates: Float64Array, coordinateCount: number): Float64Array;
};

export type MapsKernelRuntimeOptions = {
  abTest?: boolean | { sampleRate?: number };
  backend?: MapsKernelBackendPreference;
  onKernelDiagnostic?: (event: MapsKernelDiagnostic) => void;
  wasmPackage?: string;
  wasmThresholdCoordinates?: number;
};

const typescriptRuntime: MapsKernelRuntime = {
  backend: "typescript",
  resampleLineFlat,
  resampleRingFlat,
};

let configuredOptions: MapsKernelRuntimeOptions = {
  backend: "typescript",
  wasmThresholdCoordinates: 512,
};
let wasmRuntime: MapsKernelRuntime | null = null;
let wasmLoadError: unknown = null;
let wasmDisabledForSession = false;

export function configureMapsKernelRuntime(options: MapsKernelRuntimeOptions = {}) {
  configuredOptions = {
    ...configuredOptions,
    ...options,
  };
}

export function resetMapsKernelRuntimeForTests() {
  configuredOptions = {
    backend: "typescript",
    wasmThresholdCoordinates: 512,
  };
  wasmRuntime = null;
  wasmLoadError = null;
  wasmDisabledForSession = false;
}

export function setMapsKernelWasmRuntimeForTests(runtime: MapsKernelRuntime | null) {
  wasmRuntime = runtime;
  wasmLoadError = null;
  wasmDisabledForSession = false;
}

export async function initializeMapsWasmKernels(options: MapsKernelRuntimeOptions = {}) {
  configureMapsKernelRuntime(options);

  try {
    wasmRuntime = await loadMapsWasmKernelRuntime(configuredOptions.wasmPackage);
    wasmLoadError = null;
    return true;
  } catch (error) {
    wasmRuntime = null;
    wasmLoadError = error;
    configuredOptions.onKernelDiagnostic?.(
      createKernelFallbackDiagnostic("resampleLine", 0, getErrorMessage(error)),
    );
    return false;
  }
}

export function getMapsKernelRuntime(): MapsKernelRuntime {
  return {
    backend: getSelectedBackend(0),
    resampleLineFlat(coordinates, coordinateCount) {
      return runFlatKernel("resampleLine", coordinates, coordinateCount);
    },
    resampleRingFlat(coordinates, coordinateCount) {
      return runFlatKernel("resampleRing", coordinates, coordinateCount);
    },
  };
}

function runFlatKernel(
  kernel: MapsKernelName,
  coordinates: Float64Array,
  coordinateCount: number,
) {
  const coordinateInputCount = coordinates.length / 2;
  const controlRun = () =>
    kernel === "resampleLine"
      ? typescriptRuntime.resampleLineFlat(coordinates, coordinateCount)
      : typescriptRuntime.resampleRingFlat(coordinates, coordinateCount);
  const candidateRun = () =>
    kernel === "resampleLine"
      ? wasmRuntime!.resampleLineFlat(coordinates, coordinateCount)
      : wasmRuntime!.resampleRingFlat(coordinates, coordinateCount);

  if (!wasmRuntime || wasmDisabledForSession) {
    if (configuredOptions.backend === "wasm" || configuredOptions.backend === "auto") {
      configuredOptions.onKernelDiagnostic?.(
        createKernelFallbackDiagnostic(
          kernel,
          coordinateInputCount,
          wasmDisabledForSession
            ? "wasm disabled after A/B mismatch"
            : wasmLoadError
              ? getErrorMessage(wasmLoadError)
              : "wasm runtime is not initialized",
        ),
      );
    }

    return measureKernel("typescript", "control", kernel, coordinateInputCount, controlRun);
  }

  const backend = getSelectedBackend(coordinateInputCount);

  if (
    shouldSampleKernelAbTest(configuredOptions.abTest) &&
    coordinateInputCount >= (configuredOptions.wasmThresholdCoordinates ?? 512)
  ) {
    const control = measureKernel(
      "typescript",
      "control",
      kernel,
      coordinateInputCount,
      controlRun,
    );
    const candidate = measureKernel(
      "wasm",
      "candidate",
      kernel,
      coordinateInputCount,
      candidateRun,
    );
    const comparison = compareFlatKernelOutputs(control, candidate);

    configuredOptions.onKernelDiagnostic?.(
      createKernelDiagnostic({
        backend: "wasm",
        coordinateCount: coordinateInputCount,
        durationMs: 0,
        kernel,
        matched: comparison.matched,
        maxAbsoluteError: comparison.maxAbsoluteError,
        mode: "candidate",
      }),
    );

    if (!comparison.matched) {
      wasmDisabledForSession = true;
    }

    return control;
  }

  if (backend === "wasm") {
    return measureKernel("wasm", "candidate", kernel, coordinateInputCount, candidateRun);
  }

  return measureKernel("typescript", "control", kernel, coordinateInputCount, controlRun);
}

function getSelectedBackend(coordinateCount: number): MapsKernelBackend {
  if (
    configuredOptions.backend === "wasm" ||
    (configuredOptions.backend === "auto" &&
      wasmRuntime &&
      !wasmDisabledForSession &&
      coordinateCount >= (configuredOptions.wasmThresholdCoordinates ?? 512))
  ) {
    return "wasm";
  }

  return "typescript";
}

function measureKernel(
  backend: MapsKernelBackend,
  mode: "control" | "candidate",
  kernel: MapsKernelName,
  coordinateCount: number,
  run: () => Float64Array,
) {
  const startedAt = performance.now();
  const result = run();
  const durationMs = performance.now() - startedAt;

  configuredOptions.onKernelDiagnostic?.(
    createKernelDiagnostic({
      backend,
      coordinateCount,
      durationMs,
      kernel,
      mode,
    }),
  );

  return result;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
