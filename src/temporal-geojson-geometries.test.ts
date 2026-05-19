import { describe, expect, test } from "vitest";

import {
  createTemporalGeoJsonPlaybackIndex,
  createTemporalGeoJsonTracksFromGeoJson,
  getTemporalGeoJsonFeatureCollectionAtTime,
  getTemporalGeoJsonTimeRange,
  interpolateTemporalGeoJsonGeometry,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonTrack,
} from ".";

describe("@moritzbrantner/maps temporal GeoJSON geometries", () => {
  test("converts line and polygon features into grouped temporal tracks", () => {
    const collection: TemporalGeoJsonGeometryFeatureCollection = {
      features: [
        {
          geometry: {
            coordinates: [
              [0, 10],
              [10, 10],
            ],
            type: "LineString",
          },
          properties: {
            label: "Route A",
            load: 6,
            time: 10,
            trackId: "route-a",
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [0, 0],
              [10, 0],
            ],
            type: "LineString",
          },
          properties: {
            label: "Route A",
            load: 2,
            time: 0,
            trackId: "route-a",
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [
                [0, 0],
                [4, 0],
                [4, 4],
                [0, 4],
              ],
            ],
            type: "Polygon",
          },
          properties: {
            label: "Zone B",
            time: 5,
            trackId: "zone-b",
          },
          type: "Feature",
        },
      ],
      type: "FeatureCollection",
    };

    const tracks = createTemporalGeoJsonTracksFromGeoJson(collection, {
      metricKeys: ["load"],
    });

    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      frames: [
        {
          geometry: {
            coordinates: [
              [0, 0],
              [10, 0],
            ],
            type: "LineString",
          },
          metrics: {
            load: 2,
          },
          time: 0,
          visible: true,
        },
        {
          geometry: {
            coordinates: [
              [0, 10],
              [10, 10],
            ],
            type: "LineString",
          },
          metrics: {
            load: 6,
          },
          time: 10,
          visible: true,
        },
      ],
      id: "route-a",
      label: "Route A",
    });
    expect(tracks[1]?.frames[0]?.geometry).toEqual({
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
      type: "Polygon",
    });
  });

  test("preserves custom mappers, numeric strings, ISO timestamps, visibility, and properties", () => {
    const isoTime = "2026-04-21T10:30:00.000Z";
    const collection: TemporalGeoJsonGeometryFeatureCollection<{
      amount: number;
      group: string;
      hidden?: boolean;
      observedAt: Date | string;
      sequence: number;
    }> = {
      features: [
        {
          geometry: {
            coordinates: [
              [1, 1],
              [2, 2],
            ],
            type: "LineString",
          },
          properties: {
            amount: 9,
            group: "north",
            hidden: true,
            observedAt: new Date(isoTime),
            sequence: 8,
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [3, 4],
            type: "Point",
          },
          properties: {
            amount: 4,
            group: "east",
            observedAt: "42",
            sequence: 9,
          },
          type: "Feature",
        },
      ],
      type: "FeatureCollection",
    };

    const tracks = createTemporalGeoJsonTracksFromGeoJson(collection, {
      getLabel: (feature) => `Group ${feature.properties?.group}`,
      getMetrics: (feature) => ({
        amount: feature.properties?.amount ?? 0,
      }),
      getProperties: (feature) => ({
        order: feature.properties?.sequence ?? 0,
      }),
      getTime: (feature) => feature.properties?.observedAt,
      getTrackId: (feature) => feature.properties?.group,
      getVisible: (feature) => !feature.properties?.hidden,
    });

    expect(tracks[0]).toMatchObject({
      frames: [
        {
          metrics: {
            amount: 9,
          },
          properties: {
            order: 8,
          },
          time: Date.parse(isoTime),
          visible: false,
        },
      ],
      id: "north",
      label: "Group north",
    });
    expect(tracks[1]?.frames[0]?.time).toBe(42);
    expect(getTemporalGeoJsonTimeRange(tracks)).toEqual({
      end: Date.parse(isoTime),
      start: 42,
    });
  });

  test("skips invalid, unsupported, and malformed features", () => {
    const collection: TemporalGeoJsonGeometryFeatureCollection = {
      features: [
        {
          geometry: null,
          properties: {
            time: 1,
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [0, 0],
              [1, 1],
            ],
            type: "GeometryCollection",
          },
          properties: {
            time: 2,
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [0, 0],
              [Number.NaN, 1],
            ],
            type: "LineString",
          },
          properties: {
            time: 3,
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [
              [
                [0, 0],
                [1, 0],
              ],
            ],
            type: "Polygon",
          },
          properties: {
            time: 4,
          },
          type: "Feature",
        },
        {
          geometry: {
            coordinates: [2, 3],
            type: "Point",
          },
          properties: {
            time: 5,
            trackId: "valid",
          },
          type: "Feature",
        },
      ],
      type: "FeatureCollection",
    };

    expect(createTemporalGeoJsonTracksFromGeoJson(collection)).toMatchObject([
      {
        frames: [
          {
            geometry: {
              coordinates: [2, 3],
              type: "Point",
            },
            time: 5,
          },
        ],
        id: "valid",
      },
    ]);
  });

  test("interpolates compatible LineString coordinates and metrics", () => {
    const [feature] = getTemporalGeoJsonFeatureCollectionAtTime(
      [
        {
          id: "route",
          frames: [
            {
              geometry: {
                coordinates: [
                  [0, 0],
                  [10, 0],
                ],
                type: "LineString",
              },
              metrics: {
                load: 2,
              },
              time: 0,
            },
            {
              geometry: {
                coordinates: [
                  [0, 10],
                  [10, 10],
                ],
                type: "LineString",
              },
              metrics: {
                load: 6,
              },
              time: 10,
            },
          ],
        },
      ],
      5,
    ).features;

    expect(feature).toMatchObject({
      geometry: {
        coordinates: [
          [0, 5],
          [10, 5],
        ],
        type: "LineString",
      },
      properties: {
        metrics: {
          load: 4,
        },
        temporalTrackId: "route",
      },
    });
  });

  test("resamples LineStrings with different vertex counts", () => {
    const geometry = interpolateTemporalGeoJsonGeometry(
      {
        coordinates: [
          [0, 0],
          [10, 0],
        ],
        type: "LineString",
      },
      {
        coordinates: [
          [0, 10],
          [5, 15],
          [10, 10],
        ],
        type: "LineString",
      },
      0.5,
      {
        minResampleCoordinates: 3,
        strategy: "resample",
      },
    );

    expect(geometry).toEqual({
      coordinates: [
        [0, 5],
        [5, 7.5],
        [10, 5],
      ],
      type: "LineString",
    });
  });

  test("interpolates compatible polygons with matching ring topology", () => {
    const geometry = interpolateTemporalGeoJsonGeometry(
      {
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
            [0, 0],
          ],
        ],
        type: "Polygon",
      },
      {
        coordinates: [
          [
            [2, 2],
            [6, 2],
            [6, 6],
            [2, 6],
            [2, 2],
          ],
        ],
        type: "Polygon",
      },
      0.5,
    );

    expect(geometry).toEqual({
      coordinates: [
        [
          [1, 1],
          [5, 1],
          [5, 5],
          [1, 5],
          [1, 1],
        ],
      ],
      type: "Polygon",
    });
  });

  test("resampled polygons are closed and respect max coordinate limits", () => {
    const geometry = interpolateTemporalGeoJsonGeometry(
      {
        coordinates: [
          [
            [0, 0],
            [6, 0],
            [3, 4],
            [0, 0],
          ],
        ],
        type: "Polygon",
      },
      {
        coordinates: [
          [
            [1, 1],
            [7, 1],
            [8, 4],
            [4, 7],
            [1, 1],
          ],
        ],
        type: "Polygon",
      },
      0.5,
      {
        maxCoordinatesPerRing: 4,
        minResampleCoordinates: 16,
        strategy: "resample",
      },
    );

    expect(geometry?.type).toBe("Polygon");
    const ring = geometry?.type === "Polygon" ? geometry.coordinates[0] : [];

    expect(ring).toHaveLength(5);
    expect(ring?.[0]).toEqual(ring?.at(-1));
  });

  test("centroid-radial polygon interpolation returns finite closed rings", () => {
    const geometry = interpolateTemporalGeoJsonGeometry(
      {
        coordinates: [
          [
            [0, 0],
            [8, 0],
            [4, 8],
            [0, 0],
          ],
        ],
        type: "Polygon",
      },
      {
        coordinates: [
          [
            [2, 1],
            [7, 1],
            [9, 5],
            [4, 9],
            [1, 5],
            [2, 1],
          ],
        ],
        type: "Polygon",
      },
      0.5,
      {
        maxCoordinatesPerRing: 8,
        minResampleCoordinates: 8,
        strategy: "centroid-radial",
      },
    );

    expect(geometry?.type).toBe("Polygon");
    const ring = geometry?.type === "Polygon" ? geometry.coordinates[0] : [];

    expect(ring).toHaveLength(9);
    expect(ring?.[0]).toEqual(ring?.at(-1));
    expect(ring?.flat().every((value) => Number.isFinite(value))).toBe(true);
  });

  test("interpolates MultiLineString and MultiPolygon parts by index", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "multi-line",
        frames: [
          {
            geometry: {
              coordinates: [
                [
                  [0, 0],
                  [4, 0],
                ],
                [
                  [10, 0],
                  [14, 0],
                ],
              ],
              type: "MultiLineString",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [
                  [0, 4],
                  [4, 4],
                ],
                [
                  [10, 4],
                  [14, 4],
                ],
              ],
              type: "MultiLineString",
            },
            time: 10,
          },
        ],
      },
      {
        id: "multi-polygon",
        frames: [
          {
            geometry: {
              coordinates: [
                [
                  [
                    [0, 0],
                    [2, 0],
                    [2, 2],
                    [0, 2],
                    [0, 0],
                  ],
                ],
              ],
              type: "MultiPolygon",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [
                  [
                    [2, 2],
                    [4, 2],
                    [4, 4],
                    [2, 4],
                    [2, 2],
                  ],
                ],
              ],
              type: "MultiPolygon",
            },
            time: 10,
          },
        ],
      },
    ];

    const features = getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5).features;

    expect(features[0]?.geometry).toEqual({
      coordinates: [
        [
          [0, 2],
          [4, 2],
        ],
        [
          [10, 2],
          [14, 2],
        ],
      ],
      type: "MultiLineString",
    });
    expect(features[1]?.geometry).toEqual({
      coordinates: [
        [
          [
            [1, 1],
            [3, 1],
            [3, 3],
            [1, 3],
            [1, 1],
          ],
        ],
      ],
      type: "MultiPolygon",
    });
  });

  test("falls back to hold or hide when topology changes", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "changing-zone",
        frames: [
          {
            geometry: {
              coordinates: [
                [
                  [0, 0],
                  [4, 0],
                  [4, 4],
                  [0, 4],
                  [0, 0],
                ],
              ],
              type: "Polygon",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [
                  [0, 0],
                  [4, 0],
                  [4, 4],
                  [0, 4],
                  [0, 0],
                ],
                [
                  [1, 1],
                  [2, 1],
                  [2, 2],
                  [1, 2],
                  [1, 1],
                ],
              ],
              type: "Polygon",
            },
            time: 10,
          },
        ],
      },
    ];

    expect(getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5).features[0]?.geometry).toEqual(
      tracks[0]?.frames[0]?.geometry,
    );
    expect(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5, {
        fallback: "hide",
      }).features,
    ).toEqual([]);
  });

  test("honors temporal visibility and final-frame hold semantics", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "visible-window",
        frames: [
          {
            geometry: {
              coordinates: [0, 0],
              type: "Point",
            },
            time: 2,
            visible: false,
          },
          {
            geometry: {
              coordinates: [4, 4],
              type: "Point",
            },
            time: 6,
          },
          {
            geometry: {
              coordinates: [8, 8],
              type: "Point",
            },
            time: 10,
            visible: false,
          },
        ],
      },
    ];

    expect(getTemporalGeoJsonFeatureCollectionAtTime(tracks, 4).features).toEqual([]);
    expect(getTemporalGeoJsonFeatureCollectionAtTime(tracks, 6).features).toHaveLength(1);
    expect(getTemporalGeoJsonFeatureCollectionAtTime(tracks, 8).features[0]?.geometry).toEqual({
      coordinates: [6, 6],
      type: "Point",
    });
    expect(getTemporalGeoJsonFeatureCollectionAtTime(tracks, 12).features).toEqual([]);
  });

  test("prepared playback index matches raw output for small geometries across strategies", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "point-track",
        frames: [
          {
            geometry: {
              coordinates: [0, 0],
              type: "Point",
            },
            metrics: { load: 1 },
            properties: { status: "start" },
            time: 0,
          },
          {
            geometry: {
              coordinates: [10, 10],
              type: "Point",
            },
            metrics: { load: 5 },
            properties: { status: "end" },
            time: 10,
          },
        ],
      },
      {
        id: "line-track",
        frames: [
          {
            geometry: {
              coordinates: [
                [0, 0],
                [4, 0],
                [8, 0],
              ],
              type: "LineString",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [0, 6],
                [4, 6],
                [8, 6],
              ],
              type: "LineString",
            },
            time: 10,
          },
        ],
      },
      {
        id: "polygon-track",
        frames: [
          {
            geometry: {
              coordinates: [
                [
                  [0, 0],
                  [6, 0],
                  [6, 6],
                  [0, 6],
                  [0, 0],
                ],
              ],
              type: "Polygon",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [
                  [2, 2],
                  [8, 2],
                  [8, 8],
                  [2, 8],
                  [2, 2],
                ],
              ],
              type: "Polygon",
            },
            time: 10,
          },
        ],
      },
    ];

    for (const strategy of ["compatible", "resample", "centroid-radial"] as const) {
      const options =
        strategy === "compatible"
          ? { strategy }
          : {
              maxCoordinatesPerLine: 8,
              maxCoordinatesPerRing: 8,
              minResampleCoordinates: 4,
              strategy,
            };
      const index = createTemporalGeoJsonPlaybackIndex(tracks, options);

      expect(index.getFeatureCollectionAtTime(5)).toEqual(
        getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5, options),
      );
    }
  });

  test("prepared playback index resamples dense compatible polygons within the configured budget", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "dense-zone",
        frames: [
          {
            geometry: {
              coordinates: [createDenseRing(180, 10, 0, 0)],
              type: "Polygon",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [createDenseRing(240, 12, 3, 2)],
              type: "Polygon",
            },
            time: 10,
          },
        ],
      },
    ];

    const feature = createTemporalGeoJsonPlaybackIndex(tracks, {
      maxCoordinatesPerRing: 48,
      minResampleCoordinates: 16,
      strategy: "compatible",
    }).getFeatureCollectionAtTime(5).features[0];

    expect(feature?.geometry.type).toBe("Polygon");
    const ring = feature?.geometry.type === "Polygon" ? feature.geometry.coordinates[0] : [];

    expect(ring).toHaveLength(49);
    expect(ring?.[0]).toEqual(ring?.at(-1));
    expect(ring?.flat().every((value) => Number.isFinite(value))).toBe(true);
  });

  test("prepared playback index preserve mode keeps compatible fallback semantics for dense mismatched polygons", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "dense-preserve",
        frames: [
          {
            geometry: {
              coordinates: [createDenseRing(180, 10, 0, 0)],
              type: "Polygon",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [createDenseRing(240, 12, 3, 2)],
              type: "Polygon",
            },
            time: 10,
          },
        ],
      },
    ];
    const options = {
      denseGeometryBehavior: "preserve" as const,
      maxCoordinatesPerRing: 48,
      minResampleCoordinates: 16,
      strategy: "compatible" as const,
    };

    expect(
      createTemporalGeoJsonPlaybackIndex(tracks, options).getFeatureCollectionAtTime(5),
    ).toEqual(getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5, options));
  });

  test("prepared playback index interpolates multipolygons with holes by matching topology", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "holes",
        frames: [
          {
            geometry: {
              coordinates: [
                [
                  [
                    [0, 0],
                    [8, 0],
                    [8, 8],
                    [0, 8],
                    [0, 0],
                  ],
                  [
                    [2, 2],
                    [2, 4],
                    [4, 4],
                    [4, 2],
                    [2, 2],
                  ],
                ],
              ],
              type: "MultiPolygon",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [
                  [
                    [2, 2],
                    [10, 2],
                    [10, 10],
                    [2, 10],
                    [2, 2],
                  ],
                  [
                    [4, 4],
                    [4, 6],
                    [6, 6],
                    [6, 4],
                    [4, 4],
                  ],
                ],
              ],
              type: "MultiPolygon",
            },
            time: 10,
          },
        ],
      },
    ];
    const options = { strategy: "compatible" as const };

    expect(
      createTemporalGeoJsonPlaybackIndex(tracks, options).getFeatureCollectionAtTime(5),
    ).toEqual(getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5, options));
  });

  test("prepared playback index matches raw fallback semantics when topology changes", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "topology-change",
        frames: [
          {
            geometry: {
              coordinates: [
                [
                  [0, 0],
                  [4, 0],
                  [4, 4],
                  [0, 4],
                  [0, 0],
                ],
              ],
              type: "Polygon",
            },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [
                  [0, 0],
                  [4, 0],
                  [4, 4],
                  [0, 4],
                  [0, 0],
                ],
                [
                  [1, 1],
                  [2, 1],
                  [2, 2],
                  [1, 2],
                  [1, 1],
                ],
              ],
              type: "Polygon",
            },
            time: 10,
          },
        ],
      },
    ];

    expect(
      createTemporalGeoJsonPlaybackIndex(tracks, {
        fallback: "hold",
      }).getFeatureCollectionAtTime(5),
    ).toEqual(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5, {
        fallback: "hold",
      }),
    );
    expect(
      createTemporalGeoJsonPlaybackIndex(tracks, {
        fallback: "hide",
      }).getFeatureCollectionAtTime(5),
    ).toEqual(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5, {
        fallback: "hide",
      }),
    );
  });

  test("prepared playback index matches visibility, time lookup, and invalid-time semantics", () => {
    const tracks: TemporalGeoJsonTrack[] = [
      {
        id: "window",
        frames: [
          {
            geometry: {
              coordinates: [0, 0],
              type: "Point",
            },
            time: 2,
            visible: false,
          },
          {
            geometry: {
              coordinates: [4, 4],
              type: "Point",
            },
            metrics: { load: 4 },
            properties: { phase: "active" },
            time: 6,
          },
          {
            geometry: {
              coordinates: [8, 8],
              type: "Point",
            },
            metrics: { load: 8 },
            properties: { phase: "done" },
            time: 10,
            visible: false,
          },
        ],
      },
    ];
    const index = createTemporalGeoJsonPlaybackIndex(tracks);

    expect(index.getFeatureCollectionAtTime(Number.NaN)).toEqual({
      features: [],
      type: "FeatureCollection",
    });
    expect(index.getFeatureCollectionAtTime(4)).toEqual(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 4),
    );
    expect(index.getFeatureCollectionAtTime(6)).toEqual(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 6),
    );
    expect(index.getFeatureCollectionAtTime(8)).toEqual(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 8),
    );
    expect(index.getFeatureCollectionAtTime(12)).toEqual(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 12),
    );
    expect(index.getTimeRange()).toEqual({ end: 10, start: 2 });
  });

  test("prepared playback index preserves interpolated metrics and merged properties", () => {
    const tracks: TemporalGeoJsonTrack<{
      stage?: string;
      trackBase?: string;
    }>[] = [
      {
        id: "metrics",
        metrics: { fleet: 3 },
        properties: { trackBase: "base" },
        frames: [
          {
            geometry: {
              coordinates: [
                [0, 0],
                [4, 0],
              ],
              type: "LineString",
            },
            metrics: { load: 2 },
            properties: { stage: "start" },
            time: 0,
          },
          {
            geometry: {
              coordinates: [
                [0, 10],
                [4, 10],
              ],
              type: "LineString",
            },
            metrics: { load: 6 },
            properties: { stage: "end" },
            time: 10,
          },
        ],
      },
    ];

    expect(createTemporalGeoJsonPlaybackIndex(tracks).getFeatureCollectionAtTime(5)).toEqual(
      getTemporalGeoJsonFeatureCollectionAtTime(tracks, 5),
    );
  });
});

function createDenseRing(pointCount: number, radius: number, offsetX: number, offsetY: number) {
  const coordinates: Array<[number, number]> = [];

  for (let index = 0; index < pointCount; index += 1) {
    const angle = (index / pointCount) * Math.PI * 2;
    const radialOffset = radius * (1 + 0.12 * Math.sin(angle * 5));

    coordinates.push([
      offsetX + Math.cos(angle) * radialOffset,
      offsetY + Math.sin(angle) * radialOffset,
    ]);
  }

  coordinates.push([...coordinates[0]!] as [number, number]);

  return coordinates;
}
