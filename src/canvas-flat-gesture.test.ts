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
      previousX: 50,
      previousY: 50,
      x: 60,
      y: 50,
    });
  });

  test("clear drops all active pointers", () => {
    const gesture = createMapsPointerGesture();
    gesture.pointerDown(1, { x: 10, y: 10 });
    gesture.clear();

    expect(gesture.pointerMove(1, { x: 20, y: 20 })).toBeNull();
  });
});
