import type { MapScreenPoint } from "./map-screen-render-frame";

/**
 * Presentation-only motion transform for a retained overlay render.
 *
 * While the camera moves, re-projecting and re-drawing every overlay primitive can cost
 * far more than a frame. For flat (pitch 0) cameras the change between two cameras is a
 * similarity on screen, so the last render can be presented by a CSS affine transform
 * until motion settles. The transform is derived from the authoritative Maps projection
 * of geographic anchors captured at render time; it never replaces projection semantics.
 */

/** CSS `matrix(a, b, c, d, e, f)`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type OverlayMotionMatrix = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
];

export type OverlayMotionAnchors = {
  /** Geographic positions of the rendered corners: top-left, top-right, bottom-left, bottom-right. */
  corners: readonly (readonly [longitude: number, latitude: number])[];
  height: number;
  width: number;
};

type Project = (coordinate: [longitude: number, latitude: number]) => MapScreenPoint | null;
type Unproject = (x: number, y: number) => [longitude: number, latitude: number] | null;

/** Retained content is only presented within one zoom level of its render. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
/** Fraction of the current viewport that must show retained content (rotation exposes corners). */
const MIN_COVERAGE = 0.5;
const COVERAGE_GRID = 4;
/** Relative tolerance for "the camera change is a similarity" (no pitch/perspective). */
const SIMILARITY_TOLERANCE = 1e-3;

export function captureOverlayMotionAnchors(
  unproject: Unproject,
  width: number,
  height: number,
): OverlayMotionAnchors | null {
  if (!(width > 0) || !(height > 0)) return null;
  const corners = [
    unproject(0, 0),
    unproject(width, 0),
    unproject(0, height),
    unproject(width, height),
  ];
  if (corners.some((corner) => !corner || !corner.every(Number.isFinite))) return null;
  return { corners: corners as [number, number][], height, width };
}

/**
 * Maps the retained render into the current camera, or `null` when the retained pixels
 * cannot faithfully stand in for a fresh render (pitch/perspective, too much zoom, or
 * too little of the viewport covered).
 */
export function resolveOverlayMotionTransform(
  anchors: OverlayMotionAnchors,
  project: Project,
  width: number,
  height: number,
): OverlayMotionMatrix | null {
  if (width !== anchors.width || height !== anchors.height) return null;
  const projected = anchors.corners.map((corner) => project([corner[0], corner[1]]));
  if (projected.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return null;
  }
  const [topLeft, topRight, bottomLeft, bottomRight] = projected as MapScreenPoint[];
  const a = (topRight!.x - topLeft!.x) / width;
  const b = (topRight!.y - topLeft!.y) / width;
  const c = (bottomLeft!.x - topLeft!.x) / height;
  const d = (bottomLeft!.y - topLeft!.y) / height;
  const e = topLeft!.x;
  const f = topLeft!.y;

  const scale = Math.hypot(a, b);
  if (!(scale >= MIN_SCALE && scale <= MAX_SCALE)) return null;
  // A rotation plus uniform scale maps the y axis to the x axis turned by 90°.
  const tolerance = SIMILARITY_TOLERANCE * scale;
  if (Math.abs(c + b) > tolerance || Math.abs(d - a) > tolerance) return null;
  // The fourth corner rejects projective (pitched) changes the first three cannot see.
  const expectedX = a * width + c * height + e;
  const expectedY = b * width + d * height + f;
  if (Math.hypot(bottomRight!.x - expectedX, bottomRight!.y - expectedY) > tolerance * width) {
    return null;
  }

  const matrix: OverlayMotionMatrix = [a, b, c, d, e, f];
  return overlayMotionCoverage(matrix, width, height) >= MIN_COVERAGE ? matrix : null;
}

/** Maps a current-viewport point back into the retained render's coordinates. */
export function invertOverlayMotionPoint(
  matrix: OverlayMotionMatrix,
  point: MapScreenPoint,
): MapScreenPoint | null {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const x = point.x - e;
  const y = point.y - f;
  return { x: (d * x - c * y) / determinant, y: (a * y - b * x) / determinant };
}

export function overlayMotionMatrixCss(matrix: OverlayMotionMatrix) {
  return `matrix(${matrix.join(", ")})`;
}

/** Sampled fraction of the current viewport that shows retained (rendered) content. */
function overlayMotionCoverage(matrix: OverlayMotionMatrix, width: number, height: number) {
  let covered = 0;
  for (let row = 0; row < COVERAGE_GRID; row += 1) {
    for (let column = 0; column < COVERAGE_GRID; column += 1) {
      const source = invertOverlayMotionPoint(matrix, {
        x: ((column + 0.5) / COVERAGE_GRID) * width,
        y: ((row + 0.5) / COVERAGE_GRID) * height,
      });
      if (source && source.x >= 0 && source.x <= width && source.y >= 0 && source.y <= height) {
        covered += 1;
      }
    }
  }
  return covered / (COVERAGE_GRID * COVERAGE_GRID);
}
