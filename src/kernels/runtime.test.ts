import { afterEach, describe, expect, test } from "vitest";

import {
  configureMapsKernelRuntime,
  getMapsKernelRuntime,
  initializeMapsWasmKernels,
  resetMapsKernelRuntimeForTests,
  setMapsKernelWasmRuntimeForTests,
  type MapsKernelDiagnostic,
} from "./runtime";
import { resampleLineFlat, resampleRingFlat } from "./typescript-kernels";

describe("@moritzbrantner/maps kernel runtime", () => {
  afterEach(() => {
    resetMapsKernelRuntimeForTests();
  });

  test("resamples lines and rings with the TypeScript backend", () => {
    expect(Array.from(resampleLineFlat(new Float64Array([0, 0, 10, 0]), 3))).toEqual([
      0, 0, 5, 0, 10, 0,
    ]);
    expect(Array.from(resampleRingFlat(new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]), 4))).toEqual([
      0, 0, 10, 0, 10, 10, 0, 10,
    ]);
  });

  test("falls back to TypeScript when the optional WASM package is unavailable", async () => {
    const diagnostics: MapsKernelDiagnostic[] = [];
    const initialized = await initializeMapsWasmKernels({
      backend: "wasm",
      onKernelDiagnostic(event) {
        diagnostics.push(event);
      },
    });
    const output = getMapsKernelRuntime().resampleLineFlat(new Float64Array([0, 0, 10, 0]), 3);

    expect(initialized).toBe(false);
    expect(Array.from(output)).toEqual([0, 0, 5, 0, 10, 0]);
    expect(diagnostics.some((event) => event.mode === "fallback")).toBe(true);
  });

  test("includes a clear fallback reason when WASM initialization fails", async () => {
    const diagnostics: MapsKernelDiagnostic[] = [];
    const initialized = await initializeMapsWasmKernels({
      backend: "wasm",
      onKernelDiagnostic(event) {
        diagnostics.push(event);
      },
      wasmPackage: "missing-package",
    });

    expect(initialized).toBe(false);
    const initializationFallback = diagnostics.find((event) => event.mode === "fallback");

    expect(initializationFallback?.fallbackReason).toEqual(expect.any(String));
    expect(initializationFallback?.fallbackReason).not.toBe("wasm runtime is not initialized");

    const output = getMapsKernelRuntime().resampleRingFlat(
      new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
      4,
    );

    expect(Array.from(output)).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    const ringFallback = diagnostics.find(
      (event) => event.kernel === "resampleRing" && event.mode === "fallback",
    );

    expect(ringFallback?.fallbackReason).toBe(initializationFallback?.fallbackReason);
  });

  test("repeated failed WASM initialization keeps TypeScript kernels available", async () => {
    expect(await initializeMapsWasmKernels({ backend: "wasm", wasmPackage: "missing-package" })).toBe(
      false,
    );
    expect(await initializeMapsWasmKernels({ backend: "wasm", wasmPackage: "missing-package" })).toBe(
      false,
    );

    const output = getMapsKernelRuntime().resampleLineFlat(new Float64Array([0, 0, 10, 0]), 3);

    expect(Array.from(output)).toEqual([0, 0, 5, 0, 10, 0]);
  });

  test("A/B testing returns the TypeScript control result and disables mismatching WASM", () => {
    const diagnostics: MapsKernelDiagnostic[] = [];

    setMapsKernelWasmRuntimeForTests({
      backend: "wasm",
      resampleLineFlat() {
        return new Float64Array([999, 999, 999, 999, 999, 999]);
      },
      resampleRingFlat() {
        return new Float64Array([999, 999, 999, 999, 999, 999]);
      },
    });
    configureMapsKernelRuntime({
      abTest: true,
      backend: "auto",
      onKernelDiagnostic(event) {
        diagnostics.push(event);
      },
      wasmThresholdCoordinates: 2,
    });

    const runtime = getMapsKernelRuntime();
    const firstOutput = runtime.resampleLineFlat(new Float64Array([0, 0, 10, 0]), 3);
    const secondOutput = runtime.resampleLineFlat(new Float64Array([0, 0, 10, 0]), 3);

    expect(Array.from(firstOutput)).toEqual([0, 0, 5, 0, 10, 0]);
    expect(Array.from(secondOutput)).toEqual([0, 0, 5, 0, 10, 0]);
    expect(diagnostics.some((event) => event.matched === false)).toBe(true);
    expect(
      diagnostics.some((event) => event.fallbackReason === "wasm disabled after A/B mismatch"),
    ).toBe(true);
  });
});
