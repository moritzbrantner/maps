import { expect, test } from "vitest";
import { createMapsWgpuApplicationFrame } from "./wgpu-application-frame";

test("a heat raster occupies its painter-order position even without vector geometry", () => {
  const raster = {
    before: 0,
    image: new Image(),
    opacity: 0.6,
    vertices: [0, 0, 0, 0, 10, 0, 1, 0, 0, 10, 0, 1],
  };
  const frame = createMapsWgpuApplicationFrame({
    width: 10,
    height: 10,
    primitives: [],
    rasters: [raster],
  });
  expect(Array.from(frame!.order)).toEqual([6, 0, 1]);
  expect(frame!.rasters).toEqual([raster]);
});
