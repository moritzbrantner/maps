import type {
  GeoJsonTopologyStrategy,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonInterpolationStrategy,
  TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";

import type {
  DemoGeoJsonProperties,
  DemoInterpolationExample,
  DemoInterpolationGeometryPair,
  DemoInterpolationGeometryType,
  DemoInterpolationKeyframeId,
} from "../types";

export const demoInterpolationStrategies: Array<{
  description: string;
  id: TemporalGeoJsonInterpolationStrategy;
  label: string;
}> = [
  {
    description:
      "Pairs existing coordinates one-for-one and falls back to hold when counts differ.",
    id: "compatible",
    label: "Compatible",
  },
  {
    description: "Samples lines and rings into evenly spaced coordinates before blending.",
    id: "resample",
    label: "Resample",
  },
  {
    description: "Builds a shared polygon vertex set so changing outlines keep sharper corners.",
    id: "vertex-union",
    label: "Vertex union",
  },
  {
    description: "Samples polygon rings radially around the centroid for more organic morphs.",
    id: "centroid-radial",
    label: "Centroid radial",
  },
  {
    description: "Displays the previous keyframe until the next one takes over.",
    id: "hold",
    label: "Hold",
  },
];

export const demoTopologyStrategies: Array<{
  id: Exclude<GeoJsonTopologyStrategy, "bounds">;
  label: string;
}> = [
  { id: "area-overlap", label: "Area overlap" },
  { id: "voronoi-partition", label: "Voronoi partition" },
];

export const demoInterpolationExamples = createDemoInterpolationExamples();
export const demoInterpolationLandmassConstraint = {
  coordinates: [
    [
      [-10.2, 36.5],
      [-5.5, 36.5],
      [-2.5, 38.0],
      [1.0, 40.5],
      [5.5, 43.4],
      [10.6, 44.2],
      [17.6, 47.8],
      [24.8, 53.5],
      [21.0, 59.5],
      [12.0, 61.2],
      [3.8, 57.8],
      [-1.5, 54.8],
      [-6.5, 50.7],
      [-9.8, 45.2],
      [-10.2, 36.5],
    ],
  ],
  type: "Polygon",
} satisfies Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>;
export const demoInterpolationLandmassCollection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> =
  {
    features: [
      {
        geometry: demoInterpolationLandmassConstraint,
        properties: {
          kind: "interpolation-constraint",
          label: "Landmass constraint",
          time: 0,
          trackId: "interpolation-constraint",
        },
        type: "Feature",
      },
    ],
    type: "FeatureCollection",
  };

export function createDemoInterpolationGeometryExamples() {
  return Object.fromEntries(
    demoInterpolationExamples.flatMap((example) =>
      example.kind === "topology" ? [] : [[example.id, example.pair]],
    ),
  ) as Record<string, DemoInterpolationGeometryPair>;
}

export function getDemoInterpolationDefaultStrategy(example: DemoInterpolationExample) {
  return example.kind === "topology" ? "vertex-union" : example.defaultStrategy;
}

function createDemoInterpolationExamples(): DemoInterpolationExample[] {
  return [
    {
      defaultStrategy: "vertex-union",
      description: "Two service areas both move and skew while keeping matching polygon counts.",
      geometryType: "MultiPolygon",
      id: "multipolygon-two-islands",
      label: "MultiPolygon: two moving areas",
      pair: createDemoInterpolationGeometryPair("MultiPolygon"),
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The next keyframe adds a second polygon. Algorithms fall back to holding the previous MultiPolygon because the polygon count is incompatible.",
      geometryType: "MultiPolygon",
      id: "multipolygon-added-part",
      label: "MultiPolygon: added part fallback",
      pair: {
        end: createDemoInterpolationGeometryPair("MultiPolygon").end,
        start: {
          coordinates: [
            [
              [
                [-9.6, 37.4],
                [-3.0, 37.7],
                [-3.3, 41.2],
                [-9.4, 41.0],
                [-9.6, 37.4],
              ],
            ],
          ],
          type: "MultiPolygon",
        },
      },
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The west polygon has an interior ring in both keyframes, so the hole interpolates with the shell.",
      geometryType: "MultiPolygon",
      id: "multipolygon-hole",
      label: "MultiPolygon: hole",
      pair: createDemoMultiPolygonHolePair(),
    },
    {
      defaultStrategy: "centroid-radial",
      description:
        "A polygon changes from a simple square into a concave outline with extra vertices.",
      geometryType: "Polygon",
      id: "polygon-concave-extra-vertices",
      label: "Polygon: concave extra vertices",
      pair: createDemoConcavePolygonPair(),
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The shell winds in the opposite direction at the end keyframe, testing ring orientation alignment before blending.",
      geometryType: "Polygon",
      id: "polygon-reversed-ring",
      label: "Polygon: reversed ring",
      pair: createDemoReversedRingPolygonPair(),
    },
    {
      defaultStrategy: "vertex-union",
      description:
        "The end keyframe introduces an interior ring. Vertex union collapses the missing start hole to its centroid.",
      geometryType: "Polygon",
      id: "polygon-hole-appears",
      label: "Polygon: hole appears",
      pair: createDemoPolygonHoleAppearsPair(),
    },
    {
      defaultStrategy: "centroid-radial",
      description:
        "A thin service sliver expands into a broad area, stressing centroid sampling and very uneven edge lengths.",
      geometryType: "Polygon",
      id: "polygon-sliver-expansion",
      label: "Polygon: sliver expansion",
      pair: createDemoSliverPolygonPair(),
    },
    {
      defaultStrategy: "resample",
      description:
        "A route changes point density between keyframes; resample creates matching intermediate points.",
      geometryType: "LineString",
      id: "line-density-change",
      label: "LineString: density change",
      pair: createDemoLineDensityPair(),
    },
    {
      defaultStrategy: "resample",
      description:
        "A sparse direct route becomes a long zig-zag corridor, making resampled intermediate vertices visible.",
      geometryType: "LineString",
      id: "line-zigzag-growth",
      label: "LineString: zig-zag growth",
      pair: createDemoZigZagLinePair(),
    },
    {
      defaultStrategy: "resample",
      description: "Two branch lines stay as two parts, but each branch bends and changes length.",
      geometryType: "MultiLineString",
      id: "multiline-branches",
      label: "MultiLineString: branches",
      pair: createDemoInterpolationGeometryPair("MultiLineString"),
    },
    {
      defaultStrategy: "resample",
      description:
        "The end keyframe drops one branch, so multipart line interpolation falls back because part counts differ.",
      geometryType: "MultiLineString",
      id: "multiline-missing-branch",
      label: "MultiLineString: missing branch",
      pair: createDemoMultiLineMissingBranchPair(),
    },
    {
      defaultStrategy: "compatible",
      description:
        "Three points move one-for-one. Compatible interpolation is enough when counts match.",
      geometryType: "MultiPoint",
      id: "multipoint-compatible",
      label: "MultiPoint: compatible",
      pair: createDemoInterpolationGeometryPair("MultiPoint"),
    },
    {
      defaultStrategy: "compatible",
      description:
        "The next MultiPoint has fewer points, so compatible mode demonstrates the hold fallback.",
      geometryType: "MultiPoint",
      id: "multipoint-count-mismatch",
      label: "MultiPoint: count mismatch",
      pair: createDemoMultiPointMismatchPair(),
    },
    {
      defaultStrategy: "resample",
      description:
        "A point follows the simplest possible geometry interpolation path between two coordinates.",
      geometryType: "Point",
      id: "point-simple",
      label: "Point: simple",
      pair: createDemoInterpolationGeometryPair("Point"),
    },
    {
      defaultStrategy: "hold",
      description:
        "The geometry type changes from Polygon to MultiPolygon, so interpolation falls back to holding the previous keyframe.",
      geometryType: "Polygon",
      id: "type-change-fallback",
      label: "Type change: Polygon to MultiPolygon",
      pair: {
        end: createDemoInterpolationGeometryPair("MultiPolygon").end,
        start: createDemoInterpolationGeometryPair("Polygon").start,
      },
    },
    {
      defaultStrategy: "hold",
      description:
        "The geometry type changes from LineString to MultiLineString, exercising the fallback path for incompatible line primitives.",
      geometryType: "LineString",
      id: "line-to-multiline-fallback",
      label: "Type change: LineString to MultiLineString",
      pair: {
        end: createDemoInterpolationGeometryPair("MultiLineString").end,
        start: createDemoInterpolationGeometryPair("LineString").start,
      },
    },
    {
      description:
        "One service region separates into three district polygons using collection-level topology fragments.",
      endCollection: createDemoTopologySplitCollection("end"),
      geometryType: "Polygon",
      id: "topology-polygon-split",
      kind: "topology",
      label: "Topology: polygon split",
      startCollection: createDemoTopologySplitCollection("start"),
    },
    {
      description:
        "Three district polygons consolidate into one service region using collection-level topology fragments.",
      endCollection: createDemoTopologyMergeCollection("end"),
      geometryType: "Polygon",
      id: "topology-polygon-merge",
      kind: "topology",
      label: "Topology: polygon merge",
      startCollection: createDemoTopologyMergeCollection("start"),
    },
    {
      description:
        "Two partially overlapping source and target regions show preserved, appearing, disappearing, and ambiguous area fragments.",
      endCollection: createDemoTopologyMixedOverlapCollection("end"),
      geometryType: "Polygon",
      id: "topology-mixed-overlap",
      kind: "topology",
      label: "Topology: mixed overlap",
      startCollection: createDemoTopologyMixedOverlapCollection("start"),
    },
  ];
}

function createDemoTopologySplitCollection(
  keyframe: DemoInterpolationKeyframeId,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  if (keyframe === "start") {
    return {
      features: [
        demoTopologyFeature("topology-source", "Service region", {
          coordinates: [
            [
              [-7.0, 43.5],
              [6.2, 43.8],
              [6.7, 49.0],
              [-6.4, 49.4],
              [-7.0, 43.5],
            ],
          ],
          type: "Polygon",
        }),
      ],
      type: "FeatureCollection",
    };
  }

  return {
    features: [
      demoTopologyFeature("topology-west", "West district", {
        coordinates: [
          [
            [-5.8, 44.4],
            [-1.3, 44.1],
            [-1.1, 50.0],
            [-6.0, 49.5],
            [-5.8, 44.4],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-central", "Central district", {
        coordinates: [
          [
            [-1.0, 44.0],
            [3.2, 44.5],
            [3.0, 50.2],
            [-0.8, 49.8],
            [-1.0, 44.0],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-east", "East district", {
        coordinates: [
          [
            [3.4, 44.4],
            [8.1, 44.8],
            [7.5, 50.3],
            [3.2, 49.9],
            [3.4, 44.4],
          ],
        ],
        type: "Polygon",
      }),
    ],
    type: "FeatureCollection",
  };
}

function createDemoTopologyMergeCollection(
  keyframe: DemoInterpolationKeyframeId,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  if (keyframe === "end") {
    return {
      features: [
        demoTopologyFeature("topology-target", "Merged service region", {
          coordinates: [
            [
              [-5.6, 44.4],
              [8.2, 44.8],
              [7.4, 50.3],
              [-5.1, 49.8],
              [-5.6, 44.4],
            ],
          ],
          type: "Polygon",
        }),
      ],
      type: "FeatureCollection",
    };
  }

  return {
    features: [
      demoTopologyFeature("topology-west", "West district", {
        coordinates: [
          [
            [-7.2, 43.3],
            [-2.5, 43.6],
            [-2.2, 48.8],
            [-6.8, 49.0],
            [-7.2, 43.3],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-central", "Central district", {
        coordinates: [
          [
            [-2.1, 43.6],
            [2.3, 43.4],
            [2.6, 49.0],
            [-1.8, 48.9],
            [-2.1, 43.6],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-east", "East district", {
        coordinates: [
          [
            [2.8, 43.7],
            [6.7, 43.5],
            [6.9, 49.2],
            [3.0, 49.0],
            [2.8, 43.7],
          ],
        ],
        type: "Polygon",
      }),
    ],
    type: "FeatureCollection",
  };
}

function createDemoTopologyMixedOverlapCollection(
  keyframe: DemoInterpolationKeyframeId,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties> {
  if (keyframe === "start") {
    return {
      features: [
        demoTopologyFeature("topology-northwest", "Northwest area", {
          coordinates: [
            [
              [-6.8, 44.1],
              [-1.0, 44.3],
              [-1.3, 49.2],
              [-6.4, 49.0],
              [-6.8, 44.1],
            ],
          ],
          type: "Polygon",
        }),
        demoTopologyFeature("topology-southeast", "Southeast area", {
          coordinates: [
            [
              [0.5, 43.7],
              [5.8, 43.9],
              [5.4, 48.8],
              [0.2, 48.5],
              [0.5, 43.7],
            ],
          ],
          type: "Polygon",
        }),
      ],
      type: "FeatureCollection",
    };
  }

  return {
    features: [
      demoTopologyFeature("topology-west-shift", "Shifted west area", {
        coordinates: [
          [
            [-5.4, 44.8],
            [0.1, 44.5],
            [0.0, 49.9],
            [-5.8, 49.6],
            [-5.4, 44.8],
          ],
        ],
        type: "Polygon",
      }),
      demoTopologyFeature("topology-east-new", "New east area", {
        coordinates: [
          [
            [3.4, 44.2],
            [8.4, 44.8],
            [7.7, 50.0],
            [3.1, 49.3],
            [3.4, 44.2],
          ],
        ],
        type: "Polygon",
      }),
    ],
    type: "FeatureCollection",
  };
}

function demoTopologyFeature(
  id: string,
  label: string,
  geometry: TemporalGeoJsonSupportedGeometry,
): TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>["features"][number] {
  return {
    geometry,
    id,
    properties: {
      kind: "topology-area",
      label,
      time: 0,
      trackId: id,
    },
    type: "Feature",
  };
}

function createDemoInterpolationGeometryPair(
  geometryType: DemoInterpolationGeometryType,
): DemoInterpolationGeometryPair {
  switch (geometryType) {
    case "Point":
      return {
        end: { coordinates: [10.2, 52.0], type: "Point" },
        start: { coordinates: [2.35, 48.85], type: "Point" },
      };
    case "MultiPoint":
      return {
        end: {
          coordinates: [
            [4.9, 52.36],
            [12.56, 55.67],
            [18.06, 59.32],
          ],
          type: "MultiPoint",
        },
        start: {
          coordinates: [
            [-9.13, 38.72],
            [-3.7, 40.41],
            [2.16, 41.38],
          ],
          type: "MultiPoint",
        },
      };
    case "LineString":
      return {
        end: {
          coordinates: [
            [2.35, 48.85],
            [6.96, 50.93],
            [9.99, 53.55],
            [18.06, 59.32],
          ],
          type: "LineString",
        },
        start: {
          coordinates: [
            [-3.7, 40.41],
            [2.16, 41.38],
            [7.58, 47.55],
            [11.58, 48.13],
          ],
          type: "LineString",
        },
      };
    case "MultiLineString":
      return {
        end: {
          coordinates: [
            [
              [4.9, 52.36],
              [9.99, 53.55],
              [12.56, 55.67],
            ],
            [
              [14.43, 50.07],
              [21.01, 52.22],
              [25.27, 54.68],
            ],
          ],
          type: "MultiLineString",
        },
        start: {
          coordinates: [
            [
              [-9.13, 38.72],
              [-3.7, 40.41],
              [2.16, 41.38],
            ],
            [
              [7.58, 47.55],
              [11.58, 48.13],
              [16.37, 48.2],
            ],
          ],
          type: "MultiLineString",
        },
      };
    case "Polygon":
      return {
        end: {
          coordinates: [
            [
              [5.8, 45.4],
              [13.0, 45.7],
              [12.5, 49.0],
              [6.1, 48.8],
              [5.8, 45.4],
            ],
          ],
          type: "Polygon",
        },
        start: {
          coordinates: [
            [
              [6.4, 45.6],
              [12.2, 45.6],
              [12.2, 48.6],
              [6.4, 48.6],
              [6.4, 45.6],
            ],
          ],
          type: "Polygon",
        },
      };
    case "MultiPolygon":
      return {
        end: {
          coordinates: [
            [
              [
                [-8.8, 37.2],
                [-2.5, 38.1],
                [-2.8, 41.6],
                [-8.7, 40.9],
                [-8.8, 37.2],
              ],
            ],
            [
              [
                [0.0, 40.0],
                [3.6, 40.5],
                [3.3, 43.2],
                [0.2, 42.7],
                [0.0, 40.0],
              ],
            ],
          ],
          type: "MultiPolygon",
        },
        start: {
          coordinates: [
            [
              [
                [-9.6, 37.4],
                [-3.0, 37.7],
                [-3.3, 41.2],
                [-9.4, 41.0],
                [-9.6, 37.4],
              ],
            ],
            [
              [
                [-1.2, 40.1],
                [3.0, 40.1],
                [2.7, 42.8],
                [-0.8, 42.6],
                [-1.2, 40.1],
              ],
            ],
          ],
          type: "MultiPolygon",
        },
      };
  }
}

function createDemoMultiPolygonHolePair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [
            [-9.0, 37.1],
            [-2.4, 37.9],
            [-2.8, 41.8],
            [-8.8, 41.0],
            [-9.0, 37.1],
          ],
          [
            [-6.8, 38.7],
            [-5.3, 38.9],
            [-5.4, 39.8],
            [-6.7, 39.6],
            [-6.8, 38.7],
          ],
        ],
        [
          [
            [0.1, 40.0],
            [3.7, 40.4],
            [3.3, 43.3],
            [0.0, 42.8],
            [0.1, 40.0],
          ],
        ],
      ],
      type: "MultiPolygon",
    },
    start: {
      coordinates: [
        [
          [
            [-9.6, 37.4],
            [-3.0, 37.6],
            [-3.3, 41.3],
            [-9.4, 41.0],
            [-9.6, 37.4],
          ],
          [
            [-7.2, 38.4],
            [-5.9, 38.6],
            [-6.0, 39.5],
            [-7.0, 39.3],
            [-7.2, 38.4],
          ],
        ],
        [
          [
            [-1.2, 40.1],
            [3.0, 40.1],
            [2.7, 42.8],
            [-0.8, 42.6],
            [-1.2, 40.1],
          ],
        ],
      ],
      type: "MultiPolygon",
    },
  };
}

function createDemoConcavePolygonPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [5.6, 45.3],
          [9.2, 45.7],
          [12.8, 45.4],
          [11.1, 47.2],
          [13.0, 49.2],
          [9.0, 48.4],
          [6.0, 49.1],
          [7.1, 47.0],
          [5.6, 45.3],
        ],
      ],
      type: "Polygon",
    },
    start: createDemoInterpolationGeometryPair("Polygon").start,
  };
}

function createDemoReversedRingPolygonPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [6.2, 48.9],
          [13.3, 48.5],
          [12.4, 45.1],
          [5.9, 45.6],
          [6.2, 48.9],
        ],
      ],
      type: "Polygon",
    },
    start: createDemoInterpolationGeometryPair("Polygon").start,
  };
}

function createDemoPolygonHoleAppearsPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [5.6, 45.3],
          [13.4, 45.4],
          [13.1, 49.4],
          [5.9, 49.0],
          [5.6, 45.3],
        ],
        [
          [8.4, 46.7],
          [10.8, 46.8],
          [10.6, 48.0],
          [8.7, 47.9],
          [8.4, 46.7],
        ],
      ],
      type: "Polygon",
    },
    start: {
      coordinates: [
        [
          [6.4, 45.6],
          [12.2, 45.6],
          [12.2, 48.6],
          [6.4, 48.6],
          [6.4, 45.6],
        ],
      ],
      type: "Polygon",
    },
  };
}

function createDemoSliverPolygonPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [4.8, 44.9],
          [13.5, 45.8],
          [14.0, 49.5],
          [8.8, 48.7],
          [5.2, 50.2],
          [4.8, 44.9],
        ],
      ],
      type: "Polygon",
    },
    start: {
      coordinates: [
        [
          [6.8, 45.1],
          [12.8, 45.4],
          [12.2, 46.0],
          [6.6, 45.6],
          [6.8, 45.1],
        ],
      ],
      type: "Polygon",
    },
  };
}

function createDemoLineDensityPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [2.35, 48.85],
        [3.75, 49.35],
        [6.96, 50.93],
        [9.99, 53.55],
        [12.56, 55.67],
        [18.06, 59.32],
      ],
      type: "LineString",
    },
    start: {
      coordinates: [
        [-3.7, 40.41],
        [2.16, 41.38],
        [7.58, 47.55],
      ],
      type: "LineString",
    },
  };
}

function createDemoZigZagLinePair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [-8.9, 39.0],
        [-5.2, 43.2],
        [-1.4, 40.6],
        [2.4, 45.2],
        [6.8, 42.4],
        [11.8, 48.8],
      ],
      type: "LineString",
    },
    start: {
      coordinates: [
        [-8.9, 39.0],
        [2.0, 42.0],
        [11.8, 48.8],
      ],
      type: "LineString",
    },
  };
}

function createDemoMultiLineMissingBranchPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [
          [4.9, 52.36],
          [9.99, 53.55],
          [12.56, 55.67],
          [18.06, 59.32],
        ],
      ],
      type: "MultiLineString",
    },
    start: createDemoInterpolationGeometryPair("MultiLineString").start,
  };
}

function createDemoMultiPointMismatchPair(): DemoInterpolationGeometryPair {
  return {
    end: {
      coordinates: [
        [4.9, 52.36],
        [12.56, 55.67],
      ],
      type: "MultiPoint",
    },
    start: createDemoInterpolationGeometryPair("MultiPoint").start,
  };
}
