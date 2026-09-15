export type CanvasGeographicRasterBounds = [
  west: number,
  south: number,
  east: number,
  north: number,
];

export type CanvasGeographicRasterProject = (
  coordinate: [longitude: number, latitude: number],
) => { x: number; y: number } | null;

export type CanvasGeographicRasterVerticalScale = "latitude" | "mercator";

type RasterVertex = {
  sourceX: number;
  sourceY: number;
  x: number;
  y: number;
};

type RasterTriangle = readonly [RasterVertex, RasterVertex, RasterVertex];

const TRANSFORM_EPSILON = 1e-7;
const MAX_MERCATOR_LATITUDE = 85.05112878;

export function drawCanvasGeographicRaster({
  bounds,
  context,
  devicePixelRatio,
  image,
  opacity,
  project,
  subdivisions = 8,
  verticalScale = "latitude",
}: {
  bounds: CanvasGeographicRasterBounds;
  context: CanvasRenderingContext2D;
  devicePixelRatio: number;
  image: CanvasImageSource & { height: number; width: number };
  opacity: number;
  project: CanvasGeographicRasterProject;
  subdivisions?: number;
  verticalScale?: CanvasGeographicRasterVerticalScale;
}) {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    !Number.isInteger(subdivisions) ||
    subdivisions < 1 ||
    subdivisions > 32
  ) {
    return false;
  }

  const rowLength = subdivisions + 1;
  const vertices: Array<RasterVertex | null> = Array.from(
    { length: rowLength * rowLength },
    () => null,
  );

  for (let row = 0; row <= subdivisions; row += 1) {
    const v = row / subdivisions;
    const latitude = interpolateLatitude(bounds[1], bounds[3], v, verticalScale);

    for (let column = 0; column <= subdivisions; column += 1) {
      const u = column / subdivisions;
      const longitude = bounds[0] + (bounds[2] - bounds[0]) * u;
      const screen = project([longitude, latitude]);
      vertices[row * rowLength + column] = isFinitePoint(screen)
        ? {
            sourceX: image.width * u,
            sourceY: image.height * v,
            x: screen.x,
            y: screen.y,
          }
        : null;
    }
  }

  context.save();
  context.globalAlpha = clamp(opacity, 0, 1);
  let drawn = false;

  for (let row = 0; row < subdivisions; row += 1) {
    for (let column = 0; column < subdivisions; column += 1) {
      const topLeft = vertices[row * rowLength + column];
      const topRight = vertices[row * rowLength + column + 1];
      const bottomLeft = vertices[(row + 1) * rowLength + column];
      const bottomRight = vertices[(row + 1) * rowLength + column + 1];

      if (topLeft && bottomLeft && topRight) {
        drawn =
          drawRasterTriangle(
            context,
            image,
            [topLeft, bottomLeft, topRight],
            devicePixelRatio,
          ) || drawn;
      }
      if (topRight && bottomLeft && bottomRight) {
        drawn =
          drawRasterTriangle(
            context,
            image,
            [topRight, bottomLeft, bottomRight],
            devicePixelRatio,
          ) || drawn;
      }
    }
  }

  context.restore();
  return drawn;
}

function drawRasterTriangle(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  triangle: RasterTriangle,
  devicePixelRatio: number,
) {
  const transform = triangleTransform(triangle);
  if (!transform) return false;

  context.save();
  context.beginPath();
  context.moveTo(triangle[0].x, triangle[0].y);
  context.lineTo(triangle[1].x, triangle[1].y);
  context.lineTo(triangle[2].x, triangle[2].y);
  context.closePath();
  context.clip();
  context.setTransform(
    devicePixelRatio * transform.a,
    devicePixelRatio * transform.b,
    devicePixelRatio * transform.c,
    devicePixelRatio * transform.d,
    devicePixelRatio * transform.e,
    devicePixelRatio * transform.f,
  );
  context.drawImage(image, 0, 0);
  context.restore();
  return true;
}

function triangleTransform(triangle: RasterTriangle) {
  const [first, second, third] = triangle;
  const determinant =
    first.sourceX * (second.sourceY - third.sourceY) +
    second.sourceX * (third.sourceY - first.sourceY) +
    third.sourceX * (first.sourceY - second.sourceY);

  if (!Number.isFinite(determinant) || Math.abs(determinant) <= TRANSFORM_EPSILON) {
    return null;
  }

  const a =
    (first.x * (second.sourceY - third.sourceY) +
      second.x * (third.sourceY - first.sourceY) +
      third.x * (first.sourceY - second.sourceY)) /
    determinant;
  const c =
    (first.x * (third.sourceX - second.sourceX) +
      second.x * (first.sourceX - third.sourceX) +
      third.x * (second.sourceX - first.sourceX)) /
    determinant;
  const e =
    (first.x * (second.sourceX * third.sourceY - third.sourceX * second.sourceY) +
      second.x * (third.sourceX * first.sourceY - first.sourceX * third.sourceY) +
      third.x * (first.sourceX * second.sourceY - second.sourceX * first.sourceY)) /
    determinant;
  const b =
    (first.y * (second.sourceY - third.sourceY) +
      second.y * (third.sourceY - first.sourceY) +
      third.y * (first.sourceY - second.sourceY)) /
    determinant;
  const d =
    (first.y * (third.sourceX - second.sourceX) +
      second.y * (first.sourceX - third.sourceX) +
      third.y * (second.sourceX - first.sourceX)) /
    determinant;
  const f =
    (first.y * (second.sourceX * third.sourceY - third.sourceX * second.sourceY) +
      second.y * (third.sourceX * first.sourceY - first.sourceX * third.sourceY) +
      third.y * (first.sourceX * second.sourceY - second.sourceX * first.sourceY)) /
    determinant;

  return [a, b, c, d, e, f].every(Number.isFinite) ? { a, b, c, d, e, f } : null;
}

function interpolateLatitude(
  south: number,
  north: number,
  v: number,
  verticalScale: CanvasGeographicRasterVerticalScale,
) {
  if (verticalScale === "latitude") {
    return north + (south - north) * v;
  }

  const northY = mercatorY(north);
  const southY = mercatorY(south);
  return inverseMercatorY(northY + (southY - northY) * v);
}

function mercatorY(latitude: number) {
  const clamped = clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const radians = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

function inverseMercatorY(value: number) {
  return (Math.atan(Math.sinh(value)) * 180) / Math.PI;
}

function isFinitePoint(point: { x: number; y: number } | null): point is { x: number; y: number } {
  return point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
