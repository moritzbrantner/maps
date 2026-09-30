import { describe, expect, test } from "vitest";

import { createMapsPointerGesture } from "./canvas-flat-gesture";

describe("createMapsPointerGesture", () => {
  test("reports single-pointer pan deltas and anchors", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(4, { x: 20, y: 30 });

    expect(gesture.pointerMove(4, { x: 32, y: 25 })).toEqual({
      type: "pan",
      deltaX: 12,
      deltaY: -5,
      previousX: 20,
      previousY: 30,
      x: 32,
      y: 25,
    });
  });

  test("reports the active pointer count for release handoff", () => {
    const gesture = createMapsPointerGesture();
    expect(gesture.pointerCount()).toBe(0);
    gesture.pointerDown(1, { x: 10, y: 10 });
    gesture.pointerDown(2, { x: 20, y: 20 });
    expect(gesture.pointerCount()).toBe(2);
    gesture.pointerUp(2);
    expect(gesture.pointerCount()).toBe(1);
    gesture.clear();
    expect(gesture.pointerCount()).toBe(0);
  });

  test("adding a second pointer does not create a jump", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 40, y: 50 });
    gesture.pointerDown(2, { x: 60, y: 50 });

    expect(gesture.pointerMove(2, { x: 60, y: 50 })).toBeNull();
  });

  test("reports centroid anchors, pan and logarithmic zoom for a pinch", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 40, y: 50 });
    gesture.pointerDown(2, { x: 60, y: 50 });

    expect(gesture.pointerMove(2, { x: 80, y: 50 })).toEqual({
      type: "pinch",
      deltaX: 10,
      deltaY: 0,
      deltaZoom: 1,
      deltaBearing: 0,
      previousX: 50,
      previousY: 50,
      x: 60,
      y: 50,
    });
  });

  test("resumes single-pointer pan after the second pointer leaves", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 40, y: 50 });
    gesture.pointerDown(2, { x: 60, y: 50 });
    gesture.pointerUp(2);

    expect(gesture.pointerMove(1, { x: 45, y: 53 })).toEqual({
      type: "pan",
      deltaX: 5,
      deltaY: 3,
      previousX: 40,
      previousY: 50,
      x: 45,
      y: 53,
    });
  });

  test("ignores movement from pointers outside the stable active pair", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(2, { x: 20, y: 20 });
    gesture.pointerDown(4, { x: 40, y: 20 });
    gesture.pointerDown(6, { x: 30, y: 40 });

    expect(gesture.pointerMove(6, { x: 50, y: 60 })).toBeNull();
    expect(gesture.pointerMove(4, { x: 60, y: 20 })).toMatchObject({
      type: "pinch",
      deltaX: 10,
      deltaY: 0,
      previousX: 30,
      previousY: 20,
      x: 40,
      y: 20,
    });
  });

  test("keeps overlapping-pointer transitions finite", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 50, y: 50 });
    gesture.pointerDown(2, { x: 50, y: 50 });

    expect(gesture.pointerMove(2, { x: 70, y: 50 })).toEqual({
      type: "pinch",
      deltaX: 10,
      deltaY: 0,
      deltaZoom: 0,
      deltaBearing: 0,
      previousX: 50,
      previousY: 50,
      x: 60,
      y: 50,
    });
  });

  test("two-finger rotation starts after the arc threshold and follows the fingers", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 100, y: 100 });
    gesture.pointerDown(2, { x: 300, y: 100 });
    const at = (degrees: number) => {
      const radians = (degrees * Math.PI) / 180;
      return { x: 200 + Math.cos(radians) * 100, y: 100 + Math.sin(radians) * 100 };
    };
    const rotate = (degrees: number) => {
      const left = at(180 + degrees);
      gesture.pointerMove(1, left);
      return gesture.pointerMove(2, at(degrees));
    };

    // 10° of a 100px radius is a ~17px arc per finger: below the 25px threshold.
    expect(rotate(5)).toMatchObject({ deltaBearing: 0 });
    // Crossing the threshold arms rotation without a jump.
    expect(rotate(15)).toMatchObject({ deltaBearing: 0 });
    // Clockwise finger rotation (y down) turns content clockwise: bearing decreases.
    const step = rotate(25);
    expect(step?.type).toBe("pinch");
    expect(step && "deltaBearing" in step ? step.deltaBearing : NaN).toBeCloseTo(-5, 9);
    // One finger moves at a time, so the pair distance wobbles slightly.
    expect(step && "deltaZoom" in step ? step.deltaZoom : NaN).toBeCloseTo(0, 1);
    expect(step?.x).toBeCloseTo(200, 9);
    expect(step?.y).toBeCloseTo(100, 9);
  });

  test("rotation threshold re-arms for each new pointer pair", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 100, y: 100 });
    gesture.pointerDown(2, { x: 300, y: 100 });
    gesture.pointerMove(2, { x: 300, y: 160 });
    gesture.pointerMove(2, { x: 300, y: 220 });
    gesture.pointerUp(2);
    gesture.pointerDown(3, { x: 300, y: 100 });

    expect(gesture.pointerMove(3, { x: 300, y: 110 })).toMatchObject({
      type: "pinch",
      deltaBearing: 0,
    });
  });

  test("clear drops all active pointers", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 10, y: 10 });
    gesture.clear();

    expect(gesture.pointerMove(1, { x: 20, y: 20 })).toBeNull();
  });
});
