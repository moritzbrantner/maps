"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  ensureMapsAggregationWasm,
  getMapsAggregationRuntimeVersion,
  subscribeMapsAggregationRuntime,
} from "./aggregation-runtime";

/**
 * Starts the Maps aggregation WASM runtime and returns a version that changes once it is ready.
 * Components that build point aggregation indexes include it in their dependencies, so their
 * first unclustered index is rebuilt as a Rust-clustered one.
 */
export function useMapsAggregationRuntimeVersion() {
  const version = useSyncExternalStore(
    subscribeMapsAggregationRuntime,
    getMapsAggregationRuntimeVersion,
    getMapsAggregationRuntimeVersion,
  );

  useEffect(() => {
    void ensureMapsAggregationWasm();
  }, []);

  return version;
}
