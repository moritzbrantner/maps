import type {
  MapRenderCircle,
  MapRenderDirectionMarker,
  MapRenderLine,
  MapRenderPolygon,
  MapVectorRenderFrame,
} from "./map-render-frame";
import {
  createMapScreenRenderFrame,
  type MapScreenCircle,
  type MapScreenDirectionMarker,
  type MapScreenInteractionState,
  type MapScreenLine,
  type MapScreenPoint as SharedMapScreenPoint,
  type MapScreenPolygon,
  type MapScreenProject,
  type MapScreenRenderFrame,
  type MapScreenRenderPrimitive,
} from "./map-screen-render-frame";

export type MapScreenPoint = SharedMapScreenPoint;
export type MapRenderProject = MapScreenProject;
export type CanvasCircleScenePrimitive<TFeature = unknown> = MapScreenCircle<TFeature>;
export type CanvasDirectionMarkerScenePrimitive<TFeature = unknown> =
  MapScreenDirectionMarker<TFeature>;
export type CanvasLineScenePrimitive<TFeature = unknown> = MapScreenLine<TFeature>;
export type CanvasPolygonScenePrimitive<TFeature = unknown> = MapScreenPolygon<TFeature>;
export type CanvasMapScenePrimitive<TFeature = unknown> = MapScreenRenderPrimitive<TFeature>;
export type CanvasMapScene<TFeature = unknown> = MapScreenRenderFrame<TFeature>;

export type CanvasMapDrawOptions = MapScreenInteractionState & {
  hoveredFeatureId?: string | null;
  selectedFeatureId?: string | null;
};

export function createCanvasMapScene<TFeature = unknown>(
  frame: MapVectorRenderFrame<TFeature>,
  project: MapRenderProject,
  size: { height: number; width: number },
): CanvasMapScene<TFeature> {
  return createMapScreenRenderFrame(frame, project, size);
}

export function hitTestCanvasMapScene<TFeature = unknown>(
  scene: CanvasMapScene<TFeature>,
  point: MapScreenPoint,
): CanvasMapScenePrimitive<TFeature> | null {
  for (let index = scene.primitives.length - 1; index >= 0; index -= 1) {
    const candidate = scene.primitives[index]!;
    if (candidate.renderPrimitive.interactive && hitPrimitive(candidate, point)) return candidate;
  }
  return null;
}

export function drawCanvasMapScene<TFeature = unknown>(
  context: CanvasRenderingContext2D,
  scene: CanvasMapScene<TFeature>,
  options: CanvasMapDrawOptions = {},
) {
  context.clearRect(0, 0, scene.width, scene.height);

  for (const scenePrimitive of scene.primitives) {
    const primitive = scenePrimitive.renderPrimitive;
    switch (scenePrimitive.kind) {
      case "circle":
        drawCircle(context, scenePrimitive, primitive as MapRenderCircle<TFeature>, options);
        break;
      case "direction-marker":
        drawDirectionMarker(
          context,
          scenePrimitive,
          primitive as MapRenderDirectionMarker<TFeature>,
        );
        break;
      case "line":
        drawLine(context, scenePrimitive, primitive as MapRenderLine<TFeature>, options);
        break;
      case "polygon":
        drawPolygon(context, scenePrimitive, primitive as MapRenderPolygon<TFeature>, options);
    }
  }
}

export function drawCanvasMapLabels<TFeature = unknown>(
  context: CanvasRenderingContext2D,
  scene: CanvasMapScene<TFeature>,
) {
  context.clearRect(0, 0, scene.width, scene.height);
  for (const scenePrimitive of scene.primitives) {
    if (scenePrimitive.kind !== "circle") continue;
    const label = (scenePrimitive.renderPrimitive as MapRenderCircle<TFeature>).label;
    if (label) drawCircleLabel(context, scenePrimitive, label);
  }
}

function drawDirectionMarker<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasDirectionMarkerScenePrimitive<TFeature>,
  primitive: MapRenderDirectionMarker<TFeature>,
) {
  const size = Math.max(0, primitive.size);
  context.save();
  context.translate(scene.x, scene.y);
  context.rotate(scene.angle);
  context.beginPath();
  context.moveTo(size * 0.38, 0);
  context.lineTo(size * -0.62, size * -0.42);
  context.lineTo(size * -0.62, size * 0.42);
  context.closePath();
  context.fillStyle = primitive.color;
  context.globalAlpha = primitive.opacity;
  context.fill();
  context.restore();
}

function drawCircle<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasCircleScenePrimitive<TFeature>,
  primitive: MapRenderCircle<TFeature>,
  options: CanvasMapDrawOptions,
) {
  context.beginPath();
  context.arc(scene.x, scene.y, primitive.radius, 0, Math.PI * 2);
  context.fillStyle = primitive.fillColor;
  context.globalAlpha = primitive.fillOpacity;
  context.fill();
  stroke(context, primitive, options);
  if (primitive.label) drawCircleLabel(context, scene, primitive.label);
}

function drawCircleLabel<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasCircleScenePrimitive<TFeature>,
  label: string,
) {
  context.globalAlpha = 1;
  context.fillStyle = "#ffffff";
  context.font = "600 12px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, scene.x, scene.y);
}

function drawLine<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasLineScenePrimitive<TFeature>,
  primitive: MapRenderLine<TFeature>,
  options: CanvasMapDrawOptions,
) {
  traceLine(context, scene.points, false);
  context.lineCap = "round";
  context.lineJoin = "round";
  stroke(context, primitive, options);
}

function drawPolygon<TFeature>(
  context: CanvasRenderingContext2D,
  scene: CanvasPolygonScenePrimitive<TFeature>,
  primitive: MapRenderPolygon<TFeature>,
  options: CanvasMapDrawOptions,
) {
  context.beginPath();
  for (const ring of scene.rings) traceLine(context, ring, true, false);
  context.fillStyle = primitive.fillColor;
  context.globalAlpha = primitive.fillOpacity;
  context.fill("evenodd");
  context.lineJoin = "round";
  stroke(context, primitive, options);
}

function stroke(
  context: CanvasRenderingContext2D,
  primitive: MapRenderCircle | MapRenderLine | MapRenderPolygon,
  options: CanvasMapDrawOptions,
) {
  context.globalAlpha = primitive.strokeOpacity;
  context.lineWidth = resolveCanvasStrokeWidth(primitive, options);
  context.strokeStyle = primitive.strokeColor;
  context.stroke();
  context.globalAlpha = 1;
}

function resolveCanvasStrokeWidth(
  primitive: MapRenderCircle | MapRenderLine | MapRenderPolygon,
  options: CanvasMapDrawOptions,
) {
  const selected =
    options.selectedPrimitiveIds?.has(primitive.primitiveId) ??
    options.selectedFeatureId === primitive.featureId;
  const hovered =
    options.hoveredPrimitiveIds?.has(primitive.primitiveId) ??
    options.hoveredFeatureId === primitive.featureId;
  return Math.max(0, primitive.strokeWidth + (selected ? 1.5 : hovered ? 1 : 0));
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

function hitPrimitive<TFeature>(
  primitive: CanvasMapScenePrimitive<TFeature>,
  point: MapScreenPoint,
) {
  switch (primitive.kind) {
    case "circle": {
      const radius = Math.max(8, (primitive.renderPrimitive as MapRenderCircle<TFeature>).radius);
      return squaredDistance(point, { x: primitive.x, y: primitive.y }) <= radius * radius;
    }
    case "direction-marker":
      return false;
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
        (ring) => squaredDistanceToPolyline(point, ring, true) <= tolerance * tolerance,
      );
    }
  }
}

function pointInRings(point: MapScreenPoint, rings: readonly MapScreenPoint[][]) {
  let inside = false;
  for (const ring of rings) {
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
      const a = ring[current]!;
      const b = ring[previous]!;
      const crosses =
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

function squaredDistanceToPolyline(
  point: MapScreenPoint,
  points: readonly MapScreenPoint[],
  closed = false,
) {
  if (points.length < 2) return Number.POSITIVE_INFINITY;
  let minimum = closed
    ? squaredDistanceToSegment(point, points[points.length - 1]!, points[0]!)
    : Number.POSITIVE_INFINITY;
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
