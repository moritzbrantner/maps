import { describe, expect, test } from "vitest";

import { createMapLibreFlatLayerFactory, resolveMapLibreMarkerOffset } from "./maplibre-compat";

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

  test("creates empty DOM markers by default", () => {
    const markers: TestMarker[] = [];
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre(markers),
      createTestMap() as unknown as import("maplibre-gl").Map,
    );
    const group = createTestLayerGroup();

    factory.marker([52.52, 13.405]).addTo(group as never);

    expect(markers).toHaveLength(1);
    expect(markers[0]?.element.className).toBe("mb-maps__marker");
    expect(markers[0]?.element.childElementCount).toBe(0);
    expect(markers[0]?.element.textContent).toBe("");
  });

  test("keeps marker icon HTML on the documented trusted-markup path", () => {
    const markers: TestMarker[] = [];
    const factory = createMapLibreFlatLayerFactory(
      createTestMapLibre(markers),
      createTestMap() as unknown as import("maplibre-gl").Map,
    );
    const group = createTestLayerGroup();

    factory
      .marker([52.52, 13.405], {
        icon: {
          className: "custom-marker",
          html: "<span data-marker=\"trusted\">B</span>",
          iconAnchor: [12, 24],
          iconSize: [24, 24],
        },
        opacity: 0.5,
      })
      .addTo(group as never);

    expect(markers).toHaveLength(1);
    expect(markers[0]?.element.className).toBe("custom-marker");
    expect(markers[0]?.element.querySelector("[data-marker='trusted']")?.textContent).toBe("B");
    expect(markers[0]?.element.style.opacity).toBe("0.5");
    expect(markers[0]?.options.offset).toEqual([0, -12]);
  });
});

type TestMap = {
  __mbAddFlatMarker: (coordinates: [number, number], options: unknown) => void;
};

type TestLayerGroup = {
  addLayer: () => TestLayerGroup;
  addTo: () => TestLayerGroup;
  clearLayers: () => TestLayerGroup;
  layers: unknown[];
  remove: () => void;
  removeLayer: () => TestLayerGroup;
};

type TestMarkerOptions = {
  element: HTMLElement;
  offset?: [number, number];
};

class TestMarker {
  element: HTMLElement;
  options: TestMarkerOptions;

  constructor(options: TestMarkerOptions) {
    this.element = options.element;
    this.options = options;
  }

  setLngLat() {
    return this;
  }

  addTo() {
    return this;
  }

  remove() {}
}

function createTestMap(): TestMap {
  return {
    __mbAddFlatMarker() {},
  };
}

function createTestMapLibre(markers: TestMarker[]) {
  return {
    Marker: class extends TestMarker {
      constructor(options: TestMarkerOptions) {
        super(options);
        markers.push(this);
      }
    },
  } as unknown as typeof import("maplibre-gl");
}

function createTestLayerGroup(): TestLayerGroup {
  const group: TestLayerGroup = {
    addLayer: () => group,
    addTo: () => group,
    clearLayers: () => group,
    layers: [],
    remove() {},
    removeLayer: () => group,
  };

  return group;
}
