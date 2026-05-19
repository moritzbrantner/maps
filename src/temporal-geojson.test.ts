import { describe, expect, test } from "vitest";

import {
  createTemporalMapTracksFromGeoJson,
  getTemporalMapPointsAtTime,
  type TemporalGeoJsonPointFeatureCollection,
} from ".";

describe("@moritzbrantner/maps temporal GeoJSON", () => {
  test("converts point feature collections into grouped temporal tracks", () => {
    const collection: TemporalGeoJsonPointFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [-122.3321, 47.6062],
          },
          properties: {
            label: "Courier 1",
            metrics: { revenue: 120 },
            time: 20,
            trackId: "courier-1",
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [-104.9903, 39.7392],
          },
          properties: {
            label: "Courier 1",
            metrics: { revenue: 320 },
            time: 10,
            trackId: "courier-1",
          },
        },
        {
          id: "courier-2",
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [-74.006, 40.7128],
          },
          properties: {
            time: 15,
          },
        },
      ],
    };

    expect(createTemporalMapTracksFromGeoJson(collection)).toEqual([
      {
        id: "courier-1",
        label: "Courier 1",
        frames: [
          {
            latitude: 39.7392,
            longitude: -104.9903,
            metrics: { revenue: 320 },
            properties: {
              label: "Courier 1",
              metrics: { revenue: 320 },
              time: 10,
              trackId: "courier-1",
            },
            time: 10,
            visible: true,
          },
          {
            latitude: 47.6062,
            longitude: -122.3321,
            metrics: { revenue: 120 },
            properties: {
              label: "Courier 1",
              metrics: { revenue: 120 },
              time: 20,
              trackId: "courier-1",
            },
            time: 20,
            visible: true,
          },
        ],
      },
      {
        id: "courier-2",
        label: "courier-2",
        frames: [
          {
            latitude: 40.7128,
            longitude: -74.006,
            metrics: {},
            properties: {
              time: 15,
            },
            time: 15,
            visible: true,
          },
        ],
      },
    ]);
  });

  test("parses numeric strings and ISO timestamps", () => {
    const isoTime = "2026-04-21T10:30:00.000Z";
    const collection: TemporalGeoJsonPointFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [13.405, 52.52],
          },
          properties: {
            timestamp: isoTime,
            trackId: "berlin",
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [11.582, 48.1351],
          },
          properties: {
            time: "42",
            trackId: "munich",
          },
        },
      ],
    };

    const tracks = createTemporalMapTracksFromGeoJson(collection);

    expect(tracks[0]?.frames[0]?.time).toBe(Date.parse(isoTime));
    expect(tracks[1]?.frames[0]?.time).toBe(42);
  });

  test("preserves labels, metrics, visibility, and properties", () => {
    const collection: TemporalGeoJsonPointFeatureCollection<{
      label: string;
      load: number;
      metrics: {
        revenue: number;
      };
      status: string;
      time: number;
      trackId: string;
      visible: false;
    }> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [-80.1918, 25.7617],
          },
          properties: {
            label: "Courier 3",
            load: 4,
            metrics: { revenue: 450 },
            status: "paused",
            time: 30,
            trackId: "courier-3",
            visible: false,
          },
        },
      ],
    };

    const [track] = createTemporalMapTracksFromGeoJson(collection, {
      metricKeys: ["load"],
    });

    expect(track).toMatchObject({
      id: "courier-3",
      label: "Courier 3",
      frames: [
        {
          latitude: 25.7617,
          longitude: -80.1918,
          metrics: {
            load: 4,
            revenue: 450,
          },
          properties: {
            status: "paused",
            visible: false,
          },
          time: 30,
          visible: false,
        },
      ],
    });
  });

  test("skips invalid and non-point features without throwing", () => {
    const collection: TemporalGeoJsonPointFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: null,
          properties: {
            time: 1,
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: {
            time: 2,
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [Number.NaN, 1],
          },
          properties: {
            time: 3,
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [1, 1],
          },
          properties: {
            time: "not a timestamp",
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [2, 3],
          },
          properties: {
            time: 4,
            trackId: "valid",
          },
        },
      ],
    };

    expect(createTemporalMapTracksFromGeoJson(collection)).toEqual([
      {
        id: "valid",
        label: "valid",
        frames: [
          {
            latitude: 3,
            longitude: 2,
            metrics: {},
            properties: {
              time: 4,
              trackId: "valid",
            },
            time: 4,
            visible: true,
          },
        ],
      },
    ]);
  });

  test("supports custom mappers", () => {
    const collection: TemporalGeoJsonPointFeatureCollection<{
      cargo: number;
      group: string;
      observedAt: Date;
      sequence: number;
    }> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [7.4474, 46.948],
          },
          properties: {
            cargo: 9,
            group: "north",
            observedAt: new Date("2026-04-21T11:00:00.000Z"),
            sequence: 8,
          },
        },
      ],
    };

    const [track] = createTemporalMapTracksFromGeoJson(collection, {
      getLabel: (feature) => `Group ${feature.properties?.group}`,
      getMetrics: (feature) => ({
        cargo: feature.properties?.cargo ?? 0,
      }),
      getProperties: (feature) => ({
        order: feature.properties?.sequence ?? 0,
      }),
      getTime: (feature) => feature.properties?.observedAt,
      getTrackId: (feature) => feature.properties?.group,
      getVisible: () => false,
    });

    expect(track).toEqual({
      id: "north",
      label: "Group north",
      frames: [
        {
          latitude: 46.948,
          longitude: 7.4474,
          metrics: {
            cargo: 9,
          },
          properties: {
            order: 8,
          },
          time: Date.parse("2026-04-21T11:00:00.000Z"),
          visible: false,
        },
      ],
    });
  });

  test("feeds existing temporal interpolation", () => {
    const collection: TemporalGeoJsonPointFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [-122.3321, 47.6062],
          },
          properties: {
            metrics: { revenue: 100 },
            time: 0,
            trackId: "courier-4",
          },
        },
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [-104.9903, 39.7392],
          },
          properties: {
            metrics: { revenue: 300 },
            time: 10,
            trackId: "courier-4",
          },
        },
      ],
    };

    const [point] = getTemporalMapPointsAtTime(createTemporalMapTracksFromGeoJson(collection), 5);

    expect(point).toMatchObject({
      id: "courier-4",
      metrics: {
        revenue: 200,
      },
    });
    expect(point?.latitude).toBeCloseTo(43.6727);
    expect(point?.longitude).toBeCloseTo(-113.6612);
  });
});
