import { describe, expect, test } from "vitest";

import {
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineFeatureCollectionAtTime,
  getGeoJsonTimelineSceneAtTime,
  setGeoJsonTimelineFeatureTransform,
  type TemporalGeoJsonGeometryFeatureCollection,
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
