import { describe, expect, test } from "vitest";

import {
  drawCanvasGeographicRaster,
  type CanvasGeographicRasterBounds,
  type CanvasGeographicRasterProject,
} from "./canvas-geographic-raster";

type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

type DrawnTriangle = { clip: [number, number][]; transform: Affine };

/** Records what Canvas would draw: each clipped triangle and the image transform used in it. */
function createRecordingContext(width: number, height: number) {
  const triangles: DrawnTriangle[] = [];
  let path: [number, number][] = [];
  let clip: [number, number][] = [];
  let transform: Affine = [1, 0, 0, 1, 0, 0];
  const context = {
    beginPath: () => {
      path = [];
    },
    canvas: { height, width },
    clip: () => {
      clip = path;
    },
    closePath: () => undefined,
    drawImage: () => {
      triangles.push({ clip, transform });
    },
    globalAlpha: 1,
    lineTo: (x: number, y: number) => {
      path.push([x, y]);
    },
    moveTo: (x: number, y: number) => {
      path = [[x, y]];
    },
    restore: () => undefined,
    save: () => undefined,
    setTransform: (...next: Affine) => {
      transform = next;
    },
  };
  return { context: context as unknown as CanvasRenderingContext2D, triangles };
}

const IMAGE = { height: 256, width: 256 } as unknown as HTMLCanvasElement;
const BOUNDS: CanvasGeographicRasterBounds = [0, 40, 20, 60];
const VIEW = { height: 1000, width: 1200 };

function mercator([longitude, latitude]: [number, number]) {
  const radians = (latitude * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * 4096,
    y: (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) * 2048,
  };
}

const CENTER = mercator([10, 50]);

/** A flat Mercator camera: affine in Mercator, so a Mercator raster needs no splitting. */
const flat: CanvasGeographicRasterProject = (coordinate) => {
  const world = mercator(coordinate);
  return { x: VIEW.width / 2 + (world.x - CENTER.x) * 2, y: VIEW.height / 2 + (world.y - CENTER.y) * 2 };
};

/** A pitched camera: farther (northern) ground is smaller, a projective, non-affine map. */
const pitched: CanvasGeographicRasterProject = (coordinate) => {
  const world = mercator(coordinate);
  const depth = 1 - (world.y - CENTER.y) * 0.004;
  if (depth <= 0.05) return null;
  return {
    x: VIEW.width / 2 + ((world.x - CENTER.x) * 2) / depth,
    y: VIEW.height / 2 + ((world.y - CENTER.y) * 2) / depth,
  };
};

/**
 * The largest distance between where a drawn triangle puts an image pixel and where the
 * projection puts that pixel's geographic coordinate, sampled inside every triangle.
 */
function maxMisplacement(
  triangles: DrawnTriangle[],
  project: CanvasGeographicRasterProject,
  verticalScale: "latitude" | "mercator",
) {
  let worst = 0;
  for (const { clip, transform } of triangles) {
    const [a, b, c, d, e, f] = transform;
    const determinant = a * d - b * c;
    for (const [w0, w1, w2] of [
      [1 / 3, 1 / 3, 1 / 3],
      [0.5, 0.5, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
    ]) {
      const x = clip[0]![0] * w0! + clip[1]![0] * w1! + clip[2]![0] * w2!;
      const y = clip[0]![1] * w0! + clip[1]![1] * w1! + clip[2]![1] * w2!;
      // Invert the drawn transform: which image pixel landed at (x, y)?
      const sourceX = (d * (x - e) - c * (y - f)) / determinant;
      const sourceY = (a * (y - f) - b * (x - e)) / determinant;
      const u = sourceX / IMAGE.width;
      const v = sourceY / IMAGE.height;
      const longitude = BOUNDS[0] + (BOUNDS[2] - BOUNDS[0]) * u;
      const latitude =
        verticalScale === "latitude"
          ? BOUNDS[3] + (BOUNDS[1] - BOUNDS[3]) * v
          : inverseMercatorLatitude(BOUNDS[3], BOUNDS[1], v);
      const expected = project([longitude, latitude])!;
      worst = Math.max(worst, Math.hypot(expected.x - x, expected.y - y));
    }
  }
  return worst;
}

function inverseMercatorLatitude(north: number, south: number, v: number) {
  const y = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
  const value = y(north) + (y(south) - y(north)) * v;
  return (Math.atan(Math.sinh(value)) * 180) / Math.PI;
}

function draw(project: CanvasGeographicRasterProject, verticalScale: "latitude" | "mercator") {
  const { context, triangles } = createRecordingContext(VIEW.width, VIEW.height);
  const drawn = drawCanvasGeographicRaster({
    bounds: BOUNDS,
    context,
    devicePixelRatio: 1,
    image: IMAGE,
    opacity: 1,
    project,
    verticalScale,
  });
  return { drawn, triangles };
}

describe("drawCanvasGeographicRaster", () => {
  test("keeps the 8 × 8 mesh where the raster is already affine on screen", () => {
    const { drawn, triangles } = draw(flat, "mercator");

    expect(drawn).toBe(true);
    expect(triangles).toHaveLength(8 * 8 * 2);
    expect(maxMisplacement(triangles, flat, "mercator")).toBeLessThan(0.01);
  });

  test("splits cells under a pitched camera until the raster stays aligned with the projection", () => {
    const { triangles } = draw(pitched, "mercator");

    // A fixed 8 × 8 mesh misplaced pixels by many screen pixels here (#171 phase 3).
    expect(triangles.length).toBeGreaterThan(8 * 8 * 2);
    expect(maxMisplacement(triangles, pitched, "mercator")).toBeLessThan(1);
  });

  test("aligns latitude-linear field rasters with a Mercator projection", () => {
    const { triangles } = draw(flat, "latitude");

    expect(maxMisplacement(triangles, flat, "latitude")).toBeLessThan(1);
  });

  test("neither splits nor draws cells entirely off screen", () => {
    const offscreen: CanvasGeographicRasterProject = (coordinate) => {
      const point = pitched(coordinate);
      return point && { x: point.x + 10_000, y: point.y };
    };
    const { drawn, triangles } = draw(offscreen, "mercator");

    expect(drawn).toBe(false);
    expect(triangles).toHaveLength(0);
  });
});
