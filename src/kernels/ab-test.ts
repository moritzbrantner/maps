import type { MapsKernelDiagnostic, MapsKernelName } from "./runtime";

export const MAPS_KERNEL_AB_TOLERANCE = 1e-9;

export function shouldSampleKernelAbTest(
  abTest: boolean | { sampleRate?: number } | undefined,
  random = Math.random,
) {
  if (!abTest) {
    return false;
  }

  if (abTest === true) {
    return true;
  }

  const sampleRate = Math.min(Math.max(abTest.sampleRate ?? 1, 0), 1);

  return random() < sampleRate;
}

export function compareFlatKernelOutputs(
  control: Float64Array,
  candidate: Float64Array,
  tolerance = MAPS_KERNEL_AB_TOLERANCE,
) {
  if (control.length !== candidate.length) {
    return {
      matched: false,
      maxAbsoluteError: Number.POSITIVE_INFINITY,
    };
  }

  let maxAbsoluteError = 0;

  for (let index = 0; index < control.length; index += 1) {
    maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(control[index]! - candidate[index]!));
  }

  return {
    matched: maxAbsoluteError <= tolerance,
    maxAbsoluteError,
  };
}

export function createKernelDiagnostic(
  event: MapsKernelDiagnostic,
): MapsKernelDiagnostic {
  return event;
}

export function createKernelFallbackDiagnostic(
  kernel: MapsKernelName,
  coordinateCount: number,
  fallbackReason: string,
): MapsKernelDiagnostic {
  return {
    backend: "wasm",
    coordinateCount,
    durationMs: 0,
    fallbackReason,
    kernel,
    mode: "fallback",
  };
}
