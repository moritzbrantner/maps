import { describe, expect, test } from "vitest";

import {
  getRustRuntimeStatus,
  recordRustAggregationDiagnostic,
  subscribeRustRuntimeStatus,
} from "./rust-runtime-status";

describe("hosted Rust runtime status", () => {
  test("treats repeated authoritative viewport diagnostics as idempotent state evidence", () => {
    let notifications = 0;
    const unsubscribe = subscribeRustRuntimeStatus(() => {
      notifications += 1;
    });

    try {
      recordRustAggregationDiagnostic({
        backend: "wasm",
        featureCount: 4,
        mode: "authoritative",
      });
      recordRustAggregationDiagnostic({
        backend: "wasm",
        featureCount: 9,
        mode: "authoritative",
      });

      expect(notifications).toBe(1);
      expect(getRustRuntimeStatus()).toEqual({
        detail: "Rust/WASM is authoritative for point aggregation in this session.",
        label: "Rust authoritative",
        state: "authoritative",
      });
    } finally {
      unsubscribe();
    }
  });
});
