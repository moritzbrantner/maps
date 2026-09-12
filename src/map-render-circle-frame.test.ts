import { describe, expect, it } from "vitest";

import {
  createCircleVectorRenderFrame,
  createGeoJsonVectorRenderFrame,
} from "./map-render-frame";

describe("createCircleVectorRenderFrame", () => {
  it("keeps semantic identity separate from renderer primitive identity", () => {
    const feature = { coordinates: [13.405, 52.52] as [number, number], id: "berlin" };
    const frame = createCircleVectorRenderFrame([feature], {
      getCoordinates: (value) => value.coordinates,
      getFeatureId: (value) => `feature:${value.id}`,
      getFillColor: () => "#dc2626",
      getRadius: () => 8,
      primitivePrefix: "point-layer:capital",
    });

    expect(frame.primitives[0]).toMatchObject({
      feature,
      featureId: "feature:berlin",
      kind: "circle",
      primitiveId: '["point-layer:capital","feature:berlin"]',
    });
  });

  it("keeps delimiter-bearing layer and feature identities unambiguous", () => {
    const left = createCircleVectorRenderFrame(
      [{ coordinates: [1, 2] as [number, number], id: "c" }],
      {
        getCoordinates: (feature) => feature.coordinates,
        getFeatureId: (feature) => feature.id,
        getFillColor: () => "#000000",
        getRadius: () => 4,
        primitivePrefix: "point:a:b",
      },
    );
    const right = createCircleVectorRenderFrame(
      [{ coordinates: [1, 2] as [number, number], id: "b:c" }],
      {
        getCoordinates: (feature) => feature.coordinates,
        getFeatureId: (feature) => feature.id,
        getFillColor: () => "#000000",
        getRadius: () => 4,
        primitivePrefix: "point:a",
      },
    );

    expect(left.primitives[0]?.primitiveId).not.toBe(right.primitives[0]?.primitiveId);
  });

  it("carries interaction eligibility without adding callbacks to the frame", () => {
    const frame = createCircleVectorRenderFrame([{ id: "passive", position: [1, 2] as [number, number] }], {
      getCoordinates: (feature) => feature.position,
      getFeatureId: (feature) => feature.id,
      getFillColor: () => "#000000",
      getRadius: () => 4,
      isFeatureInteractive: () => false,
    });

    expect(frame.primitives[0]?.interactive).toBe(false);
    expect(Object.keys(frame.primitives[0] ?? {}).some((key) => key.startsWith("on"))).toBe(false);
  });

  it("copies coordinates and clamps invalid negative radii at the semantic boundary", () => {
    const coordinates: [number, number] = [5, 6];
    const frame = createCircleVectorRenderFrame([{ coordinates, id: "a" }], {
      getCoordinates: (feature) => feature.coordinates,
      getFeatureId: (feature) => feature.id,
      getFillColor: () => "#000000",
      getRadius: () => -5,
    });

    coordinates[0] = 99;
    expect(frame.primitives[0]).toMatchObject({ center: [5, 6], radius: 0 });
  });
});

describe("createGeoJsonVectorRenderFrame", () => {
  it("clamps negative point radii before they become Canvas2D input", () => {
    const frame = createGeoJsonVectorRenderFrame(
      [
        {
          geometry: { coordinates: [13.405, 52.52], type: "Point" },
          id: "berlin",
          properties: {},
          sourceIndex: 0,
        },
      ],
      {
        getFeatureStyle: () => ({ pointRadius: -5 }),
      },
    );

    expect(frame.primitives[0]).toMatchObject({ kind: "circle", radius: 0 });
  });
});
