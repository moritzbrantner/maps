import { describe, expect, test } from "vitest";

import {
  getTemporalMapPointsAtTime,
  getTemporalMapTimeRange,
  snapTemporalMapTime,
  type TemporalMapTrack,
} from ".";

describe("@moritzbrantner/maps temporal points", () => {
  test("derives the overall time range from every track", () => {
    const tracks: TemporalMapTrack[] = [
      {
        id: "west",
        frames: [
          { latitude: 34, longitude: -118, time: 15 },
          { latitude: 36, longitude: -122, time: 5 },
        ],
      },
      {
        id: "east",
        frames: [{ latitude: 40.7, longitude: -74, time: 40 }],
      },
    ];

    expect(getTemporalMapTimeRange(tracks)).toEqual({
      end: 40,
      start: 5,
    });
  });

  test("snaps playback time down to the active discrete time bucket", () => {
    expect(
      snapTemporalMapTime(
        34,
        {
          start: 10,
          end: 50,
        },
        12,
      ),
    ).toBe(34);
    expect(
      snapTemporalMapTime(
        50,
        {
          start: 10,
          end: 50,
        },
        12,
      ),
    ).toBe(50);
    expect(
      snapTemporalMapTime(
        34,
        {
          start: 10,
          end: 50,
        },
        "any",
      ),
    ).toBe(34);
  });

  test("interpolates point positions and numeric metrics between keyframes", () => {
    const tracks: TemporalMapTrack<{ route: string; status: string }>[] = [
      {
        id: "courier-1",
        label: "Courier 1",
        metrics: { load: 2 },
        properties: { route: "Seattle to Denver", status: "dispatching" },
        frames: [
          {
            latitude: 47.6062,
            longitude: -122.3321,
            metrics: { revenue: 120 },
            time: 0,
          },
          {
            latitude: 39.7392,
            longitude: -104.9903,
            metrics: { revenue: 320 },
            properties: { route: "Seattle to Denver", status: "en-route" },
            time: 10,
          },
        ],
      },
    ];

    const [point] = getTemporalMapPointsAtTime(tracks, 5);

    expect(point).toMatchObject({
      id: "courier-1",
      label: "Courier 1",
      metrics: {
        load: 2,
        revenue: 220,
      },
      properties: {
        route: "Seattle to Denver",
        status: "dispatching",
      },
    });
    expect(point?.latitude).toBeCloseTo(43.672700000000005);
    expect(point?.longitude).toBeCloseTo(-113.6612);
  });

  test("allows tracks to appear and disappear at keyframes", () => {
    const tracks: TemporalMapTrack[] = [
      {
        id: "courier-2",
        frames: [
          {
            latitude: 25.7617,
            longitude: -80.1918,
            time: 2,
            visible: false,
          },
          {
            latitude: 29.7604,
            longitude: -95.3698,
            time: 6,
          },
          {
            latitude: 32.7767,
            longitude: -96.797,
            time: 10,
            visible: false,
          },
        ],
      },
    ];

    expect(getTemporalMapPointsAtTime(tracks, 4)).toEqual([]);
    expect(getTemporalMapPointsAtTime(tracks, 6)).toHaveLength(1);
    const [point] = getTemporalMapPointsAtTime(tracks, 8);

    expect(point).toMatchObject({
      id: "courier-2",
      label: "",
      metrics: {},
      properties: {},
    });
    expect(point?.latitude).toBeCloseTo(31.26855);
    expect(point?.longitude).toBeCloseTo(-96.0834);
    expect(getTemporalMapPointsAtTime(tracks, 10)).toEqual([]);
  });

  test("keeps a visible point at its final keyframe after the last timestamp", () => {
    const tracks: TemporalMapTrack[] = [
      {
        id: "courier-3",
        frames: [
          {
            latitude: 41.8781,
            longitude: -87.6298,
            time: 4,
          },
        ],
      },
    ];

    expect(getTemporalMapPointsAtTime(tracks, 12)).toEqual([
      {
        id: "courier-3",
        label: "",
        latitude: 41.8781,
        longitude: -87.6298,
        metrics: {},
        properties: {},
      },
    ]);
  });
});
