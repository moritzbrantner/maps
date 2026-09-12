import { describe, expect, it } from "vitest";

import { createCircleVectorRenderFrame } from "./map-render-frame";

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
      primitiveId: "point-layer:capital:feature:berlin",
    });
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
