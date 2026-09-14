import type {
  MapVectorRenderFrame,
  MapVectorRenderPrimitive,
} from "./map-render-frame";

export type MapScreenPoint = { x: number; y: number };
export type MapScreenProject = (
  coordinate: [longitude: number, latitude: number],
) => MapScreenPoint | null;

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
 * Maps-owned screen-space render frame shared by pixel backends and hit testing.
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
  return {
    height: Math.max(0, size.height),
    primitives: frame.primitives.flatMap((primitive) => projectPrimitive(primitive, project)),
    width: Math.max(0, size.width),
  };
}

function projectPrimitive<TFeature>(
  primitive: MapVectorRenderPrimitive<TFeature>,
  project: MapScreenProject,
): Array<MapScreenRenderPrimitive<TFeature>> {
  switch (primitive.kind) {
    case "circle": {
      const center = project(primitive.center);
      if (!isFinitePoint(center)) return [];
      return [{ kind: "circle", renderPrimitive: primitive, x: center.x, y: center.y }];
    }
    case "direction-marker": {
      const anchor = project(primitive.anchor);
      const previous = project(primitive.previous);
      if (!isFinitePoint(anchor) || !isFinitePoint(previous)) return [];
      return [
        {
          angle: Math.atan2(anchor.y - previous.y, anchor.x - previous.x),
          kind: "direction-marker",
          renderPrimitive: primitive,
          x: anchor.x,
          y: anchor.y,
        },
      ];
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
  project: MapScreenProject,
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
