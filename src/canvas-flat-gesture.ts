export type MapsPointerGestureDelta =
  | {
      type: "pan";
      deltaX: number;
      deltaY: number;
    }
  | {
      type: "pinch";
      deltaX: number;
      deltaY: number;
      deltaZoom: number;
      x: number;
      y: number;
    };

type Point = {
  x: number;
  y: number;
};

const MIN_PINCH_DISTANCE = 1e-9;

export function createMapsPointerGesture() {
  const pointers = new Map<number, Point>();

  return {
    clear() {
      pointers.clear();
    },
    pointerDown(pointerId: number, point: Point) {
      pointers.set(pointerId, point);
    },
    pointerMove(pointerId: number, point: Point): MapsPointerGestureDelta | null {
      const previousPoint = pointers.get(pointerId);
      if (!previousPoint) return null;

      const activePair = activePointerPair(pointers);
      const previousPair = activePair
        ? activePair.map((id) => pointers.get(id) as Point)
        : null;

      pointers.set(pointerId, point);

      if (!activePair || !previousPair) {
        const deltaX = point.x - previousPoint.x;
        const deltaY = point.y - previousPoint.y;
        if (deltaX === 0 && deltaY === 0) return null;
        return { type: "pan", deltaX, deltaY };
      }

      if (!activePair.includes(pointerId)) return null;

      const nextPair = activePair.map((id) => pointers.get(id) as Point);
      const previousCenter = midpoint(previousPair[0], previousPair[1]);
      const nextCenter = midpoint(nextPair[0], nextPair[1]);
      const previousDistance = distance(previousPair[0], previousPair[1]);
      const nextDistance = distance(nextPair[0], nextPair[1]);
      const deltaZoom =
        previousDistance > MIN_PINCH_DISTANCE && nextDistance > MIN_PINCH_DISTANCE
          ? Math.log2(nextDistance / previousDistance)
          : 0;
      const deltaX = nextCenter.x - previousCenter.x;
      const deltaY = nextCenter.y - previousCenter.y;

      if (deltaX === 0 && deltaY === 0 && deltaZoom === 0) return null;

      return {
        type: "pinch",
        deltaX,
        deltaY,
        deltaZoom,
        x: nextCenter.x,
        y: nextCenter.y,
      };
    },
    pointerUp(pointerId: number) {
      pointers.delete(pointerId);
    },
  };
}

function activePointerPair(pointers: Map<number, Point>): [number, number] | null {
  if (pointers.size < 2) return null;
  const ids = [...pointers.keys()].sort((left, right) => left - right);
  return [ids[0], ids[1]];
}

function midpoint(left: Point, right: Point): Point {
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
  };
}

function distance(left: Point, right: Point) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}
