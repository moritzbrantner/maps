import type {
  MapCircleRenderItem,
  MapLineRenderItem,
  MapPolygonRenderItem,
  MapRenderFrame,
} from "./map-render-frame";

type ScreenPoint = { x: number; y: number };

export type CanvasMapCircle<TFeature = unknown> = {
  renderItem: MapCircleRenderItem<TFeature>;
  x: number;
  y: number;
};

export type CanvasMapLine<TFeature = unknown> = {
  points: ScreenPoint[];
  renderItem: MapLineRenderItem<TFeature>;
};

export type CanvasMapPolygon<TFeature = unknown> = {
  renderItem: MapPolygonRenderItem<TFeature>;
  rings: ScreenPoint[][];
};

export type CanvasMapSceneBatch<TFeature = unknown> =
  | { items: Array<CanvasMapCircle<TFeature>>; kind: "circles" }
  | { items: Array<CanvasMapLine<TFeature>>; kind: "lines" }
  | { items: Array<CanvasMapPolygon<TFeature>>; kind: "polygons" };

export type CanvasMapScene<TFeature = unknown> = {
  batches: Array<CanvasMapSceneBatch<TFeature>>;
  height: number;
  width: number;
};

export type CanvasMapDrawOptions = {
  hoveredFeatureId?: string | null;
  selectedFeatureId?: string | null;
};

export type CanvasMapHit<TFeature = unknown> = {
  feature: TFeature;
  id: string;
};

export function createCanvasMapScene<TFeature = unknown>(
  frame: MapRenderFrame<TFeature>,
  project: (coordinate: [longitude: number, latitude: number]) => ScreenPoint,
  size: { height: number; width: number },
): CanvasMapScene<TFeature> {
  return {
    batches: frame.batches.map((batch): CanvasMapSceneBatch<TFeature> => {
      switch (batch.kind) {
        case "circles":
          return {
            kind: "circles",
            items: batch.items.flatMap((renderItem) => {
              const point = projectFinite(renderItem.coordinates, project);
              return point ? [{ renderItem, ...point }] : [];
            }),
          };
        case "lines":
          return {
            kind: "lines",
            items: batch.items.flatMap((renderItem) => {
              const points = renderItem.coordinates.map((coordinate) =>
                projectFinite(coordinate, project),
              );
              return points.every((point): point is ScreenPoint => point !== null)
                ? [{ points, renderItem }]
                : [];
            }),
          };
        case "polygons":
          return {
            kind: "polygons",
            items: batch.items.flatMap((renderItem) => {
              const rings = renderItem.rings.map((ring) =>
                ring.map((coordinate) => projectFinite(coordinate, project)),
              );
              return rings.every((ring) =>
                ring.every((point): point is ScreenPoint => point !== null),
              )
                ? [{ renderItem, rings: rings as ScreenPoint[][] }]
                : [];
            }),
          };
      }
    }),
    height: Math.max(0, size.height),
    width: Math.max(0, size.width),
  };
}

export function drawCanvasMapScene<TFeature = unknown>(
  context: CanvasRenderingContext2D,
  scene: CanvasMapScene<TFeature>,
  options: CanvasMapDrawOptions = {},
) {
  context.clearRect(0, 0, scene.width, scene.height);
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const batch of scene.batches) {
    switch (batch.kind) {
      case "circles":
        for (const candidate of batch.items) drawCircle(context, candidate, options);
        break;
      case "lines":
        for (const candidate of batch.items) drawLine(context, candidate, options);
        break;
      case "polygons":
        for (const candidate of batch.items) drawPolygon(context, candidate, options);
        break;
    }
  }

  context.globalAlpha = 1;
}

export function hitTestCanvasMapScene<TFeature = unknown>(
  scene: CanvasMapScene<TFeature>,
  point: ScreenPoint,
): CanvasMapHit<TFeature> | null {
  for (let batchIndex = scene.batches.length - 1; batchIndex >= 0; batchIndex -= 1) {
    const batch = scene.batches[batchIndex]!;

    for (let itemIndex = batch.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const candidate = batch.items[itemIndex]!;

      if (!candidate.renderItem.interactive) continue;

      const hit =
        batch.kind === "circles"
          ? hitCircle(candidate as CanvasMapCircle<TFeature>, point)
          : batch.kind === "lines"
            ? hitLine(candidate as CanvasMapLine<TFeature>, point)
            : hitPolygon(candidate as CanvasMapPolygon<TFeature>, point);

      if (hit) {
        return {
          feature: candidate.renderItem.feature,
          id: candidate.renderItem.id,
        };
      }
    }
  }

  return null;
}

function projectFinite(
  coordinate: [number, number],
  project: (coordinate: [number, number]) => ScreenPoint,
): ScreenPoint | null {
  const point = project(coordinate);
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

function drawCircle<TFeature>(
  context: CanvasRenderingContext2D,
  candidate: CanvasMapCircle<TFeature>,
  options: CanvasMapDrawOptions,
) {
  const { renderItem, x, y } = candidate;
  const hovered = options.hoveredFeatureId === renderItem.id;
  const selected = options.selectedFeatureId === renderItem.id;

  context.beginPath();
  context.arc(x, y, renderItem.radius, 0, Math.PI * 2);
  context.fillStyle = renderItem.fillColor;
  context.globalAlpha = hovered ? Math.min(1, renderItem.fillOpacity + 0.08) : renderItem.fillOpacity;
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = renderItem.strokeColor;
  context.lineWidth = renderItem.strokeWidth + (selected ? 2 : hovered ? 1 : 0);
  context.stroke();

  if (renderItem.label) {
    context.fillStyle = "#ffffff";
    context.font = "600 12px system-ui, sans-serif";
    context.fillText(renderItem.label, x, y);
  }
}

function drawLine<TFeature>(
  context: CanvasRenderingContext2D,
  candidate: CanvasMapLine<TFeature>,
  options: CanvasMapDrawOptions,
) {
  if (candidate.points.length === 0) return;
  const { renderItem } = candidate;
  const hovered = options.hoveredFeatureId === renderItem.id;
  const selected = options.selectedFeatureId === renderItem.id;

  context.beginPath();
  context.moveTo(candidate.points[0]!.x, candidate.points[0]!.y);
  for (const point of candidate.points.slice(1)) context.lineTo(point.x, point.y);
  context.strokeStyle = renderItem.strokeColor;
  context.globalAlpha = renderItem.strokeOpacity;
  context.lineWidth = renderItem.strokeWidth + (selected ? 2 : hovered ? 1 : 0);
  context.stroke();
  context.globalAlpha = 1;
}

function drawPolygon<TFeature>(
  context: CanvasRenderingContext2D,
  candidate: CanvasMapPolygon<TFeature>,
  options: CanvasMapDrawOptions,
) {
  const { renderItem } = candidate;
  const hovered = options.hoveredFeatureId === renderItem.id;
  const selected = options.selectedFeatureId === renderItem.id;

  context.beginPath();
  for (const ring of candidate.rings) {
    if (ring.length === 0) continue;
    context.moveTo(ring[0]!.x, ring[0]!.y);
    for (const point of ring.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
  }
  context.fillStyle = renderItem.fillColor;
  context.globalAlpha = hovered ? Math.min(1, renderItem.fillOpacity + 0.08) : renderItem.fillOpacity;
  context.fill("evenodd");
  context.globalAlpha = renderItem.strokeOpacity;
  context.strokeStyle = renderItem.strokeColor;
  context.lineWidth = renderItem.strokeWidth + (selected ? 2 : hovered ? 1 : 0);
  context.stroke();
  context.globalAlpha = 1;
}

function hitCircle<TFeature>(candidate: CanvasMapCircle<TFeature>, point: ScreenPoint) {
  const dx = point.x - candidate.x;
  const dy = point.y - candidate.y;
  const radius = Math.max(8, candidate.renderItem.radius);
  return dx * dx + dy * dy <= radius * radius;
}

function hitLine<TFeature>(candidate: CanvasMapLine<TFeature>, point: ScreenPoint) {
  const tolerance = Math.max(6, candidate.renderItem.strokeWidth / 2 + 2);
  for (let index = 1; index < candidate.points.length; index += 1) {
    if (distanceToSegmentSquared(point, candidate.points[index - 1]!, candidate.points[index]!) <= tolerance * tolerance) {
      return true;
    }
  }
  return false;
}

function hitPolygon<TFeature>(candidate: CanvasMapPolygon<TFeature>, point: ScreenPoint) {
  let inside = false;
  for (const ring of candidate.rings) {
    if (pointInRing(point, ring)) inside = !inside;
  }
  if (inside) return true;

  const tolerance = Math.max(4, candidate.renderItem.strokeWidth / 2 + 1);
  return candidate.rings.some((ring) => ringHit(ring, point, tolerance));
}

function pointInRing(point: ScreenPoint, ring: ScreenPoint[]) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const a = ring[current]!;
    const b = ring[previous]!;
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function ringHit(ring: ScreenPoint[], point: ScreenPoint, tolerance: number) {
  if (ring.length < 2) return false;
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    if (distanceToSegmentSquared(point, ring[index]!, ring[next]!) <= tolerance * tolerance) {
      return true;
    }
  }
  return false;
}

function distanceToSegmentSquared(point: ScreenPoint, start: ScreenPoint, end: ScreenPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return px * px + py * py;
  }
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  const nearestX = start.x + projection * dx;
  const nearestY = start.y + projection * dy;
  const px = point.x - nearestX;
  const py = point.y - nearestY;
  return px * px + py * py;
}
