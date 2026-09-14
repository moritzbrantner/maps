import type {
  MapVectorRenderFrame,
  MapVectorRenderPrimitive,
} from "./map-render-frame";

export type MapScreenPoint = { x: number; y: number };
export type MapScreenProject = (
  coordinate: [longitude: number, latitude: number],
) => MapScreenPoint | null;

export type MapScreenInteractionState = {
  hoveredPrimitiveIds?: ReadonlySet<string>;
  selectedPrimitiveIds?: ReadonlySet<string>;
};

type MapScreenPrimitiveBase<TFeature> = {
  renderPrimitive: MapVectorRenderPrimitive<TFeature>;
};

export type MapScreenCircle<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  kind: "circle";
  x: number;
  y: number;
};

export type MapScreenDirectionMarker<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  angle: number;
  kind: "direction-marker";
  x: number;
  y: number;
};

export type MapScreenLine<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  kind: "line";
  points: MapScreenPoint[];
};

export type MapScreenPolygon<TFeature = unknown> = MapScreenPrimitiveBase<TFeature> & {
  kind: "polygon";
  rings: MapScreenPoint[][];
};

export type MapScreenRenderPrimitive<TFeature = unknown> =
  | MapScreenCircle<TFeature>
  | MapScreenDirectionMarker<TFeature>
  | MapScreenLine<TFeature>
  | MapScreenPolygon<TFeature>;

/**
 * Maps-owned screen-space render frame shared by concrete pixel backends and hit testing.
 *
 * Geographic projection remains authoritative in the Maps runtime. This frame
 * contains only the finite projected positions needed by browser renderers;
 * renderers must not recompute Mercator or camera semantics independently.
 */
export type MapScreenRenderFrame<TFeature = unknown> = {
  height: number;
  primitives: Array<MapScreenRenderPrimitive<TFeature>>;
  width: number;
};

export function createMapScreenRenderFrame<TFeature = unknown>(
  frame: MapVectorRenderFrame<TFeature>,
  project: MapScreenProject,
  size: { height: number; width: number },
): MapScreenRenderFrame<TFeature> {
  const primitives: Array<MapScreenRenderPrimitive<TFeature>> = [];

  for (const primitive of frame.primitives) {
    switch (primitive.kind) {
      case "circle": {
        const center = project(primitive.center);
        if (isFinitePoint(center)) {
          primitives.push({ kind: "circle", renderPrimitive: primitive, x: center.x, y: center.y });
        }
        break;
      }
      case "direction-marker": {
        const anchor = project(primitive.anchor);
        const previous = project(primitive.previous);
        if (isFinitePoint(anchor) && isFinitePoint(previous)) {
          primitives.push({
            angle: Math.atan2(anchor.y - previous.y, anchor.x - previous.x),
            kind: "direction-marker",
            renderPrimitive: primitive,
            x: anchor.x,
            y: anchor.y,
          });
        }
        break;
      }
      case "line": {
        const points = projectCoordinates(primitive.coordinates, project);
        if (points && points.length >= 2) {
          primitives.push({ kind: "line", points, renderPrimitive: primitive });
        }
        break;
      }
      case "polygon": {
        const rings: MapScreenPoint[][] = [];
        let valid = true;
        for (const ring of primitive.rings) {
          const projected = projectCoordinates(ring, project);
          if (!projected || projected.length < 3) {
            valid = false;
            break;
          }
          rings.push(projected);
        }
        if (valid) {
          primitives.push({ kind: "polygon", renderPrimitive: primitive, rings });
        }
        break;
      }
    }
  }

  return {
    height: Math.max(0, size.height),
    primitives,
    width: Math.max(0, size.width),
  };
}

export function resolveMapScreenStrokeWidth(
  base: number,
  primitiveId: string,
  interaction: MapScreenInteractionState = {},
) {
  const selected = interaction.selectedPrimitiveIds?.has(primitiveId);
  const hovered = interaction.hoveredPrimitiveIds?.has(primitiveId);
  return Math.max(0, base + (selected ? 1.5 : hovered ? 1 : 0));
}

function projectCoordinates(
  coordinates: readonly [number, number][],
  project: MapScreenProject,
): MapScreenPoint[] | null {
  const points: MapScreenPoint[] = [];
  for (const coordinate of coordinates) {
    const point = project(coordinate as [number, number]);
    if (!isFinitePoint(point)) return null;
    points.push(point);
  }
  return points;
}

function isFinitePoint(point: MapScreenPoint | null): point is MapScreenPoint {
  return point !== null && Number.isFinite(point.x) && Number.isFinite(point.y);
}
