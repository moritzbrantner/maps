import type { MapsAggregationDiagnostic } from "../src/aggregation-runtime";

export type RustRuntimeState = "loading" | "loaded" | "verified" | "fallback" | "unavailable";

export type RustRuntimeStatus = {
  detail: string;
  label: string;
  state: RustRuntimeState;
};

const listeners = new Set<() => void>();

let status: RustRuntimeStatus = {
  detail: "GitHub Pages initializes the packaged Rust/WASM point index before the live demo.",
  label: "Hosted parity",
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
  if (status.state === "verified" || status.state === "fallback") {
    return;
  }

  updateStatus({
    detail: "The candidate is loaded; live viewport results are checked against the control path.",
    label: "Candidate loaded",
    state: "loaded",
  });
}

export function recordRustAggregationDiagnostic(event: MapsAggregationDiagnostic) {
  if (event.mode === "candidate" && event.matched === true) {
    const featureCount = event.candidateFeatureCount ?? 0;
    updateStatus({
      detail: `Rust/WASM matched the live ${featureCount}-feature viewport against the Supercluster control.`,
      label: "Shadow verified",
      state: "verified",
    });
    return;
  }

  if (event.mode === "fallback" || event.matched === false) {
    updateStatus({
      detail: event.fallbackReason
        ? `Control path retained: ${event.fallbackReason}.`
        : "Control path retained after a Rust/WASM parity mismatch.",
      label: "Control fallback",
      state: "fallback",
    });
  }
}

export function markRustRuntimeUnavailable(detail: string) {
  updateStatus({
    detail,
    label: "Control fallback",
    state: "fallback",
  });
}

function updateStatus(nextStatus: RustRuntimeStatus) {
  status = nextStatus;
  for (const listener of listeners) {
    listener();
  }
}
