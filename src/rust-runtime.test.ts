import { describe, expect, it } from "vitest";

import { createMapsRustRuntimeFromModule } from "./rust-runtime";

describe("Maps Rust runtime adapter", () => {
  it("keeps transport encoding narrow and normalizes ids before crossing WASM", () => {
    let receivedPoints: unknown;
    const runtime = createMapsRustRuntimeFromModule({
      boundsFromMapPoints(points) {
        receivedPoints = points;
        return [7, 48, 9, 50];
      },
      normalizeMapPoints(points) {
        receivedPoints = points;
        return [
          {
            id: "42",
            label: "Karlsruhe",
            latitude: 49,
            longitude: 8,
            metrics: { demand: 3 },
          },
        ];
      },
    });

    const points = [
      {
        id: 42,
        label: "Karlsruhe",
        latitude: 49,
        longitude: 8,
        metrics: { demand: 3 },
      },
    ];

    expect(runtime.normalizePoints(points)).toEqual([
      {
        id: "42",
        label: "Karlsruhe",
        latitude: 49,
        longitude: 8,
        metrics: { demand: 3 },
      },
    ]);
    expect(receivedPoints).toEqual([
      {
        id: "42",
        label: "Karlsruhe",
        latitude: 49,
        longitude: 8,
        metrics: { demand: 3 },
      },
    ]);
    expect(runtime.boundsFromPoints(points)).toEqual([7, 48, 9, 50]);
  });

  it("rejects malformed WASM results at the TypeScript boundary", () => {
    const runtime = createMapsRustRuntimeFromModule({
      boundsFromMapPoints() {
        return [7, 48, Number.NaN, 50];
      },
      normalizeMapPoints() {
        return [{ id: "point-1" }];
      },
    });

    expect(() => runtime.boundsFromPoints([])).toThrow("Maps WASM returned invalid bounds.");
    expect(() => runtime.normalizePoints([])).toThrow(
      "Maps WASM returned an invalid normalized point.",
    );
  });
});
