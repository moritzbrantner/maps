import type {
  MapRenderCircle,
  MapRenderLine,
  MapRenderPolygon,
  MapVectorRenderFrame,
  MapVectorRenderPrimitive,
} from "./map-render-frame";

export type MapScreenPoint = { x: number; y: number };
export type MapRenderProject = (
  coordinate: [longitude: number, latitude: number],
) => MapScreenPoint | null;

type CanvasScenePrimitiveBase<TFeature> = {
  renderPrimitive: MapVectorRenderPrimitive<TFeature>;
};

export type CanvasCircleScenePrimitive<TFeature = unknown> = CanvasScenePrimitiveBase<TFeature> & {
  kind: "circle";
  x: number;
  y: number;
};

export type CanvasLineScenePrimitive<TFeature = unknown> = CanvasScenePrimitiveBase<TFeature> & {
  kind: "line";
  points: MapScreenPoint[];
};

export type CanvasPolygonScenePrimitive<TFeature = unknown> = CanvasScenePrimitiveBase<TFeature> & {
  kind: "polygon";
  rings: MapScreenPoint[][];
};

export type CanvasMapScenePrimitive<TFeature = unknown> =
  | CanvasCircleScenePrimitive<TFeature>
  | CanvasLineScenePrimitive<TFeature>
  | CanvasPolygonScenePrimitive<TFeature>;

export type CanvasMapScene<TFeature = unknown> = {
  height: number;
  primitives: Array<CanvasMapScenePrimitive<TFeature>>;
  width: number;
};

export type CanvasMapDrawOptions = {
  hoveredFeatureId?: string | null;
  selectedFeatureId?: string | null;
};

export function createCanvasMapScene<TFeature = unknown>(
  frame: MapVectorRenderFrame<TFeature>,
  project: MapRenderProject,
  size: { height: number; width: number },
): CanvasMapScene<TFeature> {
  return {
    height: Math.max(0, size.height),
    primitives: frame.primitives.flatMap((primitive) => projectPrimitive(primitive, project)),
    width: Math.max(0, size.width),
  };
}

export function hitTestCanvasMapScene<TFeature = unknown>(
  scene: CanvasMapScene<TFeature>,
  point: MapScreenPoint,
): CanvasMapScenePrimitive<TFeature> | null {
  for (let index = scene.primitives.length - 1; index >= 0; index -= 1) {
    const candidate = scene.primitives[index]!;
    if (!candidate.renderPrimitive.interactive) continue;

    if (hitPrimitive(candidate, point)) {
      return candidate;
    }
  }

  return null;
}

export function drawCanvasMapScene<TFeature = unknown>(
  context: CanvasRenderingContext2D,
  scene: CanvasMapScene<TFeature>,
  options: CanvasMapDrawOptions = {},
) {
  context.clearRect(0, 0, scene.width, scene.height);

  for (const primitive of scene.primitives) {
    drawPrimitive(context, primitive, options);
  }
}

function projectPrimitive<TFeature>(
  primitive: MapVectorRenderPrimitive<TFeature>,
  project: MapRenderProject,
): Array<CanvasMapScenePrimitive<TFeature>> {
  switch (primitive.kind) {
    case "circle": {
      const center = project(primitive.center);
      if (!isFinitePoint(center)) return [];
      return [{ kind: "circle", renderPrimitive: primitive, x: center.x, y: center.y }];
    }
    case "line": {
      const points = projectCoordinates(primitive.coordinates, project);
      if (!points || points.length < 2) return [];
      return [{ kind: "line", points, renderPrimitive: primitive }];
    }
    case "polygon": {
      const rings = primitive.rings.map((ring) => projectCoordinates(ring, project));
      if (rings.some((ring) => !ring || ring.length < 3)) return [];
      return [
        {
          kind: "polygon",
          renderPrimitive: primitive,
          rings: rings as MapScreenPoint[][],
        },
      ];
    }
  }
}

function projectCoordinates(
  coordinates: readonly [number, number][],
  project: MapRenderProject,
): MapScreenPoint[] | null {
  const points: MapScreenPoint[] = [];
  for (const coordinate of coordinates) {
    const point = project([coordinate[0], coordinate[1]]);
    if (!isFinitePoint(point)) return null;
    points.push(point);
  }
  return points;
}

function isFinitePoint(point: MapScreenPoint | null): point is MapScreenPoint {
  return point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function drawPrimitive<TFeature>(
  context: CanvasRenderingContext2D,
  scenePrimitive: CanvasMapScenePrimitive<TFeature>,
  options: CanvasMapDrawOptions,
) {
  const primitive = scenePrimitive.renderPrimitive;
  const selected = options.selectedFeatureId === primitive.featureId;
  const hovered = options.hoveredFeatureId === primitive.featureId;

  switch (scenePrimitive.kind) {
    case "circle":
      drawCircle(context, scenePrimitive, primitive as MapRenderCircle<TFeature>, selected, hovered);
      return;
    case "line":
      drawLine(context, scenePrimitive, primitive as MapRenderLine<TFeature>, selected, hovered);
      return;
    case "polygon":
      drawPolygon(
        context,
        scenePrimitive,
        primitive as MapRenderPolygon<TFeature>,
        selected,
        hovered,
      );
  }
}

function drawCircle<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasCircleScenePrimitive<TFeature>,
  primitive: MapRenderCircle<TFeature>,
  selected: boolean,
  hovered: boolean,
) {
  context.beginPath();
  context.arc(scene.x, scene.y, primitive.radius, 0, Math.PI * 2);
  context.fillStyle = primitive.fillColor;
  context.globalAlpha = primitive.fillOpacity;
  context.fill();
  context.globalAlpha = primitive.strokeOpacity;
  context.lineWidth = interactionStrokeWidth(primitive.strokeWidth, selected, hovered);
  context.strokeStyle = primitive.strokeColor;
  context.stroke();
  context.globalAlpha = 1;

  if (primitive.label) {
    context.fillStyle = "#ffffff";
    context.font = "600 12px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(primitive.label, scene.x, scene.y);
  }
}

function drawLine<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasLineScenePrimitive<TFeature>,
  primitive: MapRenderLine<TFeature>,
  selected: boolean,
  hovered: boolean,
) {
  traceLine(context, scene.points, false);
  context.globalAlpha = primitive.strokeOpacity;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = interactionStrokeWidth(primitive.strokeWidth, selected, hovered);
  context.strokeStyle = primitive.strokeColor;
  context.stroke();
  context.globalAlpha = 1;
}

function drawPolygon<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasPolygonScenePrimitive<TFeature>,
  primitive: MapRenderPolygon<TFeature>,
  selected: boolean,
  hovered: boolean,
) {
  context.beginPath();
  for (const ring of scene.rings) {
    traceLine(context, ring, true, false);
  }
  context.fillStyle = primitive.fillColor;
  context.globalAlpha = primitive.fillOpacity;
  context.fill("evenodd");
  context.globalAlpha = primitive.strokeOpacity;
  context.lineJoin = "round";
  context.lineWidth = interactionStrokeWidth(primitive.strokeWidth, selected, hovered);
  context.strokeStyle = primitive.strokeColor;
  context.stroke();
  context.globalAlpha = 1;
}

function traceLine(
  context: CanvasRenderingContext2D,
  points: readonly MapScreenPoint[],
  close: boolean,
  beginPath = true,
) {
  if (beginPath) context.beginPath();
  const first = points[0];
  if (!first) return;
  context.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    context.lineTo(point.x, point.y);
  }
  if (close) context.closePath();
}

function interactionStrokeWidth(base: number, selected: boolean, hovered: boolean) {
  return Math.max(0, base + (selected ? 1.5 : hovered ? 1 : 0));
}

function hitPrimitive<TFeature>(
  primitive: CanvasMapScenePrimitive<TFeature>,
  point: MapScreenPoint,
) {
  switch (primitive.kind) {
    case "circle": {
      const radius = Math.max(8, (primitive.renderPrimitive as MapRenderCircle<TFeature>).radius);
      return squaredDistance(point, { x: primitive.x, y: primitive.y }) <= radius * radius;
    }
    case "line": {
      const tolerance = Math.max(
        4,
        (primitive.renderPrimitive as MapRenderLine<TFeature>).strokeWidth / 2 + 2,
      );
      return squaredDistanceToPolyline(point, primitive.points) <= tolerance * tolerance;
    }
    case "polygon": {
      const renderPrimitive = primitive.renderPrimitive as MapRenderPolygon<TFeature>;
      if (pointInRings(point, primitive.rings)) return true;
      const tolerance = Math.max(4, renderPrimitive.strokeWidth / 2 + 2);
      return primitive.rings.some(
        (ring) => squaredDistanceToClosedPolyline(point, ring) <= tolerance * tolerance,
      );
    }
  }
}

function pointInRings(point: MapScreenPoint, rings: readonly MapScreenPoint[][]) {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(point, ring)) inside = !inside;
  }
  return inside;
}

function pointInRing(point: MapScreenPoint, ring: readonly MapScreenPoint[]) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const a = ring[current]!;
    const b = ring[previous]!;
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function squaredDistanceToClosedPolyline(point: MapScreenPoint, points: readonly MapScreenPoint[]) {
  if (points.length < 2) return Number.POSITIVE_INFINITY;
  return Math.min(
    squaredDistanceToPolyline(point, points),
    squaredDistanceToSegment(point, points[points.length - 1]!, points[0]!),
  );
}

function squaredDistanceToPolyline(point: MapScreenPoint, points: readonly MapScreenPoint[]) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    minimum = Math.min(minimum, squaredDistanceToSegment(point, points[index - 1]!, points[index]!));
  }
  return minimum;
}

function squaredDistanceToSegment(point: MapScreenPoint, start: MapScreenPoint, end: MapScreenPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return squaredDistance(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return squaredDistance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function squaredDistance(left: MapScreenPoint, right: MapScreenPoint) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}
