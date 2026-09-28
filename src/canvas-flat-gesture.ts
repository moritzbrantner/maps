export type MapsPointerGestureDelta =
  | {
      type: "pan";
      deltaX: number;
      deltaY: number;
      previousX: number;
      previousY: number;
      x: number;
      y: number;
    }
  | {
      type: "pinch";
      /** Degrees to add to the bearing about (x, y); 0 until the rotation threshold. */
      deltaBearing: number;
      deltaX: number;
      deltaY: number;
      deltaZoom: number;
      previousX: number;
      previousY: number;
      x: number;
      y: number;
    };

type Point = {
  x: number;
  y: number;
};

const MIN_PINCH_DISTANCE = 1e-9;
/** Finger travel along the pinch circle before two-finger rotation engages. */
const ROTATION_THRESHOLD_PX = 25;

export function createMapsPointerGesture() {
  const pointers = new Map<number, Point>();
  // Rotation arms per pointer pair so pinch-zoom does not rotate accidentally.
  let rotationArc = 0;
  let rotating = false;
  const resetRotation = () => {
    rotationArc = 0;
    rotating = false;
  };

  return {
    clear() {
      pointers.clear();
      resetRotation();
    },
    pointerCount() {
      return pointers.size;
    },
    pointerDown(pointerId: number, point: Point) {
      pointers.set(pointerId, point);
      resetRotation();
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
        return {
          type: "pan",
          deltaX,
          deltaY,
          previousX: previousPoint.x,
          previousY: previousPoint.y,
          x: point.x,
          y: point.y,
        };
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
      const measurable =
        previousDistance > MIN_PINCH_DISTANCE && nextDistance > MIN_PINCH_DISTANCE;
      const deltaZoom = measurable ? Math.log2(nextDistance / previousDistance) : 0;
      let deltaBearing = 0;
      if (measurable) {
        const turn = normalizeDegrees(
          angleDegrees(nextLeft, nextRight) - angleDegrees(previousLeft, previousRight),
        );
        if (rotating) {
          // Clockwise finger rotation on a y-down screen turns content clockwise,
          // which decreases the bearing.
          deltaBearing = turn === 0 ? 0 : -turn;
        } else {
          rotationArc += Math.abs((turn * Math.PI) / 180) * (nextDistance / 2);
          rotating = rotationArc >= ROTATION_THRESHOLD_PX;
        }
      }
      const deltaX = nextCenter.x - previousCenter.x;
      const deltaY = nextCenter.y - previousCenter.y;

      if (deltaX === 0 && deltaY === 0 && deltaZoom === 0 && deltaBearing === 0) return null;

      return {
        type: "pinch",
        deltaBearing,
        deltaX,
        deltaY,
        deltaZoom,
        previousX: previousCenter.x,
        previousY: previousCenter.y,
        x: nextCenter.x,
        y: nextCenter.y,
      };
    },
    pointerUp(pointerId: number) {
      pointers.delete(pointerId);
      resetRotation();
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

function angleDegrees(left: Point, right: Point) {
  return (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;
}

function normalizeDegrees(degrees: number) {
  const wrapped = (((degrees + 180) % 360) + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function distance(left: Point, right: Point) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}
