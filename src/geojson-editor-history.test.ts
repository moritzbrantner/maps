import { describe, expect, test } from "vitest";

import {
  createGeoJsonEditHistoryState,
  invertGeoJsonEditOperation,
  pushGeoJsonEditHistory,
  redoGeoJsonEditHistory,
  undoGeoJsonEditHistory,
  type GeoJsonEditOperation,
} from ".";
import type { TemporalGeoJsonGeometryFeatureCollection } from "./temporal-geojson-types";

const emptyCollection: TemporalGeoJsonGeometryFeatureCollection = {
  features: [],
  type: "FeatureCollection",
};

const pointFeature = {
  geometry: {
    coordinates: [13, 52] as [number, number],
    type: "Point" as const,
  },
  id: "point-1",
  properties: {},
  type: "Feature" as const,
};

const movedPointFeature = {
  ...pointFeature,
  geometry: {
    coordinates: [14, 53] as [number, number],
    type: "Point" as const,
  },
};

describe("GeoJSON editor history helpers", () => {
  test("pushes, undoes, and redoes create operations", () => {
    const after: TemporalGeoJsonGeometryFeatureCollection = {
      features: [pointFeature],
      type: "FeatureCollection",
    };
    const operation: GeoJsonEditOperation = {
      feature: pointFeature,
      featureId: "point-1",
      type: "create",
    };
    const initial = createGeoJsonEditHistoryState(emptyCollection);
    const pushed = pushGeoJsonEditHistory(initial, {
      after,
      before: emptyCollection,
      operation,
    });

    expect(pushed.canUndo).toBe(true);
    expect(pushed.canRedo).toBe(false);
    expect(pushed.present.features).toHaveLength(1);

    const undone = undoGeoJsonEditHistory(pushed);

    expect(undone.canUndo).toBe(false);
    expect(undone.canRedo).toBe(true);
    expect(undone.present.features).toHaveLength(0);

    const redone = redoGeoJsonEditHistory(undone);

    expect(redone.canUndo).toBe(true);
    expect(redone.canRedo).toBe(false);
    expect(redone.present.features).toHaveLength(1);
  });

  test("inverts update, delete, and batch operations", () => {
    const updateOperation: GeoJsonEditOperation = {
      feature: movedPointFeature,
      featureId: "point-1",
      previousFeature: pointFeature,
      reason: "move-feature",
      type: "update",
    };
    const deleteOperation: GeoJsonEditOperation = {
      featureId: "point-1",
      previousFeature: pointFeature,
      type: "delete",
    };
    const batchOperation: GeoJsonEditOperation = {
      operations: [updateOperation, deleteOperation],
      reason: "delete-selection",
      type: "batch",
    };

    expect(invertGeoJsonEditOperation(updateOperation)).toMatchObject({
      feature: pointFeature,
      previousFeature: movedPointFeature,
      type: "update",
    });
    expect(invertGeoJsonEditOperation(deleteOperation)).toMatchObject({
      feature: pointFeature,
      type: "create",
    });
    expect(invertGeoJsonEditOperation(batchOperation)).toMatchObject({
      operations: [
        expect.objectContaining({ type: "create" }),
        expect.objectContaining({ type: "update" }),
      ],
      type: "batch",
    });
  });

  test("clears redo stack after push and enforces history limit", () => {
    const after: TemporalGeoJsonGeometryFeatureCollection = {
      features: [pointFeature],
      type: "FeatureCollection",
    };
    const operation: GeoJsonEditOperation = {
      feature: pointFeature,
      featureId: "point-1",
      type: "create",
    };
    const firstPush = pushGeoJsonEditHistory(createGeoJsonEditHistoryState(emptyCollection), {
      after,
      before: emptyCollection,
      operation,
    });
    const undone = undoGeoJsonEditHistory(firstPush);
    const pushedAgain = pushGeoJsonEditHistory(undone, {
      after,
      before: emptyCollection,
      operation,
    }, { limit: 1 });

    expect(pushedAgain.canRedo).toBe(false);
    expect(pushedAgain.past).toHaveLength(1);
  });
});
