import type { MapsAggregationDiagnostic } from "../src/aggregation-runtime";

export type RustRuntimeState =
  | "loading"
  | "loaded"
  | "authoritative"
  | "fallback"
  | "error"
  | "unavailable";

export type RustRuntimeStatus = {
  detail: string;
  label: string;
  state: RustRuntimeState;
};

const listeners = new Set<() => void>();

let status: RustRuntimeStatus = {
  detail: "GitHub Pages initializes the packaged Rust/WASM point index before the live demo.",
  label: "Hosted Rust",
  state: "unavailable",
};

export function getRustRuntimeStatus() {
  return status;
}

export function subscribeRustRuntimeStatus(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function markRustRuntimeLoading() {
  updateStatus({
    detail: "Loading the packaged Maps point index before the live map mounts.",
    label: "Loading",
    state: "loading",
  });
}

export function markRustRuntimeLoaded() {
  if (
    status.state === "authoritative" ||
    status.state === "fallback" ||
    status.state === "error"
  ) {
    return;
  }

  updateStatus({
    detail: "The packaged Maps Rust/WASM point index is loaded; new point aggregation indexes use Rust as authority.",
    label: "Rust loaded",
    state: "loaded",
  });
}

export function recordRustAggregationDiagnostic(event: MapsAggregationDiagnostic) {
  if (event.mode === "authoritative") {
    updateStatus({
      detail:
        event.featureCount === undefined
          ? "Rust/WASM is authoritative for point aggregation in this session."
          : `Rust/WASM is authoritative for the live ${event.featureCount}-feature viewport.`,
      label: "Rust authoritative",
      state: "authoritative",
    });
    return;
  }

  if (event.mode === "error") {
    updateStatus({
      detail: event.fallbackReason
        ? `Rust/WASM authoritative aggregation failed: ${event.fallbackReason}.`
        : "Rust/WASM authoritative aggregation failed closed.",
      label: "Rust error",
      state: "error",
    });
    return;
  }

  updateStatus({
    detail: event.fallbackReason
      ? `Rust/WASM could not initialize; the explicit JavaScript fallback is active: ${event.fallbackReason}.`
      : "Rust/WASM is unavailable; the explicit JavaScript fallback is active.",
    label: "JS fallback",
    state: "fallback",
  });
}

export function markRustRuntimeUnavailable(detail: string) {
  updateStatus({
    detail,
    label: "JS fallback",
    state: "fallback",
  });
}

function updateStatus(nextStatus: RustRuntimeStatus) {
  status = nextStatus;
  for (const listener of listeners) {
    listener();
  }
}
