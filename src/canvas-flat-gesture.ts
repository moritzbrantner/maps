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
    pointerCount() {
      return pointers.size;
    },
    pointerDown(pointerId: number, point: Point) {
      pointers.set(pointerId, point);
    },
    pointerMove(pointerId: number, point: Point): MapsPointerGestureDelta | null {
      const previousPoint = pointers.get(pointerId);
      if (!previousPoint) return null;

      const activePair = activePointerPair(pointers);
      if (activePair && !activePair.includes(pointerId)) {
        pointers.set(pointerId, point);
        return null;
      }

      if (!activePair) {
        pointers.set(pointerId, point);
        const deltaX = point.x - previousPoint.x;
        const deltaY = point.y - previousPoint.y;
        if (deltaX === 0 && deltaY === 0) return null;
        return { type: "pan", deltaX, deltaY };
      }

      const previousLeft = pointers.get(activePair[0]);
      const previousRight = pointers.get(activePair[1]);
      if (!previousLeft || !previousRight) return null;

      pointers.set(pointerId, point);

      const nextLeft = pointers.get(activePair[0]);
      const nextRight = pointers.get(activePair[1]);
      if (!nextLeft || !nextRight) return null;

      const previousCenter = midpoint(previousLeft, previousRight);
      const nextCenter = midpoint(nextLeft, nextRight);
      const previousDistance = distance(previousLeft, previousRight);
      const nextDistance = distance(nextLeft, nextRight);
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
  const first = ids[0];
  const second = ids[1];
  return first === undefined || second === undefined ? null : [first, second];
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
