import type {
  MapsRasterRenderCamera,
  MapsRasterTilePlacement,
} from "./flat-runtime-wasm";

const HOMOGENEOUS_EPSILON = 1e-7;
const CLIP_DEPTH_EPSILON = 1e-6;
const AFFINE_QUAD_EPSILON = 1e-5;

export type CanvasRasterScreenPoint = {
  x: number;
  y: number;
};

export type CanvasRasterVertex = CanvasRasterScreenPoint & {
  sourceX: number;
  sourceY: number;
};

export type CanvasRasterTriangle = readonly [
  CanvasRasterVertex,
  CanvasRasterVertex,
  CanvasRasterVertex,
];

type CanvasViewport = {
  height: number;
  width: number;
};

export function projectRasterLocalPoint(
  renderCamera: MapsRasterRenderCamera,
  viewport: CanvasViewport,
  localX: number,
  localY: number,
): CanvasRasterScreenPoint | null {
  const matrix = renderCamera.viewProjection;
  const clipX = matrix[0] * localX + matrix[4] * localY + matrix[12];
  const clipY = matrix[1] * localX + matrix[5] * localY + matrix[13];
  const clipZ = matrix[2] * localX + matrix[6] * localY + matrix[14];
  const clipW = matrix[3] * localX + matrix[7] * localY + matrix[15];

  if (
    !Number.isFinite(clipX) ||
    !Number.isFinite(clipY) ||
    !Number.isFinite(clipZ) ||
    !Number.isFinite(clipW) ||
    clipW <= HOMOGENEOUS_EPSILON ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  const ndcZ = clipZ / clipW;
  if (
    !Number.isFinite(ndcX) ||
    !Number.isFinite(ndcY) ||
    !Number.isFinite(ndcZ) ||
    ndcZ < -CLIP_DEPTH_EPSILON ||
    ndcZ > 1 + CLIP_DEPTH_EPSILON
  ) {
    return null;
  }

  const x = (ndcX + 1) * viewport.width * 0.5;
  const y = (1 - ndcY) * viewport.height * 0.5;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function buildCanvasRasterTriangles(
  imageWidth: number,
  imageHeight: number,
  placement: MapsRasterTilePlacement,
  renderCamera: MapsRasterRenderCamera,
  viewport: CanvasViewport,
  subdivisions: number,
): CanvasRasterTriangle[] {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    !Number.isInteger(subdivisions) ||
    subdivisions < 1 ||
    subdivisions > 32 ||
    !Number.isFinite(placement.localWest) ||
    !Number.isFinite(placement.localNorth) ||
    !Number.isFinite(placement.localSize) ||
    placement.localSize <= 0
  ) {
    return [];
  }

  const rowLength = subdivisions + 1;
  const vertices: Array<CanvasRasterVertex | null> = new Array(rowLength * rowLength);

  for (let row = 0; row <= subdivisions; row += 1) {
    const v = row / subdivisions;
    const localY = placement.localNorth - placement.localSize * v;
    for (let column = 0; column <= subdivisions; column += 1) {
      const u = column / subdivisions;
      const localX = placement.localWest + placement.localSize * u;
      const screen = projectRasterLocalPoint(renderCamera, viewport, localX, localY);
      vertices[row * rowLength + column] = screen
        ? {
            ...screen,
            sourceX: imageWidth * u,
            sourceY: imageHeight * v,
          }
        : null;
    }
  }

  const triangles: CanvasRasterTriangle[] = [];
  for (let row = 0; row < subdivisions; row += 1) {
    for (let column = 0; column < subdivisions; column += 1) {
      const topLeft = vertices[row * rowLength + column];
      const topRight = vertices[row * rowLength + column + 1];
      const bottomLeft = vertices[(row + 1) * rowLength + column];
      const bottomRight = vertices[(row + 1) * rowLength + column + 1];

      if (topLeft && bottomLeft && topRight) {
        triangles.push([topLeft, bottomLeft, topRight]);
      }
      if (topRight && bottomLeft && bottomRight) {
        triangles.push([topRight, bottomLeft, bottomRight]);
      }
    }
  }

  return triangles;
}

export function drawCanvasRasterTile(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { height: number; width: number },
  placement: MapsRasterTilePlacement,
  renderCamera: MapsRasterRenderCamera,
  viewport: CanvasViewport,
  devicePixelRatio: number,
  subdivisions: number,
): boolean {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return false;

  const topLeft = projectRasterLocalPoint(
    renderCamera,
    viewport,
    placement.localWest,
    placement.localNorth,
  );
  const topRight = projectRasterLocalPoint(
    renderCamera,
    viewport,
    placement.localWest + placement.localSize,
    placement.localNorth,
  );
  const bottomLeft = projectRasterLocalPoint(
    renderCamera,
    viewport,
    placement.localWest,
    placement.localNorth - placement.localSize,
  );
  const bottomRight = projectRasterLocalPoint(
    renderCamera,
    viewport,
    placement.localWest + placement.localSize,
    placement.localNorth - placement.localSize,
  );

  if (
    topLeft &&
    topRight &&
    bottomLeft &&
    bottomRight &&
    isAffineQuad(topLeft, topRight, bottomLeft, bottomRight)
  ) {
    return drawAffineRasterTile(
      context,
      image,
      topLeft,
      topRight,
      bottomLeft,
      devicePixelRatio,
    );
  }

  const triangles = buildCanvasRasterTriangles(
    image.width,
    image.height,
    placement,
    renderCamera,
    viewport,
    subdivisions,
  );
  let drawn = false;
  for (const triangle of triangles) {
    drawn = drawRasterTriangle(context, image, triangle, devicePixelRatio) || drawn;
  }
  return drawn;
}

function isAffineQuad(
  topLeft: CanvasRasterScreenPoint,
  topRight: CanvasRasterScreenPoint,
  bottomLeft: CanvasRasterScreenPoint,
  bottomRight: CanvasRasterScreenPoint,
) {
  const expectedX = topRight.x + bottomLeft.x - topLeft.x;
  const expectedY = topRight.y + bottomLeft.y - topLeft.y;
  const scale = Math.max(
    1,
    Math.abs(topLeft.x),
    Math.abs(topLeft.y),
    Math.abs(topRight.x),
    Math.abs(topRight.y),
    Math.abs(bottomLeft.x),
    Math.abs(bottomLeft.y),
    Math.abs(bottomRight.x),
    Math.abs(bottomRight.y),
  );
  const tolerance = AFFINE_QUAD_EPSILON * scale;
  return Math.abs(bottomRight.x - expectedX) <= tolerance && Math.abs(bottomRight.y - expectedY) <= tolerance;
}

function drawAffineRasterTile(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { height: number; width: number },
  topLeft: CanvasRasterScreenPoint,
  topRight: CanvasRasterScreenPoint,
  bottomLeft: CanvasRasterScreenPoint,
  devicePixelRatio: number,
) {
  if (image.width <= 0 || image.height <= 0) return false;

  const a = (topRight.x - topLeft.x) / image.width;
  const b = (topRight.y - topLeft.y) / image.width;
  const c = (bottomLeft.x - topLeft.x) / image.height;
  const d = (bottomLeft.y - topLeft.y) / image.height;
  if (![a, b, c, d, topLeft.x, topLeft.y].every(Number.isFinite)) return false;

  context.save();
  context.setTransform(
    devicePixelRatio * a,
    devicePixelRatio * b,
    devicePixelRatio * c,
    devicePixelRatio * d,
    devicePixelRatio * topLeft.x,
    devicePixelRatio * topLeft.y,
  );
  context.drawImage(image, 0, 0);
  context.restore();
  return true;
}

function drawRasterTriangle(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  triangle: CanvasRasterTriangle,
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

function triangleTransform(triangle: CanvasRasterTriangle) {
  const [first, second, third] = triangle;
  const determinant =
    first.sourceX * (second.sourceY - third.sourceY) +
    second.sourceX * (third.sourceY - first.sourceY) +
    third.sourceX * (first.sourceY - second.sourceY);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= HOMOGENEOUS_EPSILON) {
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
