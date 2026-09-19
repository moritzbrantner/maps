import { describe, expect, test } from "vitest";

import type {
  MapsRasterRenderCamera,
  MapsRasterTilePlacement,
} from "./flat-runtime-wasm";
import {
  buildCanvasRasterTriangles,
  projectRasterLocalPoint,
} from "./canvas-raster-projective";

const IDENTITY_CAMERA: MapsRasterRenderCamera = {
  viewportHeight: 100,
  viewportWidth: 200,
  viewProjection: [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ],
};

const PLACEMENT: MapsRasterTilePlacement = {
  tile: { key: "0/0/0", x: 0, y: 0, z: 0 },
  worldCopy: 0,
  localWest: -1,
  localNorth: 1,
  localSize: 2,
  screenX: 999,
  screenY: 999,
  screenWidth: 1,
  screenHeight: 1,
};

describe("Canvas raster canonical camera consumption", () => {
  test("projects Maps local coordinates through the supplied column-major camera", () => {
    expect(projectRasterLocalPoint(IDENTITY_CAMERA, { width: 200, height: 100 }, 0, 0)).toEqual({
      x: 100,
      y: 50,
    });
    expect(projectRasterLocalPoint(IDENTITY_CAMERA, { width: 200, height: 100 }, -1, 1)).toEqual({
      x: 0,
      y: 0,
    });
    expect(projectRasterLocalPoint(IDENTITY_CAMERA, { width: 200, height: 100 }, 1, -1)).toEqual({
      x: 200,
      y: 100,
    });
  });

  test("builds tile triangles from local placement rather than legacy screen rectangles", () => {
    const triangles = buildCanvasRasterTriangles(
      256,
      256,
      PLACEMENT,
      IDENTITY_CAMERA,
      { width: 200, height: 100 },
      1,
    );

    expect(triangles).toHaveLength(2);
    expect(triangles[0]).toEqual([
      { x: 0, y: 0, sourceX: 0, sourceY: 0 },
      { x: 0, y: 100, sourceX: 0, sourceY: 256 },
      { x: 200, y: 0, sourceX: 256, sourceY: 0 },
    ]);
    expect(triangles[1]).toEqual([
      { x: 200, y: 0, sourceX: 256, sourceY: 0 },
      { x: 0, y: 100, sourceX: 0, sourceY: 256 },
      { x: 200, y: 100, sourceX: 256, sourceY: 256 },
    ]);
  });

  test("subdivides a perspective tile deterministically", () => {
    const camera: MapsRasterRenderCamera = {
      viewProjection: [
        1, 0, 0, 0,
        0, 1, 0, 0.25,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
    };

    const triangles = buildCanvasRasterTriangles(
      256,
      256,
      PLACEMENT,
      camera,
      { width: 200, height: 100 },
      2,
    );

    expect(triangles).toHaveLength(8);
    expect(triangles.every((triangle) => triangle.every((vertex) => Number.isFinite(vertex.x)))).toBe(
      true,
    );
  });

  test("fails closed for geometry behind the homogeneous camera", () => {
    const behindCamera: MapsRasterRenderCamera = {
      viewProjection: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, -1,
      ],
    };

    expect(projectRasterLocalPoint(behindCamera, { width: 200, height: 100 }, 0, 0)).toBeNull();
  });
});
