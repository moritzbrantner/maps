import { describe, expect, test } from "vitest";

import {
  clipRingToPolygon,
  createClusterAreaRing,
  createProjectedClusterVoronoiGeometry,
  createClusterVoronoiBoundarySegments,
  createClusterVoronoiCells,
} from "./cluster-area";

describe("@moritzbrantner/maps cluster area", () => {
  test("creates a closed hull ring around a spread of points", () => {
    const ring = createClusterAreaRing(
      [
        [-73.99, 40.71],
        [-73.95, 40.73],
        [-74.02, 40.72],
        [-73.98, 40.76],
      ],
      [-73.985, 40.73],
    );

    expect(ring).not.toBeNull();
    expect(ring!.length).toBeGreaterThanOrEqual(4);
    expect(ring![0]).toEqual(ring!.at(-1));
  });

  test("falls back to a closed area for degenerate point sets", () => {
    const ring = createClusterAreaRing(
      [
        [13.405, 52.52],
        [13.405, 52.52],
      ],
      [13.405, 52.52],
    );

    expect(ring).not.toBeNull();
    expect(ring!.length).toBeGreaterThan(4);
    expect(ring![0]).toEqual(ring!.at(-1));
  });

  test("falls back to clipping neighboring cluster areas at the midpoint between centers", () => {
    const cells = createClusterVoronoiCells(
      [
        { clusterId: 1, coordinates: [-1, 0] },
        { clusterId: 2, coordinates: [1, 0] },
      ],
      [-4, -4, 4, 4],
    );
    const leftCell = cells.get(1);
    const clipped = clipRingToPolygon(
      [
        [-3, -2],
        [0.9, -2],
        [0.9, 2],
        [-3, 2],
        [-3, -2],
      ],
      leftCell!,
    );

    expect(leftCell).toBeTruthy();
    expect(clipped).toBeTruthy();
    expect(Math.max(...clipped!.map((point) => point[0]))).toBeLessThanOrEqual(0.001);
    expect(clipped![0]).toEqual(clipped!.at(-1));
  });

  test("dissolves same-cluster cells into one merged region", () => {
    const geometry = createProjectedClusterVoronoiGeometry(
      [
        { clusterId: 1, coordinates: [-2, 0] },
        { clusterId: 1, coordinates: [0, 0] },
        { clusterId: 2, coordinates: [2, 0] },
      ],
      {
        includeOuterEdges: false,
        project(coordinate) {
          return [coordinate[0], -coordinate[1]];
        },
        unproject(coordinate) {
          return [coordinate[0], -coordinate[1]];
        },
        viewportBounds: [-4, -4, 4, 4],
      },
    );

    const leftRegion = geometry.regions.find((region) => region.clusterId === 1);

    expect(geometry.regions).toHaveLength(2);
    expect(leftRegion).toBeTruthy();

    if (!leftRegion) {
      throw new Error("Expected a dissolved region for cluster 1");
    }

    expect(leftRegion.polygons).toHaveLength(1);
    expect(Math.max(...leftRegion.polygons[0]![0]!.map((point) => point[0]))).toBeLessThanOrEqual(
      1.001,
    );
    expect(leftRegion.polygons[0]![0]![0]).toEqual(leftRegion.polygons[0]![0]!.at(-1));
  });

  test("renders only dissolved boundaries between different cluster ids", () => {
    const segments = createClusterVoronoiBoundarySegments(
      [
        { clusterId: 1, coordinates: [-2, 0] },
        { clusterId: 1, coordinates: [0, 0] },
        { clusterId: 2, coordinates: [2, 0] },
      ],
      [-4, -4, 4, 4],
      { includeOuterEdges: false },
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]!.clusterIds).toEqual([1, 2]);
    expect(segments[0]!.coordinates.every((point) => Math.abs(point[0] - 1) <= 1e-6)).toBe(true);
  });

  test("does not leak same-cluster shared edges into rendered boundaries", () => {
    const geometry = createProjectedClusterVoronoiGeometry(
      [
        { clusterId: 1, coordinates: [-2, 0] },
        { clusterId: 1, coordinates: [0, 0] },
        { clusterId: 2, coordinates: [2, 0] },
      ],
      {
        includeOuterEdges: true,
        project(coordinate) {
          return [coordinate[0], -coordinate[1]];
        },
        unproject(coordinate) {
          return [coordinate[0], -coordinate[1]];
        },
        viewportBounds: [-4, -4, 4, 4],
      },
    );

    expect(
      geometry.boundarySegments.some(
        (segment) =>
          segment.clusterIds[0] === 1 &&
          segment.clusterIds[1] === null &&
          segment.coordinates.every((point) => Math.abs(point[0] + 1) <= 1e-6),
      ),
    ).toBe(false);
    expect(
      geometry.boundarySegments.some(
        (segment) =>
          segment.clusterIds[0] === 1 &&
          segment.clusterIds[1] === 2 &&
          segment.coordinates.every((point) => Math.abs(point[0] - 1) <= 1e-6),
      ),
    ).toBe(true);
  });

  test("deduplicates and stitches shared Voronoi edges", () => {
    const segments = createClusterVoronoiBoundarySegments(
      [
        { clusterId: "left", coordinates: [-1, 0] },
        { clusterId: "right", coordinates: [1, 0] },
      ],
      [-4, -4, 4, 4],
      { includeOuterEdges: false },
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]!.clusterIds).toEqual(["left", "right"]);
    expect(segments[0]!.coordinates.every((point) => Math.abs(point[0]) <= 1e-6)).toBe(true);
    expect(segments[0]!.coordinates[0]).not.toEqual(segments[0]!.coordinates.at(-1));
  });
});
