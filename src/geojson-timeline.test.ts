import { describe, expect, test } from "vitest";

import {
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineFeatureCollectionAtTime,
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
});
