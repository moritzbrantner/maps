import { describe, expect, test } from "vitest";

import {
  createGeoJsonTransitionPlan,
  interpolateGeoJsonTransitionPlan,
  type TemporalGeoJsonGeometryFeature,
  type TemporalGeoJsonGeometryFeatureCollection,
} from ".";

describe("@moritzbrantner/maps GeoJSON transitions", () => {
  test("interpolates compatible point geometry", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("point", { coordinates: [0, 0], type: "Point" })]),
        collection([feature("point", { coordinates: [10, 6], type: "Point" })]),
        { algorithm: "compatible" },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual({
      coordinates: [5, 3],
      type: "Point",
    });
  });

  test("resamples LineStrings with different vertex counts", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("route", {
            coordinates: [
              [0, 0],
              [10, 0],
            ],
            type: "LineString",
          }),
        ]),
        collection([
          feature("route", {
            coordinates: [
              [0, 10],
              [5, 15],
              [10, 10],
            ],
            type: "LineString",
          }),
        ]),
        { algorithm: "resample", minCoordinatesPerLine: 3 },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual({
      coordinates: [
        [0, 5],
        [5, 7.5],
        [10, 5],
      ],
      type: "LineString",
    });
  });

  test("interpolates compatible polygons", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("zone", square(0, 0, 4, 4))]),
        collection([feature("zone", square(2, 2, 6, 6))]),
        { algorithm: "compatible" },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual(square(1, 1, 5, 5));
  });

  test("vertex-union preserves source and target vertices on stable polygons", () => {
    const polygon = {
      coordinates: [
        [
          [1, 1],
          [7, 0],
          [9, 5],
          [5, 9],
          [0, 6],
          [1, 1],
        ],
      ],
      type: "Polygon" as const,
    };
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(collection([feature("stable", polygon)]), collection([feature("stable", polygon)]), {
        algorithm: "vertex-union",
        minCoordinatesPerRing: 4,
      }),
      0.5,
    );
    const ring = getPolygonRing(frame.features[0], 0);

    for (const point of polygon.coordinates[0].slice(0, -1)) {
      expect(ring).toContainEqual(point);
    }
  });

  test("vertex-union collapses disappearing holes to their centroid", () => {
    const from = {
      coordinates: [
        squareRing(0, 0, 10, 10),
        squareRing(3, 3, 7, 7),
      ],
      type: "Polygon" as const,
    };
    const to = {
      coordinates: [squareRing(0, 0, 10, 10)],
      type: "Polygon" as const,
    };
    const end = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(collection([feature("hole", from)]), collection([feature("hole", to)]), {
        algorithm: "vertex-union",
      }),
      1,
    );
    const hole = getPolygonRing(end.features[0], 1);

    expect(hole.every((position) => positionsEqual(position, [5, 5]))).toBe(true);
  });

  test("vertex-union grows appearing holes from their centroid", () => {
    const from = {
      coordinates: [squareRing(0, 0, 10, 10)],
      type: "Polygon" as const,
    };
    const to = {
      coordinates: [
        squareRing(0, 0, 10, 10),
        squareRing(3, 3, 7, 7),
      ],
      type: "Polygon" as const,
    };
    const start = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(collection([feature("hole", from)]), collection([feature("hole", to)]), {
        algorithm: "vertex-union",
      }),
      0,
    );
    const hole = getPolygonRing(start.features[0], 1);

    expect(hole.every((position) => positionsEqual(position, [5, 5]))).toBe(true);
  });

  test("interpolates MultiPolygon parts deterministically", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("multi", {
            coordinates: [[squareRing(0, 0, 4, 4)], [squareRing(10, 0, 14, 4)]],
            type: "MultiPolygon",
          }),
        ]),
        collection([
          feature("multi", {
            coordinates: [[squareRing(2, 2, 6, 6)], [squareRing(12, 2, 16, 6)]],
            type: "MultiPolygon",
          }),
        ]),
        { algorithm: "compatible" },
      ),
      0.5,
    );

    expect(frame.features[0]?.geometry).toEqual({
      coordinates: [[squareRing(1, 1, 5, 5)], [squareRing(11, 1, 15, 5)]],
      type: "MultiPolygon",
    });
  });

  test("uses hold and hide fallback for incompatible geometry types", () => {
    const from = collection([feature("shape", { coordinates: [0, 0], type: "Point" })]);
    const to = collection([feature("shape", square(0, 0, 4, 4))]);

    expect(
      interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(from, to, { algorithm: "compatible", fallback: "hold" }),
        0.5,
      ).features[0]?.geometry,
    ).toEqual({ coordinates: [0, 0], type: "Point" });
    expect(
      interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(from, to, { algorithm: "compatible", fallback: "hide" }),
        0.5,
      ).features,
    ).toEqual([]);
  });

  test("topology-plan emits preserve, disappear, and appear fragments for overlapping rectangles", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("from", square(0, 0, 6, 4))]),
        collection([feature("to", square(4, 2, 10, 6))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );
    const kinds = frame.features.map((item) => item.properties?.transitionKind).sort();

    expect(kinds).toEqual(["appear", "disappear", "preserve"]);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan emits split and merge fragments", () => {
    const split = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 8, 4))]),
        collection([feature("left", square(0, 0, 4, 4)), feature("right", square(4, 0, 8, 4))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );
    const merge = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("left", square(0, 0, 4, 4)), feature("right", square(4, 0, 8, 4))]),
        collection([feature("target", square(0, 0, 8, 4))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );

    expect(split.features.every((item) => item.properties?.transitionKind === "split")).toBe(true);
    expect(merge.features.every((item) => item.properties?.transitionKind === "merge")).toBe(true);
    expectGeometriesAreFiniteAndClosed(split);
    expectGeometriesAreFiniteAndClosed(merge);
  });

  test("topology-plan splits one polygon into three adjacent polygons", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 9, 3))]),
        collection([
          feature("west", square(0, 0, 3, 3)),
          feature("center", square(3, 0, 6, 3)),
          feature("east", square(6, 0, 9, 3)),
        ]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );

    expect(frame.features).toHaveLength(3);
    expect(frame.features.every((item) => item.properties?.transitionKind === "split")).toBe(true);
    expect(frame.features.flatMap((item) => readPropertyIds(item, "targetIds")).sort()).toEqual([
      "center",
      "east",
      "west",
    ]);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan splits one polygon into separated islands", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 12, 8))]),
        collection([
          feature("west-island", square(1, 1, 4, 4)),
          feature("east-island", square(8, 3, 11, 7)),
        ]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );

    expect(frame.features).toHaveLength(2);
    expect(frame.features.every((item) => readPropertyIds(item, "sourceIds").includes("source"))).toBe(true);
    expect(frame.features.flatMap((item) => readPropertyIds(item, "targetIds")).sort()).toEqual([
      "east-island",
      "west-island",
    ]);
    expect(frame.features.every((item) => countFeatureCoordinates(item) > 0)).toBe(true);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan handles empty scene transitions deterministically", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(collection([]), collection([]), {
        algorithm: "topology-plan",
      }),
      0.5,
    );

    expect(frame).toEqual({
      features: [],
      type: "FeatureCollection",
    });
  });

  test("resample transition keeps extreme-latitude and date-line-like coordinates finite", () => {
    const from = collection([
      feature("route", {
        coordinates: [
          [-179.5, 84.8],
          [0, 85],
          [179.5, 84.9],
        ],
        type: "LineString",
      }),
    ]);
    const to = collection([
      feature("route", {
        coordinates: [
          [-178.5, 83.8],
          [179.25, 83.9],
        ],
        type: "LineString",
      }),
    ]);

    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = interpolateGeoJsonTransitionPlan(
        createGeoJsonTransitionPlan(from, to, {
          algorithm: "resample",
          minCoordinatesPerLine: 4,
        }),
        progress,
      );

      expect(
        flattenNumbers(
          (frame.features[0]?.geometry as { coordinates?: unknown } | undefined)?.coordinates,
        ).every(Number.isFinite),
      ).toBe(true);
    }
  });

  test("topology-plan splits to a target polygon with a hole", () => {
    const withHole = {
      coordinates: [squareRing(5, 0, 10, 5), squareRing(6, 1, 8, 3)],
      type: "Polygon" as const,
    };
    const plan = createGeoJsonTransitionPlan(
      collection([feature("source", square(0, 0, 10, 5))]),
      collection([feature("plain", square(0, 0, 5, 5)), feature("with-hole", withHole)]),
      { algorithm: "topology-plan" },
    );
    const halfway = interpolateGeoJsonTransitionPlan(plan, 0.5);
    const end = interpolateGeoJsonTransitionPlan(plan, 1);
    const halfwayHoleFeature = halfway.features.find((item) =>
      readPropertyIds(item, "targetIds").includes("with-hole"),
    );
    const endHoleFeature = end.features.find((item) =>
      readPropertyIds(item, "targetIds").includes("with-hole"),
    );

    expectGeometriesAreFiniteAndClosed(halfway);
    expectGeometriesAreFiniteAndClosed(end);
    expect(getPolygonRing(halfwayHoleFeature, 1).at(0)).toEqual(getPolygonRing(halfwayHoleFeature, 1).at(-1));
    for (const position of withHole.coordinates[1].slice(0, -1)) {
      expect(getPolygonRing(endHoleFeature, 1).some((candidate) => positionsEqual(candidate, position))).toBe(
        true,
      );
    }
  });

  test("topology-plan merges three polygons into one polygon", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("west", square(0, 0, 3, 3)),
          feature("center", square(3, 0, 6, 3)),
          feature("east", square(6, 0, 9, 3)),
        ]),
        collection([feature("target", square(0, 0, 9, 3))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );

    expect(frame.features).toHaveLength(3);
    expect(frame.features.every((item) => item.properties?.transitionKind === "merge")).toBe(true);
    expect(frame.features.flatMap((item) => readPropertyIds(item, "sourceIds")).sort()).toEqual([
      "center",
      "east",
      "west",
    ]);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan merges separated polygons into one envelope", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("west", square(0, 0, 3, 3)),
          feature("east", square(7, 2, 10, 6)),
        ]),
        collection([feature("target", square(0, 0, 10, 6))]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );

    expect(frame.features.every((item) => readPropertyIds(item, "targetIds").includes("target"))).toBe(true);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan keeps non-polygon features during mixed scene transitions", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("source", square(0, 0, 8, 4)),
          feature("checkpoint", { coordinates: [0, 0], type: "Point" }),
        ]),
        collection([
          feature("left", square(0, 0, 4, 4)),
          feature("right", square(4, 0, 8, 4)),
          feature("checkpoint", { coordinates: [8, 4], type: "Point" }),
        ]),
        { algorithm: "topology-plan" },
      ),
      0.5,
    );
    const splitFeatures = frame.features.filter((item) => item.properties?.transitionKind === "split");
    const pointFeature = frame.features.find((item) => item.geometry?.type === "Point");

    expect(splitFeatures).toHaveLength(2);
    expect(pointFeature?.properties?.transitionKind).toBe("morph");
    expectPointGeometryCloseTo(pointFeature, [4, 2]);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan area-overlap classifies stable overlap as preserve", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("from", square(0, 0, 6, 4))]),
        collection([feature("to", square(4, 2, 10, 6))]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      0.5,
    );
    const kinds = frame.features.map((item) => item.properties?.transitionKind).sort();

    expect(kinds).toEqual(["appear", "disappear", "preserve"]);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan area-overlap splits one source into multiple targets by overlap", () => {
    const source = square(0, 0, 10, 4);
    const start = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", source)]),
        collection([feature("left", square(1, 0, 5, 4)), feature("right", square(5, 0, 9, 4))]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      0,
    );
    const splitFeatures = start.features.filter((item) => item.properties?.transitionKind === "split");

    expect(splitFeatures.flatMap((item) => readPropertyIds(item, "targetIds")).sort()).toEqual([
      "left",
      "right",
    ]);
    expect(splitFeatures.every((item) => !boundsEqual(getFeatureBounds(item), getGeometryBounds(source)))).toBe(
      true,
    );
    expectGeometriesAreFiniteAndClosed(start);
  });

  test("topology-plan area-overlap merges multiple sources into one target by overlap", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("left", square(0, 0, 5, 4)), feature("right", square(5, 0, 10, 4))]),
        collection([feature("target", square(1, 0, 9, 4))]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      0.5,
    );
    const mergeFeatures = frame.features.filter((item) => item.properties?.transitionKind === "merge");

    expect(mergeFeatures.flatMap((item) => readPropertyIds(item, "sourceIds")).sort()).toEqual([
      "left",
      "right",
    ]);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan area-overlap splits separated targets with a hull-guided partition", () => {
    const start = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 10, 4))]),
        collection([feature("west", square(-8, 0, -4, 4)), feature("east", square(14, 0, 18, 4))]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      0,
    );
    const splitFeatures = start.features.filter((item) => item.properties?.transitionKind === "split");
    const bounds = splitFeatures.map(getFeatureBounds);

    expect(splitFeatures).toHaveLength(2);
    expect(splitFeatures.flatMap((item) => readPropertyIds(item, "targetIds")).sort()).toEqual([
      "east",
      "west",
    ]);
    expect(bounds.some((item) => item.east <= 5.01)).toBe(true);
    expect(bounds.some((item) => item.west >= 4.99)).toBe(true);
    expectGeometriesAreFiniteAndClosed(start);
  });

  test("topology-plan area-overlap merges separated sources with a hull-guided partition", () => {
    const end = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("west", square(-8, 0, -4, 4)), feature("east", square(14, 0, 18, 4))]),
        collection([feature("target", square(0, 0, 10, 4))]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      1,
    );
    const mergeFeatures = end.features.filter((item) => item.properties?.transitionKind === "merge");
    const bounds = mergeFeatures.map(getFeatureBounds);

    expect(mergeFeatures).toHaveLength(2);
    expect(mergeFeatures.flatMap((item) => readPropertyIds(item, "sourceIds")).sort()).toEqual([
      "east",
      "west",
    ]);
    expect(bounds.some((item) => item.east <= 5.01)).toBe(true);
    expect(bounds.some((item) => item.west >= 4.99)).toBe(true);
    expectGeometriesAreFiniteAndClosed(end);
  });

  test("topology-plan area-overlap emits appear for target with no overlap", () => {
    const start = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 2, 2))]),
        collection([feature("target", square(12, 12, 14, 14))]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      0,
    );
    const appear = start.features.find((item) => item.properties?.transitionKind === "appear");

    expect(appear).toBeDefined();
    expect(getFeaturePositions(appear!).every((position) => positionsEqual(position, [13, 13]))).toBe(true);
  });

  test("topology-plan area-overlap emits disappear for source with no overlap", () => {
    const end = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 2, 2))]),
        collection([feature("target", square(12, 12, 14, 14))]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      1,
    );
    const disappear = end.features.find((item) => item.properties?.transitionKind === "disappear");

    expect(disappear).toBeDefined();
    expect(getFeaturePositions(disappear!).every((position) => positionsEqual(position, [1, 1]))).toBe(true);
  });

  test("topology-plan area-overlap handles holes", () => {
    const withHole = {
      coordinates: [squareRing(0, 0, 10, 10), squareRing(3, 3, 7, 7)],
      type: "Polygon" as const,
    };
    const shiftedHole = {
      coordinates: [squareRing(1, 1, 11, 11), squareRing(4, 4, 8, 8)],
      type: "Polygon" as const,
    };
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", withHole)]),
        collection([feature("target", shiftedHole)]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      0.5,
    );

    expect(frame.features.map((item) => item.properties?.transitionKind)).toContain("preserve");
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan area-overlap preserves non-polygon paired features", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("source", square(0, 0, 4, 4)),
          feature("checkpoint", { coordinates: [0, 0], type: "Point" }),
        ]),
        collection([
          feature("target", square(1, 1, 5, 5)),
          feature("checkpoint", { coordinates: [4, 4], type: "Point" }),
        ]),
        { algorithm: "topology-plan", topologyStrategy: "area-overlap" },
      ),
      0.5,
    );
    const pointFeature = frame.features.find((item) => item.geometry?.type === "Point");

    expect(pointFeature?.properties?.transitionKind).toBe("morph");
    expectPointGeometryCloseTo(pointFeature, [2, 2]);
  });

  test("topology-plan voronoi-partition splits source into clipped partitions", () => {
    const source = square(0, 0, 12, 6);
    const start = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", source)]),
        collection([
          feature("west", square(0, 0, 4, 6)),
          feature("center", square(4, 0, 8, 6)),
          feature("east", square(8, 0, 12, 6)),
        ]),
        { algorithm: "topology-plan", topologyStrategy: "voronoi-partition" },
      ),
      0,
    );
    const splitFeatures = start.features.filter((item) => item.properties?.transitionKind === "split");
    const bounds = splitFeatures.map(getFeatureBounds);

    expect(splitFeatures).toHaveLength(3);
    expect(new Set(bounds.map((item) => `${item.west}:${item.east}`)).size).toBe(3);
    expect(bounds.every((item) => !boundsEqual(item, getGeometryBounds(source)))).toBe(true);
    expectGeometriesAreFiniteAndClosed(start);
  });

  test("topology-plan voronoi-partition merges sources into target partitions", () => {
    const end = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("west", square(0, 0, 4, 6)),
          feature("center", square(4, 0, 8, 6)),
          feature("east", square(8, 0, 12, 6)),
        ]),
        collection([feature("target", square(0, 0, 12, 6))]),
        { algorithm: "topology-plan", topologyStrategy: "voronoi-partition" },
      ),
      1,
    );
    const mergeFeatures = end.features.filter((item) => item.properties?.transitionKind === "merge");
    const bounds = mergeFeatures.map(getFeatureBounds);

    expect(mergeFeatures).toHaveLength(3);
    expect(new Set(bounds.map((item) => `${item.west}:${item.east}`)).size).toBe(3);
    expectGeometriesAreFiniteAndClosed(end);
  });

  test("topology-plan voronoi-partition falls back when duplicate centroids degenerate", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([feature("source", square(0, 0, 10, 10))]),
        collection([
          feature("first", square(2, 2, 8, 8)),
          feature("second", square(2, 2, 8, 8)),
        ]),
        { algorithm: "topology-plan", topologyStrategy: "voronoi-partition" },
      ),
      0.5,
    );

    expect(frame.features.filter((item) => item.properties?.transitionKind === "split")).toHaveLength(2);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan voronoi-partition handles separated islands", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("source", {
            coordinates: [[squareRing(0, 0, 2, 2)], [squareRing(10, 0, 12, 2)]],
            type: "MultiPolygon",
          }),
        ]),
        collection([
          feature("left", square(0, 0, 2, 2)),
          feature("right", square(10, 0, 12, 2)),
        ]),
        { algorithm: "topology-plan", topologyStrategy: "voronoi-partition" },
      ),
      0.5,
    );

    expect(frame.features).toHaveLength(2);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan flattens GeometryCollection parts without dropping mixed geometries", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("mixed", {
            geometries: [
              { coordinates: [0, 0], type: "Point" },
              {
                coordinates: [
                  [0, 0],
                  [2, 0],
                ],
                type: "LineString",
              },
              square(0, 0, 2, 2),
            ],
            type: "GeometryCollection",
          }),
        ]),
        collection([
          feature("mixed", {
            geometries: [
              { coordinates: [4, 4], type: "Point" },
              {
                coordinates: [
                  [0, 2],
                  [2, 2],
                ],
                type: "LineString",
              },
              square(1, 1, 3, 3),
            ],
            type: "GeometryCollection",
          }),
        ]),
        { algorithm: "topology-plan", partMatchingStrategy: "auto" },
      ),
      0.5,
    );
    const types = frame.features.map((item) => item.geometry?.type).sort();

    expect(types).toEqual(["LineString", "Point", "Polygon", "Polygon", "Polygon"]);
    expect(frame.features.some((item) => item.properties?.sourcePartPath === "geometry.geometries[0]")).toBe(
      true,
    );
    expect(frame.features.some((item) => item.properties?.targetPartPath === "geometry.geometries[1]")).toBe(
      true,
    );
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("nearest-centroid part matching handles reordered MultiLineString parts", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("routes", {
            coordinates: [
              [
                [0, 0],
                [2, 0],
              ],
              [
                [100, 0],
                [102, 0],
              ],
            ],
            type: "MultiLineString",
          }),
        ]),
        collection([
          feature("routes", {
            coordinates: [
              [
                [100, 10],
                [102, 10],
              ],
              [
                [0, 10],
                [2, 10],
              ],
            ],
            type: "MultiLineString",
          }),
        ]),
        {
          algorithm: "resample",
          complexGeometryBehavior: "decompose",
          minCoordinatesPerLine: 2,
          minCoordinatesPerRing: 2,
          partMatchingStrategy: "nearest-centroid",
        },
      ),
      0.5,
    );

    expect(frame.features).toHaveLength(2);
    expect(frame.features[0]?.geometry).toEqual({
      coordinates: [
        [0, 5],
        [2, 5],
      ],
      type: "LineString",
    });
    expect(frame.features[1]?.geometry).toEqual({
      coordinates: [
        [100, 5],
        [102, 5],
      ],
      type: "LineString",
    });
    expect(frame.features.every((item) => item.properties?.partMatchStrategy === "nearest-centroid")).toBe(
      true,
    );
  });

  test("topology-plan auto matching preserves reordered MultiPolygon islands by overlap", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("islands", {
            coordinates: [[squareRing(0, 0, 2, 2)], [squareRing(10, 0, 12, 2)]],
            type: "MultiPolygon",
          }),
        ]),
        collection([
          feature("islands", {
            coordinates: [[squareRing(10, 0, 12, 2)], [squareRing(0, 0, 2, 2)]],
            type: "MultiPolygon",
          }),
        ]),
        { algorithm: "topology-plan", partMatchingStrategy: "auto" },
      ),
      0.5,
    );

    expect(frame.features).toHaveLength(2);
    expect(frame.features.every((item) => item.properties?.transitionKind === "preserve")).toBe(true);
    expect(frame.features.every((item) => item.properties?.partMatchStrategy === "overlap")).toBe(true);
    expectGeometriesAreFiniteAndClosed(frame);
  });

  test("topology-plan emits appear and disappear for unmatched decomposed polygon parts", () => {
    const frame = interpolateGeoJsonTransitionPlan(
      createGeoJsonTransitionPlan(
        collection([
          feature("source", {
            coordinates: [[squareRing(0, 0, 2, 2)], [squareRing(-12, -12, -10, -10)]],
            type: "MultiPolygon",
          }),
        ]),
        collection([
          feature("target", {
            coordinates: [[squareRing(0, 0, 2, 2)], [squareRing(10, 10, 12, 12)]],
            type: "MultiPolygon",
          }),
        ]),
        { algorithm: "topology-plan", partMatchingStrategy: "auto" },
      ),
      0.5,
    );

    expect(frame.features.map((item) => item.properties?.transitionKind)).toContain("appear");
    expect(frame.features.map((item) => item.properties?.transitionKind)).toContain("disappear");
    expectGeometriesAreFiniteAndClosed(frame);
  });
});

function collection(
  features: TemporalGeoJsonGeometryFeature[],
): TemporalGeoJsonGeometryFeatureCollection {
  return {
    features,
    type: "FeatureCollection",
  };
}

function feature(
  id: string,
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): TemporalGeoJsonGeometryFeature {
  return {
    geometry,
    id,
    properties: null,
    type: "Feature",
  };
}

function square(west: number, south: number, east: number, north: number) {
  return {
    coordinates: [squareRing(west, south, east, north)],
    type: "Polygon" as const,
  };
}

function squareRing(west: number, south: number, east: number, north: number) {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ] satisfies Array<[number, number]>;
}

function positionsEqual(left: readonly number[], right: readonly number[]) {
  return Math.abs(left[0]! - right[0]!) < 1e-2 && Math.abs(left[1]! - right[1]!) < 1e-2;
}

function expectPointGeometryCloseTo(
  feature: TemporalGeoJsonGeometryFeature | undefined,
  position: [number, number],
) {
  expect(feature?.geometry?.type).toBe("Point");
  const coordinates = (feature!.geometry as { coordinates: [number, number]; type: "Point" }).coordinates;

  expect(positionsEqual(coordinates, position)).toBe(true);
}

function getPolygonRing(
  feature: TemporalGeoJsonGeometryFeature | undefined,
  index: number,
): Array<[number, number]> {
  expect(feature?.geometry?.type).toBe("Polygon");

  return (
    feature!.geometry as {
      coordinates: Array<Array<[number, number]>>;
      type: "Polygon";
    }
  ).coordinates[index] ?? [];
}

function readPropertyIds(feature: TemporalGeoJsonGeometryFeature, key: "sourceIds" | "targetIds") {
  const value = feature.properties?.[key];

  return Array.isArray(value) ? value.map(String) : [];
}

function countFeatureCoordinates(feature: TemporalGeoJsonGeometryFeature) {
  return flattenNumbers(
    (feature.geometry as { coordinates?: unknown } | null | undefined)?.coordinates,
  ).length / 2;
}

function getFeaturePositions(feature: TemporalGeoJsonGeometryFeature) {
  return getGeometryPositions(feature.geometry);
}

function getGeometryPositions(geometry: TemporalGeoJsonGeometryFeature["geometry"]) {
  const coordinates = (geometry as { coordinates?: unknown } | null | undefined)?.coordinates;
  const numbers = flattenNumbers(coordinates);
  const positions: Array<[number, number]> = [];

  for (let index = 0; index < numbers.length; index += 2) {
    positions.push([numbers[index]!, numbers[index + 1]!]);
  }

  return positions;
}

function getFeatureBounds(feature: TemporalGeoJsonGeometryFeature) {
  return getBoundsFromPositions(getFeaturePositions(feature));
}

function getGeometryBounds(geometry: TemporalGeoJsonGeometryFeature["geometry"]) {
  return getBoundsFromPositions(getGeometryPositions(geometry));
}

function getBoundsFromPositions(positions: Array<[number, number]>) {
  return positions.reduce(
    (bounds, position) => ({
      east: Math.max(bounds.east, position[0]),
      north: Math.max(bounds.north, position[1]),
      south: Math.min(bounds.south, position[1]),
      west: Math.min(bounds.west, position[0]),
    }),
    {
      east: Number.NEGATIVE_INFINITY,
      north: Number.NEGATIVE_INFINITY,
      south: Number.POSITIVE_INFINITY,
      west: Number.POSITIVE_INFINITY,
    },
  );
}

function boundsEqual(
  left: ReturnType<typeof getBoundsFromPositions>,
  right: ReturnType<typeof getBoundsFromPositions>,
) {
  return (
    Math.abs(left.west - right.west) < 1e-6 &&
    Math.abs(left.south - right.south) < 1e-6 &&
    Math.abs(left.east - right.east) < 1e-6 &&
    Math.abs(left.north - right.north) < 1e-6
  );
}

function expectGeometriesAreFiniteAndClosed(collection: TemporalGeoJsonGeometryFeatureCollection) {
  for (const item of collection.features) {
    const geometry = item.geometry as
      | {
          coordinates?: unknown;
          type: string;
        }
      | null;
    const coordinates = geometry?.coordinates;

    expect(flattenNumbers(coordinates).every(Number.isFinite)).toBe(true);

    if (geometry?.type === "Polygon") {
      for (const ring of coordinates as Array<Array<[number, number]>>) {
        expect(ring.at(0)).toEqual(ring.at(-1));
      }
    }

    if (geometry?.type === "MultiPolygon") {
      for (const polygon of coordinates as Array<Array<Array<[number, number]>>>) {
        for (const ring of polygon) {
          expect(ring.at(0)).toEqual(ring.at(-1));
        }
      }
    }
  }
}

function flattenNumbers(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(flattenNumbers);
}
