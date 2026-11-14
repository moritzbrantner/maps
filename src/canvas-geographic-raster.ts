import type { MapScreenProject } from "./map-screen-render-frame";

export type CanvasGeographicRasterBounds = [
  west: number,
  south: number,
  east: number,
  north: number,
];

export type CanvasGeographicRasterProject = MapScreenProject;

export type CanvasGeographicRasterVerticalScale = "latitude" | "mercator";

type RasterVertex = {
  sourceX: number;
  sourceY: number;
  x: number;
  y: number;
};

type RasterTriangle = readonly [RasterVertex, RasterVertex, RasterVertex];

type RasterVertexAt = ((u: number, v: number) => RasterVertex | null) & {
  prepare(samples: [number, number][]): void;
};

const TRANSFORM_EPSILON = 1e-7;
const MAX_MERCATOR_LATITUDE = 85.05112878;

/** Draws a geographic raster as affine triangles and returns how many triangles it drew. */
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
}): number {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    !Number.isInteger(subdivisions) ||
    subdivisions < 1 ||
    subdivisions > 32
  ) {
    return 0;
  }

  context.save();
  context.globalAlpha = clamp(opacity, 0, 1);
  let drawn = 0;
  visitGeographicRasterTriangles({
    bounds,
    image,
    project,
    subdivisions,
    verticalScale,
    view: {
      width: context.canvas?.width / devicePixelRatio || Infinity,
      height: context.canvas?.height / devicePixelRatio || Infinity,
    },
    drawTriangle: (triangle) => {
      if (drawRasterTriangle(context, image, triangle, devicePixelRatio)) drawn += 1;
    },
  });
  context.restore();
  return drawn;
}

/** The same adaptive projected mesh consumed by both pixel backends. */
export function createGeographicRasterMesh({
  bounds,
  image,
  project,
  verticalScale,
  width,
  height,
}: {
  bounds: CanvasGeographicRasterBounds;
  image: { width: number; height: number };
  project: CanvasGeographicRasterProject;
  verticalScale: CanvasGeographicRasterVerticalScale;
  width: number;
  height: number;
}): number[] {
  const vertices: number[] = [];
  visitGeographicRasterTriangles({
    bounds,
    image,
    project,
    verticalScale,
    subdivisions: 8,
    view: { width, height },
    drawTriangle: (triangle) => {
      if (!triangleTransform(triangle)) return;
      for (const vertex of triangle)
        vertices.push(
          vertex.x,
          vertex.y,
          vertex.sourceX / image.width,
          vertex.sourceY / image.height,
        );
    },
  });
  return vertices;
}

function visitGeographicRasterTriangles({
  bounds,
  image,
  project,
  subdivisions,
  verticalScale,
  view,
  drawTriangle,
}: {
  bounds: CanvasGeographicRasterBounds;
  image: { width: number; height: number };
  project: CanvasGeographicRasterProject;
  subdivisions: number;
  verticalScale: CanvasGeographicRasterVerticalScale;
  view: { width: number; height: number };
  drawTriangle: (triangle: RasterTriangle) => void;
}) {
  // Only this draw owns the cache: a new camera must project every needed sample anew.
  // The scalar path remains the uncached reference for packed projection parity.
  const projected = new Map<number, RasterVertex | null>();
  const resolution = subdivisions * 2 ** (MAX_CELL_SPLIT_DEPTH + 1);
  // All samples lie on this dyadic lattice. Numeric keys avoid allocating strings per sample.
  const sampleKey = (u: number, v: number) =>
    Math.round(u * resolution) + Math.round(v * resolution) * (resolution + 1);
  const coordinateAt = (u: number, v: number): [number, number] => [
    bounds[0] + (bounds[2] - bounds[0]) * u,
    interpolateLatitude(bounds[1], bounds[3], v, verticalScale),
  ];
  const vertexAt: RasterVertexAt = (u, v) => {
    const cached = projected.get(sampleKey(u, v));
    if (cached !== undefined) return cached;
    const latitude = interpolateLatitude(bounds[1], bounds[3], v, verticalScale);
    const longitude = bounds[0] + (bounds[2] - bounds[0]) * u;
    let screen;
    try {
      screen = project([longitude, latitude]);
    } catch {
      return null;
    }
    return isFinitePoint(screen)
      ? { sourceX: image.width * u, sourceY: image.height * v, x: screen.x, y: screen.y }
      : null;
  };
  vertexAt.prepare = (samples) => {
    if (!project.projectPacked) return;
    const missing: [number, number][] = [];
    const keys = new Set<number>();
    for (const sample of samples) {
      const key = sampleKey(...sample);
      if (!projected.has(key) && !keys.has(key)) {
        keys.add(key);
        missing.push(sample);
      }
    }
    if (missing.length === 0) return;
    const coordinates = new Float64Array(missing.length * 2);
    for (let i = 0; i < missing.length; i += 1) {
      const coordinate = coordinateAt(...missing[i]!);
      coordinates[i * 2] = coordinate[0];
      coordinates[i * 2 + 1] = coordinate[1];
    }
    let points: Float64Array | null;
    try {
      points = project.projectPacked(coordinates);
    } catch {
      // Match the vector renderer: a custom packed projector may be unavailable while
      // its scalar projection still works. Each rejected scalar point remains invisible.
      return;
    }
    if (!points || points.length !== coordinates.length) return;
    for (let i = 0; i < missing.length; i += 1) {
      const [u, v] = missing[i]!;
      const x = points[i * 2]!;
      const y = points[i * 2 + 1]!;
      projected.set(
        sampleKey(u, v),
        Number.isFinite(x) && Number.isFinite(y)
          ? { sourceX: image.width * u, sourceY: image.height * v, x, y }
          : null,
      );
    }
  };
  const rowLength = subdivisions + 1;
  const vertices: Array<RasterVertex | null> = Array.from(
    { length: rowLength * rowLength },
    () => null,
  );

  const samples: [number, number][] = [];
  for (let row = 0; row <= subdivisions; row += 1) {
    for (let column = 0; column <= subdivisions; column += 1) {
      samples.push([column / subdivisions, row / subdivisions]);
    }
  }
  vertexAt.prepare(samples);
  for (let row = 0; row <= subdivisions; row += 1) {
    for (let column = 0; column <= subdivisions; column += 1) {
      vertices[row * rowLength + column] = vertexAt(column / subdivisions, row / subdivisions);
    }
  }

  const roots: RasterCellNode[] = [];
  for (let row = 0; row < subdivisions; row += 1) {
    for (let column = 0; column < subdivisions; column += 1) {
      const cell = {
        bottomLeft: vertices[(row + 1) * rowLength + column]!,
        bottomRight: vertices[(row + 1) * rowLength + column + 1]!,
        topLeft: vertices[row * rowLength + column]!,
        topRight: vertices[row * rowLength + column + 1]!,
        u0: column / subdivisions,
        u1: (column + 1) / subdivisions,
        v0: row / subdivisions,
        v1: (row + 1) / subdivisions,
      };
      if (project.projectPacked) {
        roots.push({ cell, depth: { u: 0, v: 0 }, children: [], triangles: [] });
      } else {
        drawRasterCell(cell, { u: 0, v: 0 }, vertexAt, view, drawTriangle);
      }
    }
  }
  // Project one adaptive frontier at a time. Preserve the original depth-first triangle order
  // when emitting leaves, so the optimization changes only boundary crossings, never pixels.
  let frontier = roots;
  while (frontier.length > 0) {
    vertexAt.prepare(
      frontier.flatMap(({ cell, depth }) => {
        if (depth.u >= MAX_CELL_SPLIT_DEPTH && depth.v >= MAX_CELL_SPLIT_DEPTH) {
          return [];
        }
        const corners = [cell.topLeft, cell.topRight, cell.bottomLeft, cell.bottomRight];
        if (corners.every((corner) => corner === null)) {
          return [];
        }
        const finite = corners.filter((corner) => corner !== null);
        if (finite.length === 4 && isCellOffScreen(finite, view)) {
          return [];
        }
        return rasterCellSamples(cell);
      }),
    );
    const next: RasterCellNode[] = [];
    for (const node of frontier) {
      drawRasterCell(
        node.cell,
        node.depth,
        vertexAt,
        view,
        (triangle) => node.triangles.push(triangle),
        (cell, depth) => {
          const child: RasterCellNode = { cell, depth, children: [], triangles: [] };
          node.children.push(child);
          next.push(child);
        },
      );
    }
    frontier = next;
  }
  const emit = (node: RasterCellNode) => {
    for (const triangle of node.triangles) drawTriangle(triangle);
    for (const child of node.children) emit(child);
  };
  for (const root of roots) emit(root);
}

/**
 * Canvas can only map an image affinely, but a geographic raster's screen image is not affine:
 * latitude rows are not linear in Mercator, and a pitched camera adds perspective. Each cell is
 * split until the affine triangles agree with the projection within `MAX_AFFINE_ERROR_PX` at
 * the cell's center and edge midpoints, so the raster stays aligned with geometry projected
 * point by point (#171 phase 3: under pitch a fixed 8 × 8 mesh misplaced a stable density
 * raster by up to 14 px). Cells entirely off screen are neither split nor drawn.
 */
const MAX_AFFINE_ERROR_PX = 0.5;
const MAX_CELL_SPLIT_DEPTH = 5;

type RasterCell = {
  bottomLeft: RasterVertex | null;
  bottomRight: RasterVertex | null;
  topLeft: RasterVertex | null;
  topRight: RasterVertex | null;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
};

type RasterCellNode = {
  cell: RasterCell;
  depth: { u: number; v: number };
  children: RasterCellNode[];
  triangles: RasterTriangle[];
};

function rasterCellSamples({ u0, u1, v0, v1 }: RasterCell): [number, number][] {
  const uMid = (u0 + u1) / 2;
  const vMid = (v0 + v1) / 2;
  return [
    [uMid, v0],
    [uMid, v1],
    [u0, vMid],
    [u1, vMid],
    [uMid, vMid],
  ];
}

function drawRasterCell(
  cell: RasterCell,
  depth: { u: number; v: number },
  vertexAt: RasterVertexAt,
  view: { height: number; width: number },
  drawTriangle: (triangle: RasterTriangle) => void,
  visitChild?: (cell: RasterCell, depth: { u: number; v: number }) => void,
) {
  const child = (cell: RasterCell, depth: { u: number; v: number }) => {
    if (visitChild) visitChild(cell, depth);
    else drawRasterCell(cell, depth, vertexAt, view, drawTriangle);
  };
  const { bottomLeft, bottomRight, topLeft, topRight, u0, u1, v0, v1 } = cell;
  const corners = [topLeft, topRight, bottomLeft, bottomRight];
  if (corners.every((corner) => corner === null)) return;
  const complete = corners.every((corner) => corner !== null);
  if (complete && isCellOffScreen(corners as RasterVertex[], view)) return;

  const canSplitU = depth.u < MAX_CELL_SPLIT_DEPTH;
  const canSplitV = depth.v < MAX_CELL_SPLIT_DEPTH;
  if (canSplitU || canSplitV) {
    const uMid = (u0 + u1) / 2;
    const vMid = (v0 + v1) / 2;

    const top = vertexAt(uMid, v0);
    const bottom = vertexAt(uMid, v1);
    const left = vertexAt(u0, vMid);
    const right = vertexAt(u1, vMid);
    const center = vertexAt(uMid, vMid);
    // Perspective bends a cell mostly along one axis; split only the axis whose edges bend, so
    // the mesh does not multiply triangles along an axis that is already affine.
    const bentU =
      !complete ||
      exceedsAffineError(top, topLeft!, topRight!) ||
      exceedsAffineError(bottom, bottomLeft!, bottomRight!);
    const bentV =
      !complete ||
      exceedsAffineError(left, topLeft!, bottomLeft!) ||
      exceedsAffineError(right, topRight!, bottomRight!);
    // The center of the two triangles' shared diagonal: a twist neither edge pair shows.
    const twisted = complete && exceedsAffineError(center, topRight!, bottomLeft!);
    const splitU = canSplitU && (bentU || (twisted && !bentV));
    const splitV = canSplitV && (bentV || (twisted && !bentU));

    if (splitU && splitV) {
      const next = { u: depth.u + 1, v: depth.v + 1 };
      for (const cell of [
        {
          bottomLeft: left,
          bottomRight: center,
          topLeft,
          topRight: top,
          u0,
          u1: uMid,
          v0,
          v1: vMid,
        },
        {
          bottomLeft: center,
          bottomRight: right,
          topLeft: top,
          topRight,
          u0: uMid,
          u1,
          v0,
          v1: vMid,
        },
        {
          bottomLeft,
          bottomRight: bottom,
          topLeft: left,
          topRight: center,
          u0,
          u1: uMid,
          v0: vMid,
          v1,
        },
        {
          bottomLeft: bottom,
          bottomRight,
          topLeft: center,
          topRight: right,
          u0: uMid,
          u1,
          v0: vMid,
          v1,
        },
      ]) {
        child(cell, next);
      }
      return;
    }
    if (splitU) {
      const next = { u: depth.u + 1, v: depth.v };
      child(
        { bottomLeft, bottomRight: bottom, topLeft, topRight: top, u0, u1: uMid, v0, v1 },
        next,
      );
      child(
        { bottomLeft: bottom, bottomRight, topLeft: top, topRight, u0: uMid, u1, v0, v1 },
        next,
      );
      return;
    }
    if (splitV) {
      const next = { u: depth.u, v: depth.v + 1 };
      child(
        { bottomLeft: left, bottomRight: right, topLeft, topRight, u0, u1, v0, v1: vMid },
        next,
      );
      child(
        { bottomLeft, bottomRight, topLeft: left, topRight: right, u0, u1, v0: vMid, v1 },
        next,
      );
      return;
    }
  }

  if (topLeft && bottomLeft && topRight) drawTriangle([topLeft, bottomLeft, topRight]);
  if (topRight && bottomLeft && bottomRight) drawTriangle([topRight, bottomLeft, bottomRight]);
}

function exceedsAffineError(midpoint: RasterVertex | null, start: RasterVertex, end: RasterVertex) {
  return (
    midpoint === null ||
    Math.hypot(midpoint.x - (start.x + end.x) / 2, midpoint.y - (start.y + end.y) / 2) >
      MAX_AFFINE_ERROR_PX
  );
}

function isCellOffScreen(corners: RasterVertex[], view: { height: number; width: number }) {
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return (
    Math.max(...xs) < 0 ||
    Math.min(...xs) > view.width ||
    Math.max(...ys) < 0 ||
    Math.min(...ys) > view.height
  );
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
