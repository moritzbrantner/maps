import { describe, expect, it } from "vitest";
import {
  captureOverlayMotionAnchors,
  invertOverlayMotionPoint,
  resolveOverlayMotionTransform,
} from "./overlay-motion-transform";

const WIDTH = 600;
const HEIGHT = 400;

/** A flat pitch-0 camera: screen = rotate(bearing) · (world − center) · 2^zoom + viewport center. */
function flatCamera(center: [number, number], zoom: number, bearing = 0) {
  const scale = 2 ** zoom;
  const radians = (bearing * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    project([longitude, latitude]: [number, number]) {
      const x = (longitude - center[0]) * scale;
      const y = -(latitude - center[1]) * scale;
      return { x: WIDTH / 2 + x * cos - y * sin, y: HEIGHT / 2 + x * sin + y * cos };
    },
    unproject(screenX: number, screenY: number): [number, number] {
      const x = screenX - WIDTH / 2;
      const y = screenY - HEIGHT / 2;
      const worldX = x * cos + y * sin;
      const worldY = -x * sin + y * cos;
      return [center[0] + worldX / scale, center[1] - worldY / scale];
    },
  };
}

function presentedPoint(matrix: readonly number[], point: { x: number; y: number }) {
  const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number];
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

describe("overlay motion transform", () => {
  it("presents a retained render exactly where the current camera projects it", () => {
    const rendered = flatCamera([10, 50], 4);
    const anchors = captureOverlayMotionAnchors(rendered.unproject, WIDTH, HEIGHT)!;
    const geographic: [number, number] = [12, 48];
    const renderedPixel = rendered.project(geographic);

    for (const current of [
      flatCamera([11, 50.5], 4),
      flatCamera([10, 50], 4.6),
      flatCamera([10.2, 49.9], 3.8, 10),
    ]) {
      const matrix = resolveOverlayMotionTransform(anchors, current.project, WIDTH, HEIGHT)!;
      expect(matrix).not.toBeNull();
      const presented = presentedPoint(matrix, renderedPixel);
      const expected = current.project(geographic);
      expect(presented.x).toBeCloseTo(expected.x, 6);
      expect(presented.y).toBeCloseTo(expected.y, 6);
      // Picking maps the current pointer back into the retained scene.
      const back = invertOverlayMotionPoint(matrix, expected)!;
      expect(back.x).toBeCloseTo(renderedPixel.x, 6);
      expect(back.y).toBeCloseTo(renderedPixel.y, 6);
    }
  });

  it("re-renders instead of presenting stretched, sparse or projective content", () => {
    const rendered = flatCamera([10, 50], 4);
    const anchors = captureOverlayMotionAnchors(rendered.unproject, WIDTH, HEIGHT)!;
    const resolve = (project: (point: [number, number]) => { x: number; y: number } | null) =>
      resolveOverlayMotionTransform(anchors, project, WIDTH, HEIGHT);

    // More than one zoom level from the render.
    expect(resolve(flatCamera([10, 50], 5.2).project)).toBeNull();
    expect(resolve(flatCamera([10, 50], 2.8).project)).toBeNull();
    // Panned so far that most of the viewport would be blank.
    expect(resolve(flatCamera([10 + 400 / 16, 50], 4).project)).toBeNull();
    // A pitched camera is not a similarity on screen.
    const flat = flatCamera([10, 50], 4);
    expect(
      resolve((point) => {
        const screen = flat.project(point);
        const depth = 1 + (screen.y - HEIGHT / 2) / 2000;
        return { x: WIDTH / 2 + (screen.x - WIDTH / 2) / depth, y: screen.y / depth };
      }),
    ).toBeNull();
    // A resized viewport and unavailable projections re-render.
    expect(
      resolveOverlayMotionTransform(anchors, flatCamera([10, 50], 4).project, WIDTH + 1, HEIGHT),
    ).toBeNull();
    expect(resolve(() => null)).toBeNull();
  });

  it("captures no anchors for an empty viewport or an unavailable projection", () => {
    const camera = flatCamera([0, 0], 2);
    expect(captureOverlayMotionAnchors(camera.unproject, 0, HEIGHT)).toBeNull();
    expect(captureOverlayMotionAnchors(() => null, WIDTH, HEIGHT)).toBeNull();
  });
});
