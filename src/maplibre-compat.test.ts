import { describe, expect, test } from "vitest";

import { resolveMapLibreMarkerOffset } from "./maplibre-compat";

describe("@moritzbrantner/maps maplibre compatibility", () => {
  test("centers Leaflet-style div icons when the anchor is in the middle", () => {
    expect(resolveMapLibreMarkerOffset({ iconAnchor: [18, 18], iconSize: [36, 36] })).toEqual([
      0,
      0,
    ]);
  });

  test("converts Leaflet-style div icon anchors to MapLibre center offsets", () => {
    expect(resolveMapLibreMarkerOffset({ iconAnchor: [10, 16], iconSize: [24, 32] })).toEqual([
      2,
      0,
    ]);
  });
});
