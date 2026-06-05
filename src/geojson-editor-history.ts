"use client";

import { cloneFeature } from "./geojson-editor-operations";
import type {
  GeoJsonEditOperation,
  GeoJsonEditorSelection,
} from "./geojson-editor";
import type {
  TemporalGeoJsonGeometryFeatureCollection,
} from "./temporal-geojson-types";

const DEFAULT_GEOJSON_EDIT_HISTORY_LIMIT = 100;

export type GeoJsonEditHistoryEntry<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  after: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  before: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  operation: GeoJsonEditOperation<TProperties>;
  selectionAfter?: GeoJsonEditorSelection;
  selectionBefore?: GeoJsonEditorSelection;
};

export type GeoJsonEditHistoryState<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  canRedo: boolean;
  canUndo: boolean;
  future: Array<GeoJsonEditHistoryEntry<TProperties>>;
  past: Array<GeoJsonEditHistoryEntry<TProperties>>;
  present: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
};

export function createGeoJsonEditHistoryState<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  initial: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
): GeoJsonEditHistoryState<TProperties> {
  return createHistoryState({
    future: [],
    past: [],
    present: cloneFeatureCollection(initial),
  });
}

export function pushGeoJsonEditHistory<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  state: GeoJsonEditHistoryState<TProperties>,
  entry: GeoJsonEditHistoryEntry<TProperties>,
  options: { limit?: number } = {},
): GeoJsonEditHistoryState<TProperties> {
  const limit = Math.max(0, options.limit ?? DEFAULT_GEOJSON_EDIT_HISTORY_LIMIT);
  const nextPast = [
    ...state.past,
    cloneHistoryEntry(entry),
  ].slice(Math.max(0, state.past.length + 1 - limit));

  return createHistoryState({
    future: [],
    past: nextPast,
    present: cloneFeatureCollection(entry.after),
  });
}

export function undoGeoJsonEditHistory<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  state: GeoJsonEditHistoryState<TProperties>,
): GeoJsonEditHistoryState<TProperties> {
  const entry = state.past.at(-1);

  if (!entry) {
    return state;
  }

  return createHistoryState({
    future: [cloneHistoryEntry(entry), ...state.future.map(cloneHistoryEntry)],
    past: state.past.slice(0, -1).map(cloneHistoryEntry),
    present: cloneFeatureCollection(entry.before),
  });
}

export function redoGeoJsonEditHistory<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  state: GeoJsonEditHistoryState<TProperties>,
): GeoJsonEditHistoryState<TProperties> {
  const entry = state.future[0];

  if (!entry) {
    return state;
  }

  return createHistoryState({
    future: state.future.slice(1).map(cloneHistoryEntry),
    past: [...state.past.map(cloneHistoryEntry), cloneHistoryEntry(entry)],
    present: cloneFeatureCollection(entry.after),
  });
}

export function invertGeoJsonEditOperation<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  operation: GeoJsonEditOperation<TProperties>,
): GeoJsonEditOperation<TProperties> {
  if (operation.type === "create") {
    return {
      featureId: operation.featureId,
      previousFeature: cloneFeature(operation.feature),
      type: "delete",
    };
  }

  if (operation.type === "delete") {
    return {
      feature: cloneFeature(operation.previousFeature),
      featureId: operation.featureId,
      type: "create",
    };
  }

  if (operation.type === "batch") {
    return {
      operations: operation.operations.map(invertGeoJsonEditOperation).reverse(),
      reason: operation.reason,
      type: "batch",
    };
  }

  return {
    feature: cloneFeature(operation.previousFeature),
    featureId: operation.featureId,
    previousFeature: cloneFeature(operation.feature),
    reason: operation.reason,
    type: "update",
  };
}

function createHistoryState<TProperties extends Record<string, unknown>>({
  future,
  past,
  present,
}: {
  future: Array<GeoJsonEditHistoryEntry<TProperties>>;
  past: Array<GeoJsonEditHistoryEntry<TProperties>>;
  present: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
}): GeoJsonEditHistoryState<TProperties> {
  return {
    canRedo: future.length > 0,
    canUndo: past.length > 0,
    future,
    past,
    present,
  };
}

function cloneHistoryEntry<TProperties extends Record<string, unknown>>(
  entry: GeoJsonEditHistoryEntry<TProperties>,
): GeoJsonEditHistoryEntry<TProperties> {
  return {
    after: cloneFeatureCollection(entry.after),
    before: cloneFeatureCollection(entry.before),
    operation: cloneEditOperation(entry.operation),
    selectionAfter: entry.selectionAfter ? cloneSelection(entry.selectionAfter) : undefined,
    selectionBefore: entry.selectionBefore ? cloneSelection(entry.selectionBefore) : undefined,
  };
}

function cloneEditOperation<TProperties extends Record<string, unknown>>(
  operation: GeoJsonEditOperation<TProperties>,
): GeoJsonEditOperation<TProperties> {
  return invertGeoJsonEditOperation(invertGeoJsonEditOperation(operation));
}

function cloneFeatureCollection<TProperties extends Record<string, unknown>>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  return {
    ...collection,
    features: collection.features.map(cloneFeature),
  };
}

function cloneSelection(selection: GeoJsonEditorSelection): GeoJsonEditorSelection {
  return {
    featureIds: [...selection.featureIds],
    primaryFeatureId: selection.primaryFeatureId,
    vertexHandle: selection.vertexHandle
      ? {
          ...selection.vertexHandle,
          coordinates: [...selection.vertexHandle.coordinates],
        }
      : selection.vertexHandle,
  };
}
