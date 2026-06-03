import { describe, expect, test } from "vitest";

import {
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineFeatureCollectionAtTime,
  getGeoJsonTimelineSceneAtTime,
  setGeoJsonTimelineFeatureTransform,
  type TemporalGeoJsonGeometryFeatureCollection,
  type TemporalGeoJsonSupportedGeometry,
} from ".";

const collection = {
  features: [
    {
      geometry: {
        coordinates: [10, 50],
        type: "Point",
      },
      id: "point-1",
      properties: {
        label: "Point 1",
      },
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
} satisfies TemporalGeoJsonGeometryFeatureCollection;

describe("@moritzbrantner/maps GeoJSON timeline", () => {
  test("creates a timeline document from GeoJSON features", () => {
    const document = createGeoJsonTimelineDocument(collection, { durationMs: 4_000 });

    expect(document.tracks).toHaveLength(1);
    expect(document.tracks[0]?.items[0]).toMatchObject({
      data: {
        featureId: "point-1",
      },
      durationMs: 4_000,
      id: "geojson-feature:point-1",
      label: "Point 1",
      startMs: 0,
    });
  });

  test("samples timeline transforms into a GeoJSON feature collection", () => {
    const document = setGeoJsonTimelineFeatureTransform(
      createGeoJsonTimelineDocument(collection, { durationMs: 4_000 }),
      "point-1",
      {
        points: [
          { offsetMs: 0, values: { latitudeOffset: 0, longitudeOffset: 0 } },
          { offsetMs: 4_000, values: { latitudeOffset: 2, longitudeOffset: 4 } },
        ],
      },
    );

    const transformed = getGeoJsonTimelineFeatureCollectionAtTime(collection, document, 2_000);

    expect(transformed.features[0]?.geometry).toEqual({
      coordinates: [12, 51],
      type: "Point",
    });
    expect(collection.features[0]?.geometry).toEqual({
      coordinates: [10, 50],
      type: "Point",
    });
  });

  test("clips polygon timeline transforms to a polygon constraint", () => {
    const polygonCollection = {
      features: [sceneFeature("land-use", 0, 4_000, square(0, 0, 4, 4))],
      type: "FeatureCollection",
    } satisfies TemporalGeoJsonGeometryFeatureCollection;
    const document = setGeoJsonTimelineFeatureTransform(
      createGeoJsonTimelineDocument(polygonCollection, { durationMs: 4_000 }),
      "land-use",
      {
        points: [
          { offsetMs: 0, values: { longitudeOffset: 0 } },
          { offsetMs: 4_000, values: { longitudeOffset: 2 } },
        ],
      },
    );

    const transformed = getGeoJsonTimelineFeatureCollectionAtTime(
      polygonCollection,
      document,
      2_000,
      {
        polygonConstraint: square(2, -1, 6, 5),
      },
    );

    expect(
      getGeometryBounds(
        (transformed.features[0]?.geometry ?? null) as TemporalGeoJsonSupportedGeometry | null,
      ),
    ).toEqual({
      east: 5,
      north: 4,
      south: 0,
      west: 2,
    });
  });

  test("samples same-track scenes with a hard cut when transition duration is zero", () => {
    const document = createGeoJsonTimelineDocument(sceneCollection, {
      durationMs: 2_000,
      getTimelineTrackId: () => "scene",
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      itemDurationMs: 1_000,
    });

    expect(
      getGeoJsonTimelineSceneAtTime(sceneCollection, document, 250, {
        defaultTransition: { durationMs: 0 },
      }).features.map((feature) => feature.id),
    ).toEqual(["scene-a"]);
    expect(
      getGeoJsonTimelineSceneAtTime(sceneCollection, document, 1_250, {
        defaultTransition: { durationMs: 0 },
      }).features.map((feature) => feature.id),
    ).toEqual(["scene-b"]);
  });

  test("samples interpolated geometry during a same-track transition", () => {
    const document = createGeoJsonTimelineDocument(sceneCollection, {
      durationMs: 2_000,
      getTimelineTrackId: () => "scene",
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      itemDurationMs: 1_000,
    });
    const frame = getGeoJsonTimelineSceneAtTime(sceneCollection, document, 750, {
      defaultTransition: {
        algorithm: "compatible",
        durationMs: 500,
      },
    });

    expect(frame.features).toHaveLength(1);
    expect(readTransitionKind(frame.features[0])).toBe("morph");
    expect(frame.features[0]?.geometry).toEqual({
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

  test("emits previous and next scene outside the transition interval", () => {
    const document = createGeoJsonTimelineDocument(sceneCollection, {
      durationMs: 2_000,
      getTimelineTrackId: () => "scene",
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      itemDurationMs: 1_000,
    });
    const options = {
      defaultTransition: {
        algorithm: "compatible" as const,
        durationMs: 500,
      },
    };

    expect(getGeoJsonTimelineSceneAtTime(sceneCollection, document, 250, options).features[0]?.id).toBe(
      "scene-a",
    );
    expect(getGeoJsonTimelineSceneAtTime(sceneCollection, document, 1_250, options).features[0]?.id).toBe(
      "scene-b",
    );
  });

  test("keeps transform-only sampling behavior unchanged", () => {
    const document = createGeoJsonTimelineDocument(sceneCollection, {
      durationMs: 2_000,
      getTimelineTrackId: () => "scene",
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      itemDurationMs: 1_000,
    });

    expect(getGeoJsonTimelineFeatureCollectionAtTime(sceneCollection, document, 750).features).toHaveLength(
      2,
    );
    expect(
      getGeoJsonTimelineSceneAtTime(sceneCollection, document, 750, {
        defaultTransition: { algorithm: "compatible", durationMs: 500 },
      }).features,
    ).toHaveLength(1);
  });

  test("samples one-to-many scene transition as split fragments", () => {
    const document = createGeoJsonTimelineDocument(splitSceneCollection, {
      durationMs: 2_000,
      getItemDurationMs: (feature) => Number(feature.properties?.durationMs),
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      getTimelineTrackId: () => "districts",
    });
    const options = {
      defaultTransition: {
        algorithm: "topology-plan" as const,
        durationMs: 500,
        topologyStrategy: "area-overlap" as const,
      },
    };

    expect(getGeoJsonTimelineSceneAtTime(splitSceneCollection, document, 250, options).features.map((feature) => feature.id)).toEqual([
      "source",
    ]);

    const transitionFrame = getGeoJsonTimelineSceneAtTime(splitSceneCollection, document, 750, options);
    expect(transitionFrame.features).toHaveLength(2);
    expect(transitionFrame.features.every((feature) => feature.properties?.transitionKind === "split")).toBe(true);
    expectGeometriesAreFiniteAndClosed(transitionFrame);

    expect(getGeoJsonTimelineSceneAtTime(splitSceneCollection, document, 1_000, options).features.map((feature) => feature.id)).toEqual([
      "left",
      "right",
    ]);
    expect(getGeoJsonTimelineSceneAtTime(splitSceneCollection, document, 1_250, options).features.map((feature) => feature.id)).toEqual([
      "left",
      "right",
    ]);
  });

  test("samples many-to-one scene transition as merge fragments", () => {
    const document = createGeoJsonTimelineDocument(mergeSceneCollection, {
      durationMs: 2_000,
      getItemDurationMs: (feature) => Number(feature.properties?.durationMs),
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      getTimelineTrackId: () => "districts",
    });
    const options = {
      defaultTransition: {
        algorithm: "topology-plan" as const,
        durationMs: 500,
        topologyStrategy: "area-overlap" as const,
      },
    };

    expect(getGeoJsonTimelineSceneAtTime(mergeSceneCollection, document, 250, options).features.map((feature) => feature.id)).toEqual([
      "left",
      "right",
    ]);

    const transitionFrame = getGeoJsonTimelineSceneAtTime(mergeSceneCollection, document, 750, options);
    expect(transitionFrame.features).toHaveLength(2);
    expect(transitionFrame.features.every((feature) => feature.properties?.transitionKind === "merge")).toBe(true);
    expectGeometriesAreFiniteAndClosed(transitionFrame);

    expect(getGeoJsonTimelineSceneAtTime(mergeSceneCollection, document, 1_000, options).features.map((feature) => feature.id)).toEqual([
      "target",
    ]);
  });

  test("uses getSceneTransition before getTransition", () => {
    const document = createGeoJsonTimelineDocument(splitSceneCollection, {
      durationMs: 2_000,
      getItemDurationMs: (feature) => Number(feature.properties?.durationMs),
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      getTimelineTrackId: () => "districts",
    });
    let itemTransitionCalled = false;
    const frame = getGeoJsonTimelineSceneAtTime(splitSceneCollection, document, 750, {
      getSceneTransition: () => ({ algorithm: "topology-plan", durationMs: 500 }),
      getTransition: () => {
        itemTransitionCalled = true;
        return { algorithm: "hold", durationMs: 500 };
      },
    });

    expect(itemTransitionCalled).toBe(false);
    expect(frame.features).toHaveLength(2);
    expect(frame.features.every((feature) => feature.properties?.transitionKind === "split")).toBe(true);
  });

  test("samples one-to-many scene transition with voronoi topology partitions", () => {
    const document = createGeoJsonTimelineDocument(splitSceneCollection, {
      durationMs: 2_000,
      getItemDurationMs: (feature) => Number(feature.properties?.durationMs),
      getItemStartMs: (feature) => Number(feature.properties?.startMs),
      getTimelineTrackId: () => "districts",
    });
    const options = {
      defaultTransition: {
        algorithm: "topology-plan" as const,
        durationMs: 500,
        topologyStrategy: "voronoi-partition" as const,
      },
    };

    const transitionFrame = getGeoJsonTimelineSceneAtTime(splitSceneCollection, document, 750, options);

    expect(transitionFrame.features).toHaveLength(2);
    expect(transitionFrame.features.every((feature) => feature.properties?.transitionKind === "split")).toBe(true);
    expectGeometriesAreFiniteAndClosed(transitionFrame);
    expect(getGeoJsonTimelineSceneAtTime(splitSceneCollection, document, 1_000, options).features.map((feature) => feature.id)).toEqual([
      "left",
      "right",
    ]);
  });
});

const sceneCollection = {
  features: [
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
      id: "scene-a",
      properties: {
        startMs: 0,
      },
      type: "Feature",
    },
    {
      geometry: {
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
      id: "scene-b",
      properties: {
        startMs: 1_000,
      },
      type: "Feature",
    },
  ],
  type: "FeatureCollection",
} satisfies TemporalGeoJsonGeometryFeatureCollection;

const splitSceneCollection = {
  features: [
    sceneFeature("source", 0, 1_000, square(0, 0, 8, 4)),
    sceneFeature("left", 1_000, 1_000, square(0, 0, 4, 4)),
    sceneFeature("right", 1_000, 1_000, square(4, 0, 8, 4)),
  ],
  type: "FeatureCollection",
} satisfies TemporalGeoJsonGeometryFeatureCollection;

const mergeSceneCollection = {
  features: [
    sceneFeature("left", 0, 1_000, square(0, 0, 4, 4)),
    sceneFeature("right", 0, 1_000, square(4, 0, 8, 4)),
    sceneFeature("target", 1_000, 1_000, square(0, 0, 8, 4)),
  ],
  type: "FeatureCollection",
} satisfies TemporalGeoJsonGeometryFeatureCollection;

function sceneFeature(
  id: string,
  startMs: number,
  durationMs: number,
  geometry: TemporalGeoJsonGeometryFeatureCollection["features"][number]["geometry"],
): TemporalGeoJsonGeometryFeatureCollection["features"][number] {
  return {
    geometry,
    id,
    properties: {
      durationMs,
      startMs,
    },
    type: "Feature",
  };
}

function square(
  west: number,
  south: number,
  east: number,
  north: number,
): Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }> {
  return {
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
    type: "Polygon" as const,
  };
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
  }
}

function getGeometryBounds(geometry: TemporalGeoJsonSupportedGeometry | null) {
  expect(geometry).not.toBeNull();

  const positions =
    geometry?.type === "Polygon"
      ? geometry.coordinates.flat()
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates.flat(2)
        : [];

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

function flattenNumbers(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(flattenNumbers);
}

function readTransitionKind(feature: TemporalGeoJsonGeometryFeatureCollection["features"][number] | undefined) {
  const properties = feature?.properties as { transitionKind?: unknown } | null | undefined;

  return properties?.transitionKind;
}
