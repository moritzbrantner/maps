import { describe, expect, test } from "vitest";

import { comingFeatures, featureRoutes, featureSearch, readFeatureRoute } from "./feature-route";

describe("feature page URL state", () => {
  test("defaults to the heat route and its combined render mode", () => {
    expect(readFeatureRoute("")).toEqual({ feature: "heat", heatMode: "raster-contours" });
  });

  test("reads each first-party feature and the heat render mode from the query", () => {
    for (const route of featureRoutes) {
      expect(readFeatureRoute(`?feature=${route.id}`).feature).toBe(route.id);
    }
    expect(readFeatureRoute("?feature=heat&mode=contours").heatMode).toBe("contours");
  });

  test("falls back for unknown or not-yet-first-party features instead of inventing a route", () => {
    expect(readFeatureRoute("?feature=editing").feature).toBe("heat");
    expect(readFeatureRoute("?feature=../engine").feature).toBe("heat");
    expect(readFeatureRoute("?feature=heat&mode=wireframe").heatMode).toBe("raster-contours");
    expect(featureRoutes.map((route) => route.id)).not.toContain("editing");
    expect(comingFeatures.length).toBeGreaterThan(0);
  });

  test("writes shareable query strings that round-trip", () => {
    expect(featureSearch({ feature: "clusters", heatMode: "raster-contours" })).toBe(
      "?feature=clusters",
    );
    const heat = featureSearch({ feature: "heat", heatMode: "raster" });
    expect(heat).toBe("?feature=heat&mode=raster");
    expect(readFeatureRoute(heat)).toEqual({ feature: "heat", heatMode: "raster" });
  });
});
