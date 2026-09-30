import { describe, expect, test } from "vitest";

import { decodePackedRasterFrame } from "./flat-runtime-wasm";

// Layout owned by `pack_frame_plan` in crates/maps-wasm/src/engine_scenario.rs.
function packedFrame() {
  const matrix = Array.from({ length: 16 }, (_, index) => index + 0.5);
  return new Float64Array([
    ...[179.5, -33.25, 6.5, -12, 30, 800, 600],
    ...matrix,
    ...[170.25, -40, -175.5, -20, 1, 0],
    ...[2, 1, 0, 1],
    // surface margin, overscan
    ...[128, 1],
    // placements: z, x, y, world copy, local west/north/size, screen x/y/width/height, visible
    ...[7, 127, 77, 0, -10.5, 20.25, 256, 389.5, 279.75, 256, 256, 1],
    ...[7, 0, 77, 1, 245.5, 20.25, 256, 645.5, 279.75, 256, 256, 0],
    // requests, cancellations, evictions
    ...[7, 1, 77],
    ...[6, 63, 38],
  ]);
}

describe("decodePackedRasterFrame", () => {
  test("decodes the authoritative Rust frame into keyed tile work", () => {
    const frame = decodePackedRasterFrame(packedFrame());

    expect(frame.camera).toEqual({
      center: [179.5, -33.25],
      zoom: 6.5,
      bearing: -12,
      pitch: 30,
      width: 800,
      height: 600,
    });
    expect(frame.renderCamera.viewProjection).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 0.5),
    );
    expect(frame.visibleBounds).toEqual({
      west: 170.25,
      south: -40,
      east: -175.5,
      north: -20,
      crossesAntimeridian: true,
      spansFullWorld: false,
    });
    expect(frame.placements).toEqual([
      {
        tile: { key: "7/127/77", x: 127, y: 77, z: 7 },
        worldCopy: 0,
        localWest: -10.5,
        localNorth: 20.25,
        localSize: 256,
        screenX: 389.5,
        screenY: 279.75,
        screenWidth: 256,
        screenHeight: 256,
        visible: true,
      },
      {
        tile: { key: "7/0/77", x: 0, y: 77, z: 7 },
        worldCopy: 1,
        localWest: 245.5,
        localNorth: 20.25,
        localSize: 256,
        screenX: 645.5,
        screenY: 279.75,
        screenWidth: 256,
        screenHeight: 256,
        visible: false,
      },
    ]);
    expect(frame.surface).toEqual({ margin: 128, overscan: true });
    expect(frame.requests).toEqual([{ key: "7/1/77", x: 1, y: 77, z: 7 }]);
    expect(frame.cancellations).toEqual([]);
    expect(frame.evictions).toEqual([{ key: "6/63/38", x: 63, y: 38, z: 6 }]);
  });

  test("fails closed on truncated or inconsistent frames", () => {
    const packed = packedFrame();
    expect(() => decodePackedRasterFrame(packed.subarray(0, 20))).toThrow(/truncated/);
    expect(() => decodePackedRasterFrame(packed.subarray(0, packed.length - 1))).toThrow(
      /malformed/,
    );
  });
});
