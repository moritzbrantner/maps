import { describe, expect, test } from "vitest";

import type { AggregatedMapFeature } from "./aggregation";
import {
  assignClusterAreaColors,
  createClusterAreaSubjects,
  getClusterAreaId,
} from "./cluster-area-visuals";

describe("@moritzbrantner/maps cluster area visuals", () => {
  test("treats singular points as cluster area subjects", () => {
    const features: AggregatedMapFeature[] = [
      {
        kind: "cluster",
        clusterId: 7,
        coordinates: [13.41, 52.52],
        expansionZoom: 9,
        metrics: {},
        pointCount: 3,
        pointCountAbbreviated: "3",
      },
      {
        kind: "point",
        coordinates: [13.43, 52.51],
        metrics: {},
        point: {
          id: "point-1",
          label: "Point 1",
          latitude: 52.51,
          longitude: 13.43,
          metrics: {},
          properties: {},
        },
      },
    ];
    const subjects = createClusterAreaSubjects(features, {
      getClusterLeaves() {
        return [
          {
            id: "leaf-1",
            label: "Leaf 1",
            latitude: 52.5204,
            longitude: 13.4098,
            metrics: {},
            properties: {},
          },
          {
            id: "leaf-2",
            label: "Leaf 2",
            latitude: 52.5198,
            longitude: 13.4111,
            metrics: {},
            properties: {},
          },
        ];
      },
    });

    expect(subjects).toHaveLength(2);
    expect(subjects[0]).toMatchObject({
      areaId: "cluster:7",
      pointCount: 3,
    });
    expect(subjects[0]!.sampleCoordinates).toContainEqual([13.41, 52.52]);
    expect(subjects[1]).toEqual({
      areaId: "point:point-1",
      coordinates: [13.43, 52.51],
      pointCount: 1,
      sampleCoordinates: [[13.43, 52.51]],
    });
    expect(getClusterAreaId(features[1]!)).toBe("point:point-1");
  });

  test("uses four colors when the adjacency graph can be colored with four", () => {
    const colors = assignClusterAreaColors(
      ["a", "b", "c", "d", "e"],
      [
        { clusterIds: ["a", "b"] },
        { clusterIds: ["b", "c"] },
        { clusterIds: ["c", "d"] },
        { clusterIds: ["d", "a"] },
        { clusterIds: ["a", "e"] },
        { clusterIds: ["b", "e"] },
      ],
    );
    const distinctColors = new Set(colors.values());

    expect(distinctColors.size).toBeLessThanOrEqual(4);
    expect(colors.get("a")).not.toBe(colors.get("b"));
    expect(colors.get("b")).not.toBe(colors.get("c"));
    expect(colors.get("c")).not.toBe(colors.get("d"));
    expect(colors.get("d")).not.toBe(colors.get("a"));
    expect(colors.get("a")).not.toBe(colors.get("e"));
    expect(colors.get("b")).not.toBe(colors.get("e"));
  });

  test("falls back to more colors when exact four-coloring is skipped", () => {
    const nodeIds = ["a", "b", "c", "d", "e"];
    const colors = assignClusterAreaColors(
      nodeIds,
      [
        { clusterIds: ["a", "b"] },
        { clusterIds: ["a", "c"] },
        { clusterIds: ["a", "d"] },
        { clusterIds: ["a", "e"] },
        { clusterIds: ["b", "c"] },
        { clusterIds: ["b", "d"] },
        { clusterIds: ["b", "e"] },
        { clusterIds: ["c", "d"] },
        { clusterIds: ["c", "e"] },
        { clusterIds: ["d", "e"] },
      ],
      { maxExactColoringNodes: 0 },
    );

    expect(new Set(colors.values()).size).toBe(5);
    for (const leftId of nodeIds) {
      for (const rightId of nodeIds) {
        if (leftId === rightId) {
          continue;
        }

        expect(colors.get(leftId)).not.toBe(colors.get(rightId));
      }
    }
  });
});
