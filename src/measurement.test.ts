import { describe, expect, test } from "vitest";

import {
  formatMapDistance,
  getBeeLineDistanceMeters,
  getBeeLineMidpoint,
  normalizeMapCoordinate,
} from "./measurement";

describe("@moritzbrantner/maps measurement helpers", () => {
  test("computes zero distance for identical coordinates", () => {
    expect(getBeeLineDistanceMeters([13.405, 52.52], [13.405, 52.52])).toBe(0);
  });

  test("computes expected approximate Berlin to Paris distance", () => {
    const distanceMeters = getBeeLineDistanceMeters([13.405, 52.52], [2.3522, 48.8566]);

    expect(distanceMeters).not.toBeNull();
    expect(distanceMeters!).toBeGreaterThan(875_000);
    expect(distanceMeters!).toBeLessThan(880_000);
  });

  test("formats metric values as meters below 1000m", () => {
    expect(formatMapDistance(998.4, "metric")).toBe("998 m");
  });

  test("formats metric values as kilometers above 1000m", () => {
    expect(formatMapDistance(1234, "metric")).toBe("1.23 km");
  });

  test("formats raw meters when measurementDistanceFormat is meters", () => {
    expect(formatMapDistance(1234, "meters")).toBe("1,234 m");
  });

  test("handles antimeridian midpoint correctly", () => {
    expect(getBeeLineMidpoint([179, 10], [-179, 20])).toEqual([180, 15]);
  });

  test("ignores invalid and non-finite coordinates", () => {
    expect(normalizeMapCoordinate([Number.NaN, 10])).toBeNull();
    expect(normalizeMapCoordinate([10, Number.POSITIVE_INFINITY])).toBeNull();
    expect(normalizeMapCoordinate([10, 120])).toBeNull();
  });
});
