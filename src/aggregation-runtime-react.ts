"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  ensureMapsAggregationWasm,
  getMapsAggregationRuntimeStatus,
  getMapsAggregationRuntimeVersion,
  isMapsAggregationRuntimePending,
  subscribeMapsAggregationRuntime,
  type MapsAggregationRuntimeStatus,
} from "./aggregation-runtime";

export type MapsAggregationRuntimeState = {
  /**
   * True while the runtime is `idle` or `loading`. Layers build no index in this state and
   * render no aggregated output, so a dense dataset is never drawn point by point before Rust
   * can cluster it.
   */
  pending: boolean;
  status: MapsAggregationRuntimeStatus;
  /** Changes whenever the runtime or its status changes; include it in index dependencies. */
  version: number;
};

/**
 * Starts the Maps aggregation WASM runtime and reports its state. Components that build point
 * aggregation indexes wait while it is pending and rebuild when the version changes, so they
 * switch straight to the Rust-clustered index (or, if loading fails, to the explicit
 * unclustered fallback).
 */
export function useMapsAggregationRuntime(): MapsAggregationRuntimeState {
  const version = useSyncExternalStore(
    subscribeMapsAggregationRuntime,
    getMapsAggregationRuntimeVersion,
    getMapsAggregationRuntimeVersion,
  );

  useEffect(() => {
    void ensureMapsAggregationWasm();
  }, []);

  // Every status change bumps the version, so the status read here matches `version`.
  const status = getMapsAggregationRuntimeStatus();

  return { pending: isMapsAggregationRuntimePending(status), status, version };
}

/** The runtime version alone; see `useMapsAggregationRuntime`. */
export function useMapsAggregationRuntimeVersion() {
  return useMapsAggregationRuntime().version;
}
