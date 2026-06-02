"use client";

import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import { getBoundsFromGeoJson, type GeoJsonMapSource } from "./geojson-source";
import { type GeoJsonLayerStyle } from "./geojson-layer";
import {
  createFlatGeometryLayers,
  type FlatGeometryLayer,
  type FlatFeaturePointerEvent,
} from "./geojson-rendering";
import {
  defaultRasterMapStyle,
  joinClassNames,
  toLatLng,
  type GlobeBasemapMode,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import type { FlatLayerFactory, FlatLayerGroup, FlatMapAdapter } from "./maplibre-compat";
import type { MapContextMenuContext } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";
import { clonePosition, closeRing, normalizeSupportedGeometry } from "./temporal-geojson-geometry";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";
import { MapView } from "./map-view";
import {
  GeoJsonTimelineEditor,
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineFeatureCollectionAtTime,
  type GeoJsonTimelineDocument,
} from "./geojson-timeline";
import type {
  TimelineEditorSelection,
  TimelineEditorSnapOptions,
  TimelineEditorViewport,
} from "@moritzbrantner/timeline-editor";
import {
  applyGeoJsonEditOperationWithResolver,
  arePositionsEqual,
  cloneFeature,
  createGeoJsonEditFeature,
  insertGeoJsonVertex,
  moveGeoJsonGeometry,
  removeClosingPosition,
  removeGeoJsonVertex,
  resolveFeatureId,
  setGeoJsonVertex,
  validateEditOperation,
  validateGeoJsonEditableGeometry,
} from "./geojson-editor-operations";

export {
  applyGeoJsonEditOperation,
  createGeoJsonEditFeature,
  insertGeoJsonVertex,
  moveGeoJsonGeometry,
  removeGeoJsonVertex,
  setGeoJsonVertex,
  validateGeoJsonEditableGeometry,
} from "./geojson-editor-operations";

export type GeoJsonEditMode =
  | "none"
  | "select"
  | "draw-point"
  | "draw-line"
  | "draw-polygon"
  | "move"
  | "reshape"
  | "delete";

export type GeoJsonEditReason =
  | "move-feature"
  | "move-vertex"
  | "insert-vertex"
  | "remove-vertex"
  | "group-feature"
  | "ungroup-feature"
  | "draw-complete";

export type GeoJsonBatchEditReason =
  | "delete-selection"
  | "duplicate-selection"
  | "group-selection"
  | "ungroup-selection"
  | "move-selection";

export type GeoJsonEditValidationResult = {
  reason?: string;
  valid: boolean;
};

export type GeoJsonVertexHandle = {
  coordinates: GeoJsonPosition;
  featureId: string;
  geometryIndex?: number;
  kind: "vertex" | "midpoint";
  nextVertexIndex?: number;
  ringIndex?: number;
  vertexIndex: number;
};

export type GeoJsonEditorSelection = {
  featureIds: string[];
  primaryFeatureId: string | null;
  vertexHandle?: GeoJsonVertexHandle | null;
};

export type GeoJsonEditorGroupOptions<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  groupId?: string;
  getGroupId?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    index: number,
  ) => string | null | undefined;
  setGroupId?: (
    feature: TemporalGeoJsonGeometryFeature<TProperties>,
    groupId: string | null,
  ) => TemporalGeoJsonGeometryFeature<TProperties>;
};

export type GeoJsonEditorCommand =
  | "select-all"
  | "clear-selection"
  | "delete-selection"
  | "duplicate-selection"
  | "group-selection"
  | "ungroup-selection"
  | "start-select"
  | "start-draw-point"
  | "start-draw-line"
  | "start-draw-polygon"
  | "start-move"
  | "start-reshape"
  | "finish-draft"
  | "cancel-draft"
  | "remove-selected-vertex";

export type GeoJsonEditOperation<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> =
  | {
      feature: TemporalGeoJsonGeometryFeature<TProperties>;
      featureId: string;
      type: "create";
    }
  | {
      feature: TemporalGeoJsonGeometryFeature<TProperties>;
      featureId: string;
      previousFeature: TemporalGeoJsonGeometryFeature<TProperties>;
      reason: GeoJsonEditReason;
      type: "update";
    }
  | {
      featureId: string;
      previousFeature: TemporalGeoJsonGeometryFeature<TProperties>;
      type: "delete";
    }
  | {
      operations: GeoJsonEditOperation<TProperties>[];
      reason: GeoJsonBatchEditReason;
      type: "batch";
    };

/**
 * Controlled GeoJSON editor layer contract.
 *
 * The layer emits the next feature collection plus an operation descriptor;
 * consumers own persistence, undo/redo, save/cancel flows, and any surrounding
 * toolbar UI.
 */
export type GeoJsonEditorLayerProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  canEditFeature?: (feature: TemporalGeoJsonGeometryFeature<TProperties>) => boolean;
  createFeatureProperties?: (geometryType: "Point" | "LineString" | "Polygon") => TProperties;
  enableKeyboardShortcuts?: boolean;
  featureCollection: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string;
  groupOptions?: GeoJsonEditorGroupOptions<TProperties>;
  handleColor?: string;
  keyboardShortcutScope?: HTMLElement | Document | null;
  layerId?: string;
  midpointHandleColor?: string;
  mode: GeoJsonEditMode;
  onCommand?: (
    command: GeoJsonEditorCommand,
    context: {
      mode: GeoJsonEditMode;
      selection: GeoJsonEditorSelection;
    },
  ) => boolean | void;
  onEditModeChange?: (mode: GeoJsonEditMode) => void;
  onEditorSelectionChange?: (selection: GeoJsonEditorSelection) => void;
  onFeatureCollectionChange?: (
    next: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
    operation: GeoJsonEditOperation<TProperties>,
  ) => void;
  onSelectionChange?: (featureId: string | null) => void;
  selectedFeatureIds?: readonly string[];
  selectedFeatureId?: string | null;
  selection?: GeoJsonEditorSelection;
  selectedStyle?: GeoJsonLayerStyle;
  style?: GeoJsonLayerStyle;
  validateEdit?: (
    nextFeature: TemporalGeoJsonGeometryFeature<TProperties>,
    operation: GeoJsonEditOperation<TProperties>,
  ) => GeoJsonEditValidationResult;
};

export type EditableGeoJsonMapProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = Omit<GeoJsonEditorLayerProps<TProperties>, "featureCollection" | "mode" | "style"> &
  MapMeasurementProps &
  MapViewportProps & {
    children?: React.ReactNode;
    className?: string;
    editMode: GeoJsonEditMode;
    editorStyle?: GeoJsonLayerStyle;
    fitBoundsPadding?: number;
    fitToData?: boolean;
    geoJson: GeoJsonMapSource<TProperties>;
    globeBasemapMode?: GlobeBasemapMode;
    initialViewState?: MapViewState;
    mapDisplay?: MapDisplayMode;
    mapLabel?: string;
    mapStyle?: string | RasterMapStyle;
    onMapControllerReady?: (controller: MapSurfaceController) => void;
    onMapContextMenu?: (context: MapContextMenuContext) => void;
    onMapReady?: (map: MapLibreMap) => void;
    renderMapContextMenu?: (context: MapContextMenuContext) => React.ReactNode;
    showAttributionControl?: boolean;
    style?: React.CSSProperties;
    showTimelineEditor?: boolean;
    timelineActiveTimeMs?: number;
    timelineClassName?: string;
    timelineDocument?: GeoJsonTimelineDocument<TProperties>;
    timelineDurationMs?: number;
    timelineFrameRate?: number;
    timelineReadOnly?: boolean;
    timelineSelection?: TimelineEditorSelection;
    timelineSnap?: Partial<TimelineEditorSnapOptions>;
    timelineViewport?: TimelineEditorViewport;
    onTimelineActiveTimeChange?: (timeMs: number) => void;
    onTimelineDocumentChange?: (document: GeoJsonTimelineDocument<TProperties>) => void;
    onTimelineSelectionChange?: (selection: TimelineEditorSelection) => void;
    onTimelineViewportChange?: (viewport: TimelineEditorViewport) => void;
  };

type EditableFeature<TProperties extends Record<string, unknown>> = {
  editable: boolean;
  feature: TemporalGeoJsonGeometryFeature<TProperties>;
  geometry: TemporalGeoJsonSupportedGeometry;
  id: string;
  index: number;
};

type DragState<TProperties extends Record<string, unknown>> =
  | {
      features: Array<EditableFeature<TProperties>>;
      from: GeoJsonPosition;
      type: "feature";
    }
  | {
      feature: EditableFeature<TProperties>;
      from: GeoJsonPosition;
      handle: GeoJsonVertexHandle;
      type: "vertex";
    };

const EDITOR_STYLE: Required<GeoJsonLayerStyle> = {
  lineColor: "#0f766e",
  lineOpacity: 0.88,
  lineWidth: 4,
  pointColor: "#0f766e",
  pointRadius: 7,
  polygonFillColor: "#14b8a6",
  polygonFillOpacity: 0.2,
  polygonStrokeColor: "#0f766e",
  polygonStrokeWidth: 2,
};

const SELECTED_EDITOR_STYLE: GeoJsonLayerStyle = {
  lineColor: "#0284c7",
  lineWidth: 5,
  pointColor: "#0284c7",
  polygonFillColor: "#38bdf8",
  polygonFillOpacity: 0.18,
  polygonStrokeColor: "#0284c7",
  polygonStrokeWidth: 3,
};

const EMPTY_EDITOR_SELECTION: GeoJsonEditorSelection = {
  featureIds: [],
  primaryFeatureId: null,
  vertexHandle: null,
};

export function GeoJsonEditorLayer<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  canEditFeature,
  createFeatureProperties,
  enableKeyboardShortcuts = false,
  featureCollection,
  getFeatureId,
  groupOptions,
  handleColor = "#ffffff",
  keyboardShortcutScope,
  layerId,
  midpointHandleColor = "#bae6fd",
  mode,
  onCommand,
  onEditModeChange,
  onEditorSelectionChange,
  onFeatureCollectionChange,
  onSelectionChange,
  selectedFeatureIds,
  selectedFeatureId,
  selection,
  selectedStyle,
  style,
  validateEdit,
}: GeoJsonEditorLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const surfaceDisplay = surface?.display;
  const flatMap = surface?.flatMap;
  const registerFlatLayer = surface?.registerFlatLayer;
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `geojson-editor-layer-${generatedLayerId}`;
  const [draft, setDraft] = useState<GeoJsonPosition[]>([]);
  const draftRef = useRef<GeoJsonPosition[]>([]);
  const draftPreviewRef = useRef<GeoJsonPosition | null>(null);
  const [selectedHandle, setSelectedHandle] = useState<GeoJsonVertexHandle | null>(null);
  const selectedHandleRef = useRef<GeoJsonVertexHandle | null>(null);
  const createCounterRef = useRef(0);
  const duplicateCounterRef = useRef(0);
  const groupCounterRef = useRef(0);
  const dragRef = useRef<DragState<TProperties> | null>(null);
  const latestRef = useRef({
    canEditFeature,
    createFeatureProperties,
    enableKeyboardShortcuts,
    featureCollection,
    getFeatureId,
    groupOptions,
    mode,
    onCommand,
    onEditModeChange,
    onEditorSelectionChange,
    onFeatureCollectionChange,
    onSelectionChange,
    resolvedSelection: EMPTY_EDITOR_SELECTION,
    selectedFeatureId,
    selectedFeatureIds,
    selection,
    validateEdit,
  });
  const features = useMemo(
    () => createEditableFeatures(featureCollection, getFeatureId, canEditFeature),
    [canEditFeature, featureCollection, getFeatureId],
  );
  const resolvedSelection = useMemo(
    () =>
      normalizeEditorSelection(
        features,
        selection,
        selectedFeatureIds,
        selectedFeatureId,
        selectedHandle,
      ),
    [features, selectedFeatureId, selectedFeatureIds, selectedHandle, selection],
  );
  const selectedFeatureIdSet = useMemo(
    () => new Set(resolvedSelection.featureIds),
    [resolvedSelection.featureIds],
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    selectedHandleRef.current = resolvedSelection.vertexHandle ?? null;
  }, [resolvedSelection]);

  useEffect(() => {
    latestRef.current = {
      canEditFeature,
      createFeatureProperties,
      enableKeyboardShortcuts,
      featureCollection,
      getFeatureId,
      groupOptions,
      mode,
      onCommand,
      onEditModeChange,
      onEditorSelectionChange,
      onFeatureCollectionChange,
      onSelectionChange,
      resolvedSelection,
      selectedFeatureId,
      selectedFeatureIds,
      selection,
      validateEdit,
    };
  }, [
    canEditFeature,
    createFeatureProperties,
    enableKeyboardShortcuts,
    featureCollection,
    getFeatureId,
    groupOptions,
    mode,
    onCommand,
    onEditModeChange,
    onEditorSelectionChange,
    onFeatureCollectionChange,
    onSelectionChange,
    resolvedSelection,
    selectedFeatureId,
    selectedFeatureIds,
    selection,
    validateEdit,
  ]);

  useEffect(() => {
    if (!surface || surface.display !== "flat" || mode === "none") {
      return;
    }

    return surface.registerInteractionMode(resolvedLayerId, "editing");
  }, [mode, resolvedLayerId, surface]);

  useEffect(() => {
    if (!surface || surface.display !== "flat" || !surface.flatMap) {
      return;
    }

    const map = surface.flatMap;

    function getCoordinate(event: FlatFeaturePointerEvent = {}) {
      return getEventCoordinate(map, event);
    }

    function handleClick(event: FlatFeaturePointerEvent = {}) {
      if (event.originalEvent?.defaultPrevented) {
        return;
      }

      const current = latestRef.current;
      const coordinates = getCoordinate(event);

      if (!coordinates) {
        return;
      }

      if (
        current.mode === "select" ||
        current.mode === "move" ||
        current.mode === "reshape" ||
        current.mode === "delete"
      ) {
        emitEditorSelection(EMPTY_EDITOR_SELECTION);
        updateSelectedHandle(null);
        return;
      }

      if (current.mode === "draw-point") {
        const feature = createGeoJsonEditFeature(
          "Point",
          coordinates,
          current.createFeatureProperties?.("Point") ?? ({} as TProperties),
        );

        emitOperation(ensureCreatedFeatureId(feature, createCounterRef), "create");
        return;
      }

      if (current.mode === "draw-line" || current.mode === "draw-polygon") {
        const nextDraft = [...draftRef.current, coordinates];

        updateDraft(nextDraft);
      }
    }

    function handleMouseMove(event: FlatFeaturePointerEvent = {}) {
      const current = latestRef.current;

      if (
        current.mode !== "draw-point" &&
        current.mode !== "draw-line" &&
        current.mode !== "draw-polygon"
      ) {
        updateDraftPreview(null);
        return;
      }

      updateDraftPreview(getCoordinate(event));
    }

    function handleMouseOut() {
      updateDraftPreview(null);
    }

    function handleDoubleClick(event: FlatFeaturePointerEvent = {}) {
      const current = latestRef.current;

      if (current.mode !== "draw-line" && current.mode !== "draw-polygon") {
        return;
      }

      event.originalEvent?.preventDefault?.();
      completeDraft();
    }

    map.on("click", handleClick as never);
    map.on("dblclick", handleDoubleClick as never);
    map.on("mousemove", handleMouseMove as never);
    map.on("mouseout", handleMouseOut as never);

    return () => {
      map.off("click", handleClick as never);
      map.off("dblclick", handleDoubleClick as never);
      map.off("mousemove", handleMouseMove as never);
      map.off("mouseout", handleMouseOut as never);
    };
  }, [surface]);

  useEffect(() => {
    if (!enableKeyboardShortcuts || !surface || surface.display !== "flat") {
      return;
    }

    const scope = keyboardShortcutScope ?? document;

    function handleKeyDown(event: KeyboardEvent) {
      const command = getGeoJsonEditorKeyboardCommand(event);

      if (!command || isKeyboardShortcutTargetEditable(event.target)) {
        return;
      }

      if (runGeoJsonEditorCommand(command)) {
        event.preventDefault();
      }
    }

    scope.addEventListener("keydown", handleKeyDown as EventListener);

    return () => {
      scope.removeEventListener("keydown", handleKeyDown as EventListener);
    };
  });

  useEffect(() => {
    if (mode !== "draw-line" && mode !== "draw-polygon") {
      updateDraft([]);
    }

    updateDraftPreview(null);
    updateSelectedHandle(null);
  }, [mode, selectedFeatureId]);

  useEffect(() => {
    if (!registerFlatLayer || surfaceDisplay !== "flat") {
      return;
    }

    return registerFlatLayer(
      resolvedLayerId,
      ({ layer, flat, map }) => {
        layer.clearLayers();

        if (mode === "none") {
          return;
        }

        for (const feature of features) {
          const selected = selectedFeatureIdSet.has(feature.id);
          const primarySelected = feature.id === resolvedSelection.primaryFeatureId;
          const groupId = getFeatureGroupId(feature, groupOptions);
          const groupSelected =
            selected &&
            groupId !== null &&
            features.some(
              (candidate) =>
                candidate.id !== feature.id &&
                selectedFeatureIdSet.has(candidate.id) &&
                getFeatureGroupId(candidate, groupOptions) === groupId,
            );
          const resolvedStyle = resolveEditorStyle(
            style,
            selected ? selectedStyle : undefined,
            selected,
          );
          const layers = createFlatGeometryLayers(feature.geometry, {
            className: joinClassNames(
              "mb-maps__editor-feature",
              Boolean(groupId) && "mb-maps__editor-feature--grouped",
              selected && "mb-maps__editor-feature--selected",
              groupSelected && "mb-maps__editor-feature--group-selected",
              selected && "mb-maps__feature--selected",
            ),
            bubblingMouseEvents: false,
            interactive: true,
            flat,
            selected,
            style: resolvedStyle,
          });

          for (const geometryLayer of layers) {
            bindFeatureLayer(geometryLayer, {
              feature,
              map,
              onDragStart: (event) => startFeatureDrag(feature, event, map),
              onGroupSelect: () => selectFeatureGroup(feature.id),
              onSelect: (event) => selectFeature(feature.id, event),
            });
            geometryLayer.addTo(layer);
          }

          if (mode === "reshape" && primarySelected && feature.editable) {
            renderVertexHandles(feature, {
              handleColor,
              layer,
              flat,
              map,
              midpointHandleColor,
            });
          }
        }

        renderDraft(layer, flat, draftRef.current, draftPreviewRef.current, mode);
      },
      { renderOnViewStateChange: false },
    );
  }, [
    features,
    flatMap,
    groupOptions,
    handleColor,
    midpointHandleColor,
    mode,
    resolvedLayerId,
    resolvedSelection,
    selectedFeatureIdSet,
    selectedStyle,
    style,
    registerFlatLayer,
    surfaceDisplay,
  ]);

  function completeDraft() {
    const current = latestRef.current;
    const coordinates = draftRef.current;

    if (current.mode === "draw-line" && coordinates.length >= 2) {
      const feature = createGeoJsonEditFeature(
        "LineString",
        coordinates,
        current.createFeatureProperties?.("LineString") ?? ({} as TProperties),
      );

      emitOperation(ensureCreatedFeatureId(feature, createCounterRef), "create");
      updateDraft([]);
      return;
    }

    if (current.mode === "draw-polygon" && countDistinctPositions(coordinates) >= 3) {
      const feature = createGeoJsonEditFeature(
        "Polygon",
        [closeRing(coordinates)],
        current.createFeatureProperties?.("Polygon") ?? ({} as TProperties),
      );

      emitOperation(ensureCreatedFeatureId(feature, createCounterRef), "create");
      updateDraft([]);
    }
  }

  function updateDraft(nextDraft: GeoJsonPosition[]) {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    surface?.requestRender();
  }

  function updateDraftPreview(nextPreview: GeoJsonPosition | null) {
    if (arePositionsEqual(draftPreviewRef.current, nextPreview)) {
      return;
    }

    draftPreviewRef.current = nextPreview ? clonePosition(nextPreview) : null;
    surface?.requestRender();
  }

  function updateSelectedHandle(nextHandle: GeoJsonVertexHandle | null) {
    selectedHandleRef.current = nextHandle;
    setSelectedHandle(nextHandle);
    emitEditorSelection({
      ...latestRef.current.resolvedSelection,
      vertexHandle: nextHandle,
    });
    surface?.requestRender();
  }

  function emitOperation(
    operationOrFeature:
      | GeoJsonEditOperation<TProperties>
      | TemporalGeoJsonGeometryFeature<TProperties>,
    operationType?: "create",
    nextSelection?: GeoJsonEditorSelection,
  ) {
    const current = latestRef.current;
    const operation =
      operationType === "create"
        ? ({
            feature: operationOrFeature as TemporalGeoJsonGeometryFeature<TProperties>,
            featureId: getCreatedFeatureId(
              operationOrFeature as TemporalGeoJsonGeometryFeature<TProperties>,
            ),
            type: "create",
          } satisfies GeoJsonEditOperation<TProperties>)
        : (operationOrFeature as GeoJsonEditOperation<TProperties>);

    const validation = validateEditOperation(operation, current.validateEdit);

    if (!validation.valid) {
      return;
    }

    const next = applyGeoJsonEditOperationWithResolver(
      current.featureCollection,
      operation,
      current.getFeatureId,
    );

    current.onFeatureCollectionChange?.(next, operation);

    if (nextSelection) {
      emitEditorSelection(nextSelection);
      return;
    }

    if (operation.type === "create" || operation.type === "update") {
      emitEditorSelection(createEditorSelection([operation.featureId], operation.featureId));
    } else if (operation.type === "delete") {
      emitEditorSelection(EMPTY_EDITOR_SELECTION);
    }
  }

  function emitEditorSelection(nextSelection: GeoJsonEditorSelection) {
    const normalized = normalizeEditorSelection(features, nextSelection);

    latestRef.current.onEditorSelectionChange?.(normalized);
    latestRef.current.onSelectionChange?.(normalized.primaryFeatureId);
  }

  function selectFeature(featureId: string, event: FlatFeaturePointerEvent = {}) {
    if (mode === "delete") {
      const feature = features.find((candidate) => candidate.id === featureId);

      if (feature?.editable) {
        const selectedFeatures = getSelectedEditableFeatures();
        const featuresToDelete = selectedFeatures.some((candidate) => candidate.id === featureId)
          ? selectedFeatures
          : [feature];

        deleteFeatures(featuresToDelete, "delete-selection");
      }
      return;
    }

    const originalEvent = event.originalEvent as
      | (MouseEvent & { altKey?: boolean; shiftKey?: boolean })
      | undefined;

    if (originalEvent?.altKey) {
      selectFeatureGroup(featureId);
      return;
    }

    if (originalEvent?.shiftKey) {
      toggleFeatureSelection(featureId);
      return;
    }

    emitEditorSelection(createEditorSelection([featureId], featureId));
  }

  function toggleFeatureSelection(featureId: string) {
    const current = latestRef.current.resolvedSelection;
    const selected = new Set(current.featureIds);

    if (selected.has(featureId)) {
      selected.delete(featureId);
    } else {
      selected.add(featureId);
    }

    const featureIds = [...selected];
    const primaryFeatureId = selected.has(current.primaryFeatureId ?? "")
      ? current.primaryFeatureId
      : (featureIds[0] ?? null);

    emitEditorSelection(createEditorSelection(featureIds, primaryFeatureId));
  }

  function selectFeatureGroup(featureId: string) {
    const feature = features.find((candidate) => candidate.id === featureId);
    const groupId = feature ? getFeatureGroupId(feature, latestRef.current.groupOptions) : null;

    if (!groupId) {
      emitEditorSelection(createEditorSelection([featureId], featureId));
      return;
    }

    const featureIds = features
      .filter(
        (candidate) => getFeatureGroupId(candidate, latestRef.current.groupOptions) === groupId,
      )
      .map((candidate) => candidate.id);

    emitEditorSelection(createEditorSelection(featureIds, featureId));
  }

  function deleteFeature(feature: EditableFeature<TProperties>) {
    if (!feature.editable) {
      return;
    }

    emitOperation({
      featureId: feature.id,
      previousFeature: cloneFeature(feature.feature),
      type: "delete",
    });
  }

  function deleteFeatures(
    targetFeatures: Array<EditableFeature<TProperties>>,
    reason: GeoJsonBatchEditReason,
  ) {
    const editableFeatures = targetFeatures.filter((feature) => feature.editable);

    if (editableFeatures.length === 0) {
      return false;
    }

    if (editableFeatures.length === 1) {
      deleteFeature(editableFeatures[0]!);
      return true;
    }

    emitOperation(
      {
        operations: editableFeatures.map((feature) => ({
          featureId: feature.id,
          previousFeature: cloneFeature(feature.feature),
          type: "delete" as const,
        })),
        reason,
        type: "batch",
      },
      undefined,
      EMPTY_EDITOR_SELECTION,
    );

    return true;
  }

  function getSelectedEditableFeatures() {
    const selectedIds = new Set(latestRef.current.resolvedSelection.featureIds);

    return features.filter((feature) => feature.editable && selectedIds.has(feature.id));
  }

  function runGeoJsonEditorCommand(command: GeoJsonEditorCommand) {
    const current = latestRef.current;
    const intercepted = current.onCommand?.(command, {
      mode: current.mode,
      selection: current.resolvedSelection,
    });

    if (intercepted === false) {
      return false;
    }

    if (command === "select-all") {
      const featureIds = features
        .filter((feature) => feature.editable)
        .map((feature) => feature.id);

      emitEditorSelection(createEditorSelection(featureIds, featureIds[0] ?? null));
      return featureIds.length > 0;
    }

    if (command === "clear-selection") {
      if (draftRef.current.length > 0) {
        updateDraft([]);
        return true;
      }

      if (current.resolvedSelection.vertexHandle) {
        updateSelectedHandle(null);
        return true;
      }

      emitEditorSelection(EMPTY_EDITOR_SELECTION);
      return current.resolvedSelection.featureIds.length > 0;
    }

    if (command === "finish-draft") {
      completeDraft();
      return current.mode === "draw-line" || current.mode === "draw-polygon";
    }

    if (command === "cancel-draft") {
      updateDraft([]);
      return true;
    }

    if (command === "remove-selected-vertex") {
      const handle = selectedHandleRef.current;

      if (current.mode === "reshape" && handle?.kind === "vertex") {
        removeSelectedVertex(handle);
        return true;
      }

      return false;
    }

    if (command === "delete-selection") {
      if (current.mode === "draw-line" || current.mode === "draw-polygon") {
        updateDraft(draftRef.current.slice(0, -1));
        return draftRef.current.length > 0;
      }

      const handle = selectedHandleRef.current;

      if (current.mode === "reshape" && handle?.kind === "vertex") {
        removeSelectedVertex(handle);
        return true;
      }

      return deleteFeatures(getSelectedEditableFeatures(), "delete-selection");
    }

    if (command === "duplicate-selection") {
      return duplicateSelectedFeatures();
    }

    if (command === "group-selection") {
      return groupSelectedFeatures();
    }

    if (command === "ungroup-selection") {
      return ungroupSelectedFeatures();
    }

    const nextMode = getCommandEditMode(command);

    if (nextMode) {
      current.onEditModeChange?.(nextMode);
      return Boolean(current.onEditModeChange || current.onCommand);
    }

    return Boolean(current.onCommand);
  }

  function duplicateSelectedFeatures() {
    const selectedFeatures = getSelectedEditableFeatures();

    if (selectedFeatures.length === 0) {
      return false;
    }

    const duplicateGroupId =
      selectedFeatures.length > 1
        ? createGeoJsonGroupId(groupCounterRef, latestRef.current.groupOptions)
        : null;
    const operations = selectedFeatures.map((feature) => {
      duplicateCounterRef.current += 1;

      const duplicateId = `${feature.id}-copy-${Date.now()}-${duplicateCounterRef.current}`;
      const duplicate = {
        ...cloneFeature(feature.feature),
        geometry: moveGeoJsonGeometry(feature.geometry, 0.45, 0.28),
        id: duplicateId,
        properties: {
          ...(feature.feature.properties ?? ({} as TProperties)),
          groupId: duplicateGroupId ?? undefined,
        } as TProperties,
      };

      return {
        feature: duplicate,
        featureId: duplicateId,
        type: "create" as const,
      };
    });
    const duplicateIds = operations.map((operation) => operation.featureId);

    emitOperation(
      {
        operations,
        reason: "duplicate-selection",
        type: "batch",
      },
      undefined,
      createEditorSelection(duplicateIds, duplicateIds[0] ?? null),
    );

    return true;
  }

  function groupSelectedFeatures() {
    const selectedFeatures = getSelectedEditableFeatures();

    if (selectedFeatures.length < 2) {
      return false;
    }

    const groupId = createGeoJsonGroupId(groupCounterRef, latestRef.current.groupOptions);

    emitOperation(
      {
        operations: selectedFeatures.map((feature) => ({
          feature: setFeatureGroupId(feature, groupId, latestRef.current.groupOptions),
          featureId: feature.id,
          previousFeature: cloneFeature(feature.feature),
          reason: "group-feature" as const,
          type: "update" as const,
        })),
        reason: "group-selection",
        type: "batch",
      },
      undefined,
      currentSelectionWithoutVertex(),
    );

    return true;
  }

  function ungroupSelectedFeatures() {
    const selectedIds = new Set(latestRef.current.resolvedSelection.featureIds);
    const selectedGroupIds = new Set(
      features.flatMap((feature) => {
        if (!selectedIds.has(feature.id)) {
          return [];
        }

        const groupId = getFeatureGroupId(feature, latestRef.current.groupOptions);

        return groupId ? [groupId] : [];
      }),
    );
    const targetFeatures = features.filter((feature) => {
      if (!feature.editable) {
        return false;
      }

      const groupId = getFeatureGroupId(feature, latestRef.current.groupOptions);

      return selectedIds.has(feature.id) || (groupId !== null && selectedGroupIds.has(groupId));
    });

    if (targetFeatures.length === 0) {
      return false;
    }

    emitOperation(
      {
        operations: targetFeatures.map((feature) => ({
          feature: setFeatureGroupId(feature, null, latestRef.current.groupOptions),
          featureId: feature.id,
          previousFeature: cloneFeature(feature.feature),
          reason: "ungroup-feature" as const,
          type: "update" as const,
        })),
        reason: "ungroup-selection",
        type: "batch",
      },
      undefined,
      currentSelectionWithoutVertex(),
    );

    return true;
  }

  function currentSelectionWithoutVertex() {
    return {
      ...latestRef.current.resolvedSelection,
      vertexHandle: null,
    };
  }

  function updateFeature(
    feature: EditableFeature<TProperties>,
    geometry: TemporalGeoJsonSupportedGeometry,
    reason: GeoJsonEditReason,
  ) {
    if (!feature.editable) {
      return;
    }

    emitOperation({
      feature: {
        ...cloneFeature(feature.feature),
        geometry,
      },
      featureId: feature.id,
      previousFeature: cloneFeature(feature.feature),
      reason,
      type: "update",
    });
  }

  function startFeatureDrag(
    feature: EditableFeature<TProperties>,
    event: FlatFeaturePointerEvent,
    map: FlatMapAdapter,
  ) {
    if (mode !== "move" || !feature.editable || !selectedFeatureIdSet.has(feature.id)) {
      return;
    }

    const coordinate = getEventCoordinate(map, event);

    if (!coordinate) {
      return;
    }

    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();
    const selectedFeatures = getSelectedEditableFeatures();
    dragRef.current = {
      features: selectedFeatures.length > 0 ? selectedFeatures : [feature],
      from: coordinate,
      type: "feature",
    };
    map.dragging?.disable?.();
    map.on("mouseup", handleDragEnd as never);
  }

  function startVertexDrag(
    feature: EditableFeature<TProperties>,
    handle: GeoJsonVertexHandle,
    event: FlatFeaturePointerEvent,
    map: FlatMapAdapter,
  ) {
    if (mode !== "reshape" || handle.kind !== "vertex") {
      return;
    }

    const coordinate = getEventCoordinate(map, event);

    if (!coordinate) {
      return;
    }

    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();
    updateSelectedHandle(handle);
    dragRef.current = {
      feature,
      from: coordinate,
      handle,
      type: "vertex",
    };
    map.dragging?.disable?.();
    map.on("mouseup", handleDragEnd as never);
  }

  function handleDragEnd(event: FlatFeaturePointerEvent = {}) {
    const drag = dragRef.current;
    const map = flatMap;

    if (!drag || !map) {
      return;
    }

    map.off("mouseup", handleDragEnd as never);
    map.dragging?.enable?.();
    dragRef.current = null;

    const to = getEventCoordinate(map, event);

    if (!to) {
      return;
    }

    if (drag.type === "feature") {
      const deltaLongitude = to[0] - drag.from[0];
      const deltaLatitude = to[1] - drag.from[1];

      if (drag.features.length === 1) {
        const feature = drag.features[0]!;
        const next = moveGeoJsonGeometry(feature.geometry, deltaLongitude, deltaLatitude);

        updateFeature(feature, next, "move-feature");
        return;
      }

      emitOperation(
        {
          operations: drag.features.map((feature) => ({
            feature: {
              ...cloneFeature(feature.feature),
              geometry: moveGeoJsonGeometry(feature.geometry, deltaLongitude, deltaLatitude),
            },
            featureId: feature.id,
            previousFeature: cloneFeature(feature.feature),
            reason: "move-feature" as const,
            type: "update" as const,
          })),
          reason: "move-selection",
          type: "batch",
        },
        undefined,
        latestRef.current.resolvedSelection,
      );
      return;
    }

    const next = setGeoJsonVertex(drag.feature.geometry, drag.handle, to);

    if (next) {
      updateFeature(drag.feature, next, "move-vertex");
    }
  }

  function insertMidpoint(feature: EditableFeature<TProperties>, handle: GeoJsonVertexHandle) {
    const next = insertGeoJsonVertex(feature.geometry, handle, handle.coordinates);

    if (next) {
      updateFeature(feature, next, "insert-vertex");
    }
  }

  function removeSelectedVertex(handle: GeoJsonVertexHandle) {
    const feature = features.find((candidate) => candidate.id === handle.featureId);

    if (!feature) {
      return;
    }

    const next = removeGeoJsonVertex(feature.geometry, handle);

    if (next) {
      updateFeature(feature, next, "remove-vertex");
      updateSelectedHandle(null);
    }
  }

  function renderVertexHandles(
    feature: EditableFeature<TProperties>,
    options: {
      handleColor: string;
      layer: FlatLayerGroup;
      flat: FlatLayerFactory;
      map: FlatMapAdapter;
      midpointHandleColor: string;
    },
  ) {
    for (const handle of getGeoJsonVertexHandles(feature.geometry, feature.id)) {
      const isMidpoint = handle.kind === "midpoint";
      const selected = !isMidpoint && areVertexHandlesEqual(selectedHandleRef.current, handle);
      const marker = options.flat.circleMarker(toLatLng(handle.coordinates), {
        bubblingMouseEvents: false,
        className: joinClassNames(
          "mb-maps__editor-handle",
          isMidpoint && "mb-maps__editor-handle--midpoint",
          selected && "mb-maps__editor-handle--selected",
        ),
        color: selected ? "#0284c7" : isMidpoint ? "#0284c7" : "#0f172a",
        fillColor: selected
          ? "#e0f2fe"
          : isMidpoint
            ? options.midpointHandleColor
            : options.handleColor,
        fillOpacity: 1,
        interactive: true,
        opacity: 1,
        radius: selected ? 7 : isMidpoint ? 4 : 5.5,
        weight: selected ? 3 : 2,
      }) as FlatGeometryLayer;

      marker.on("click", (event: FlatFeaturePointerEvent = {}) => {
        event.originalEvent?.preventDefault?.();
        event.originalEvent?.stopPropagation?.();

        if (isMidpoint) {
          insertMidpoint(feature, handle);
          return;
        }

        updateSelectedHandle(handle);
      });
      marker.on("mousedown", (event: FlatFeaturePointerEvent = {}) => {
        startVertexDrag(feature, handle, event, options.map);
      });
      marker.addTo(options.layer);
    }
  }

  if (!surface || surface.display !== "globe") {
    return null;
  }

  return null;
}

export function EditableGeoJsonMap<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  className,
  children,
  editMode,
  editorStyle,
  enableKeyboardShortcuts = true,
  fitBoundsPadding = 56,
  fitToData = true,
  geoJson,
  globeBasemapMode,
  initialViewState,
  mapDisplay = "flat",
  mapLabel = "Editable GeoJSON map",
  mapStyle = defaultRasterMapStyle,
  maxBounds,
  maxZoom,
  measurementDistanceFormat,
  measurementDraftLineColor,
  measurementLineColor,
  measurementMode,
  measurements,
  onMapControllerReady,
  onMapContextMenu,
  onMapReady,
  onMeasurementCreate,
  onMeasurementDraftChange,
  onMeasurementSelect,
  onViewStateChange,
  renderMapContextMenu,
  showAttributionControl = true,
  showTimelineEditor = false,
  style,
  timelineActiveTimeMs,
  timelineClassName,
  timelineDocument,
  timelineDurationMs,
  timelineFrameRate,
  timelineReadOnly,
  timelineSelection,
  timelineSnap,
  timelineViewport,
  onTimelineActiveTimeChange,
  onTimelineDocumentChange,
  onTimelineSelectionChange,
  onTimelineViewportChange,
  viewState,
  defaultViewState,
  ...editorProps
}: EditableGeoJsonMapProps<TProperties>) {
  const generatedTimelineDocument = useMemo(
    () =>
      createGeoJsonTimelineDocument(geoJson, {
        durationMs: timelineDurationMs,
        getFeatureId: editorProps.getFeatureId,
      }),
    [editorProps.getFeatureId, geoJson, timelineDurationMs],
  );
  const [uncontrolledTimelineDocument, setUncontrolledTimelineDocument] =
    useState(generatedTimelineDocument);
  const resolvedTimelineDocument = timelineDocument ?? uncontrolledTimelineDocument;
  const resolvedTimelineTime = timelineActiveTimeMs ?? resolvedTimelineDocument.currentTimeMs ?? 0;
  const transformedGeoJson =
    timelineDocument || showTimelineEditor
      ? getGeoJsonTimelineFeatureCollectionAtTime(
          geoJson,
          resolvedTimelineDocument,
          resolvedTimelineTime,
          {
            getFeatureId: editorProps.getFeatureId,
            outsideItemBehavior: "hold",
          },
        )
      : geoJson;

  useEffect(() => {
    if (!timelineDocument) {
      setUncontrolledTimelineDocument(generatedTimelineDocument);
    }
  }, [generatedTimelineDocument, timelineDocument]);

  const map = (
    <MapView
      className={showTimelineEditor || timelineDocument ? undefined : className}
      dataBounds={getBoundsFromGeoJson(transformedGeoJson)}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      globeBasemapMode={globeBasemapMode}
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
      maxZoom={maxZoom}
      onMapControllerReady={onMapControllerReady}
      onMapContextMenu={onMapContextMenu}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      renderMapContextMenu={renderMapContextMenu}
      showAttributionControl={showAttributionControl}
      style={showTimelineEditor || timelineDocument ? undefined : style}
      viewState={viewState}
    >
      <GeoJsonEditorLayer
        {...(editorProps as Omit<
          GeoJsonEditorLayerProps<TProperties>,
          "enableKeyboardShortcuts" | "featureCollection" | "mode" | "style"
        >)}
        enableKeyboardShortcuts={enableKeyboardShortcuts}
        featureCollection={transformedGeoJson}
        mode={editMode}
        style={editorStyle}
      />
      <BeeLineMeasurementLayer
        measurementDistanceFormat={measurementDistanceFormat}
        measurementDraftLineColor={measurementDraftLineColor}
        measurementLineColor={measurementLineColor}
        measurementMode={measurementMode}
        measurements={measurements}
        onMeasurementCreate={onMeasurementCreate}
        onMeasurementDraftChange={onMeasurementDraftChange}
        onMeasurementSelect={onMeasurementSelect}
      />
      {children}
    </MapView>
  );

  if (!showTimelineEditor && !timelineDocument) {
    return map;
  }

  return (
    <div className={joinClassNames("mb-geojson-editor", className)} style={style}>
      <div className="mb-geojson-editor__map">{map}</div>
      <GeoJsonTimelineEditor
        className={timelineClassName}
        document={resolvedTimelineDocument}
        frameRate={timelineFrameRate}
        readOnly={timelineReadOnly}
        selectedFeatureId={editorProps.selectedFeatureId}
        selection={timelineSelection}
        snap={timelineSnap}
        viewport={timelineViewport}
        onCurrentTimeChange={onTimelineActiveTimeChange}
        onDocumentChange={(next) => {
          setUncontrolledTimelineDocument(next);
          onTimelineDocumentChange?.(next);
        }}
        onSelectionChange={onTimelineSelectionChange}
        onViewportChange={onTimelineViewportChange}
      />
    </div>
  );
}

function createEditableFeatures<TProperties extends Record<string, unknown>>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  getFeatureId: GeoJsonEditorLayerProps<TProperties>["getFeatureId"],
  canEditFeature: GeoJsonEditorLayerProps<TProperties>["canEditFeature"],
): Array<EditableFeature<TProperties>> {
  return collection.features.flatMap((feature, index) => {
    const geometry = normalizeSupportedGeometry(feature.geometry);

    if (!geometry) {
      return [];
    }

    return [
      {
        editable: canEditFeature?.(feature) ?? true,
        feature,
        geometry,
        id: getFeatureId?.(feature, index) ?? resolveFeatureId(feature, index),
        index,
      },
    ];
  });
}

function bindFeatureLayer<TProperties extends Record<string, unknown>>(
  layer: FlatGeometryLayer,
  options: {
    feature: EditableFeature<TProperties>;
    map: FlatMapAdapter;
    onDragStart: (event: FlatFeaturePointerEvent) => void;
    onGroupSelect: () => void;
    onSelect: (event: FlatFeaturePointerEvent) => void;
  },
) {
  layer.on("click", (event: FlatFeaturePointerEvent = {}) => {
    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();
    options.onSelect(event);
  });
  layer.on("dblclick", (event: FlatFeaturePointerEvent = {}) => {
    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();
    options.onGroupSelect();
  });
  layer.on("mousedown", (event: FlatFeaturePointerEvent = {}) => {
    options.onDragStart(event);
  });
  layer.on("mouseover", () => {
    options.map.getContainer().style.cursor = options.feature.editable ? "pointer" : "";
  });
  layer.on("mouseout", () => {
    options.map.getContainer().style.cursor = "";
  });
}

function renderDraft(
  layer: FlatLayerGroup,
  flat: FlatLayerFactory,
  draft: readonly GeoJsonPosition[],
  preview: GeoJsonPosition | null,
  mode: GeoJsonEditMode,
) {
  if (mode === "draw-point") {
    if (!preview) {
      return;
    }

    flat
      .circleMarker(toLatLng(preview), {
        className: "mb-maps__editor-draft mb-maps__editor-draft-point",
        color: "#0284c7",
        fillColor: "#38bdf8",
        fillOpacity: 0.18,
        interactive: false,
        opacity: 0.9,
        radius: 7,
        weight: 2,
      })
      .addTo(layer);
    return;
  }

  if (mode !== "draw-line" && mode !== "draw-polygon") {
    return;
  }

  const previewDraft =
    preview && !draft.some((position) => arePositionsEqual(position, preview))
      ? [...draft, preview]
      : draft;

  if (previewDraft.length === 0) {
    return;
  }

  const latLngs = previewDraft.map(toLatLng);

  if (mode === "draw-polygon" && previewDraft.length >= 3) {
    flat
      .polygon([closeRing(previewDraft).map(toLatLng)], {
        className: "mb-maps__editor-draft",
        color: "#0284c7",
        fillColor: "#38bdf8",
        fillOpacity: 0.16,
        interactive: false,
        opacity: 0.9,
        weight: 2,
      })
      .addTo(layer);
    return;
  }

  flat
    .polyline(latLngs, {
      className: "mb-maps__editor-draft",
      color: "#0284c7",
      interactive: false,
      opacity: 0.9,
      weight: 2,
    })
    .addTo(layer);
}

function getGeoJsonVertexHandles(
  geometry: TemporalGeoJsonSupportedGeometry,
  featureId: string,
): GeoJsonVertexHandle[] {
  const handles: GeoJsonVertexHandle[] = [];

  if (geometry.type === "Point") {
    handles.push(createVertexHandle(featureId, geometry.coordinates, 0));
  } else if (geometry.type === "MultiPoint") {
    geometry.coordinates.forEach((coordinates, index) => {
      handles.push(createVertexHandle(featureId, coordinates, index, { geometryIndex: index }));
    });
  } else if (geometry.type === "LineString") {
    pushLineHandles(handles, featureId, geometry.coordinates);
  } else if (geometry.type === "MultiLineString") {
    geometry.coordinates.forEach((line, lineIndex) => {
      pushLineHandles(handles, featureId, line, { geometryIndex: lineIndex });
    });
  } else if (geometry.type === "Polygon") {
    geometry.coordinates.forEach((ring, ringIndex) => {
      pushRingHandles(handles, featureId, ring, { ringIndex });
    });
  } else if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach((polygon, polygonIndex) => {
      polygon.forEach((ring, ringIndex) => {
        pushRingHandles(handles, featureId, ring, { geometryIndex: polygonIndex, ringIndex });
      });
    });
  }

  return handles;
}

function pushLineHandles(
  handles: GeoJsonVertexHandle[],
  featureId: string,
  line: readonly GeoJsonPosition[],
  metadata: Partial<GeoJsonVertexHandle> = {},
) {
  line.forEach((coordinates, vertexIndex) => {
    handles.push(createVertexHandle(featureId, coordinates, vertexIndex, metadata));

    if (vertexIndex < line.length - 1) {
      handles.push(
        createMidpointHandle(featureId, coordinates, line[vertexIndex + 1]!, vertexIndex, {
          ...metadata,
          nextVertexIndex: vertexIndex + 1,
        }),
      );
    }
  });
}

function pushRingHandles(
  handles: GeoJsonVertexHandle[],
  featureId: string,
  ring: readonly GeoJsonPosition[],
  metadata: Partial<GeoJsonVertexHandle> = {},
) {
  const openRing = removeClosingPosition(ring);

  openRing.forEach((coordinates, vertexIndex) => {
    handles.push(createVertexHandle(featureId, coordinates, vertexIndex, metadata));
    handles.push(
      createMidpointHandle(
        featureId,
        coordinates,
        openRing[(vertexIndex + 1) % openRing.length]!,
        vertexIndex,
        {
          ...metadata,
          nextVertexIndex: vertexIndex + 1,
        },
      ),
    );
  });
}

function createVertexHandle(
  featureId: string,
  coordinates: GeoJsonPosition,
  vertexIndex: number,
  metadata: Partial<GeoJsonVertexHandle> = {},
): GeoJsonVertexHandle {
  return {
    coordinates: clonePosition(coordinates),
    featureId,
    kind: "vertex",
    vertexIndex,
    ...metadata,
  };
}

function createMidpointHandle(
  featureId: string,
  from: GeoJsonPosition,
  to: GeoJsonPosition,
  vertexIndex: number,
  metadata: Partial<GeoJsonVertexHandle> = {},
): GeoJsonVertexHandle {
  return {
    coordinates: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    featureId,
    kind: "midpoint",
    vertexIndex,
    ...metadata,
  };
}

function areVertexHandlesEqual(
  left: GeoJsonVertexHandle | null,
  right: GeoJsonVertexHandle | null,
) {
  return (
    left?.featureId === right?.featureId &&
    left?.geometryIndex === right?.geometryIndex &&
    left?.kind === right?.kind &&
    left?.nextVertexIndex === right?.nextVertexIndex &&
    left?.ringIndex === right?.ringIndex &&
    left?.vertexIndex === right?.vertexIndex
  );
}

function normalizeEditorSelection<TProperties extends Record<string, unknown>>(
  features: Array<EditableFeature<TProperties>>,
  selection?: GeoJsonEditorSelection | null,
  selectedFeatureIds?: readonly string[] | null,
  selectedFeatureId?: string | null,
  selectedHandle?: GeoJsonVertexHandle | null,
): GeoJsonEditorSelection {
  const availableIds = new Set(features.map((feature) => feature.id));
  const sourceIds =
    selection?.featureIds ??
    selectedFeatureIds ??
    (selectedFeatureId ? [selectedFeatureId] : EMPTY_EDITOR_SELECTION.featureIds);
  const featureIds = dedupeStrings(sourceIds).filter((featureId) => availableIds.has(featureId));
  const requestedPrimary =
    selection?.primaryFeatureId ??
    (selectedFeatureIds ? selectedFeatureId : null) ??
    selectedFeatureId ??
    featureIds[0] ??
    null;
  const primaryFeatureId =
    requestedPrimary && featureIds.includes(requestedPrimary)
      ? requestedPrimary
      : (featureIds[0] ?? null);
  const vertexHandle = selection?.vertexHandle ?? selectedHandle ?? null;

  return {
    featureIds,
    primaryFeatureId,
    vertexHandle: vertexHandle && featureIds.includes(vertexHandle.featureId) ? vertexHandle : null,
  };
}

function createEditorSelection(
  featureIds: readonly string[],
  primaryFeatureId: string | null,
  vertexHandle: GeoJsonVertexHandle | null = null,
): GeoJsonEditorSelection {
  const dedupedIds = dedupeStrings(featureIds);

  return {
    featureIds: dedupedIds,
    primaryFeatureId:
      primaryFeatureId && dedupedIds.includes(primaryFeatureId)
        ? primaryFeatureId
        : (dedupedIds[0] ?? null),
    vertexHandle,
  };
}

function dedupeStrings(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function getFeatureGroupId<TProperties extends Record<string, unknown>>(
  feature: EditableFeature<TProperties>,
  groupOptions: GeoJsonEditorGroupOptions<TProperties> | undefined,
) {
  const customGroupId = groupOptions?.getGroupId?.(feature.feature, feature.index);

  if (customGroupId !== undefined && customGroupId !== null && customGroupId !== "") {
    return String(customGroupId);
  }

  const groupId = feature.feature.properties?.groupId;

  return typeof groupId === "string" && groupId.length > 0 ? groupId : null;
}

function setFeatureGroupId<TProperties extends Record<string, unknown>>(
  feature: EditableFeature<TProperties>,
  groupId: string | null,
  groupOptions: GeoJsonEditorGroupOptions<TProperties> | undefined,
) {
  if (groupOptions?.setGroupId) {
    return groupOptions.setGroupId(cloneFeature(feature.feature), groupId);
  }

  const properties = {
    ...(feature.feature.properties ?? ({} as TProperties)),
  } as TProperties & { groupId?: string };

  if (groupId) {
    properties.groupId = groupId;
  } else {
    delete properties.groupId;
  }

  return {
    ...cloneFeature(feature.feature),
    properties: properties as TProperties,
  };
}

function createGeoJsonGroupId<TProperties extends Record<string, unknown>>(
  counterRef: { current: number },
  groupOptions: GeoJsonEditorGroupOptions<TProperties> | undefined,
) {
  if (groupOptions?.groupId) {
    return groupOptions.groupId;
  }

  counterRef.current += 1;

  return `geojson-group-${Date.now()}-${counterRef.current}`;
}

function getGeoJsonEditorKeyboardCommand(event: KeyboardEvent): GeoJsonEditorCommand | null {
  const key = event.key.toLowerCase();
  const primaryModifier = event.ctrlKey || event.metaKey;

  if (primaryModifier && key === "a") {
    return "select-all";
  }

  if (primaryModifier && key === "d") {
    return "duplicate-selection";
  }

  if (primaryModifier && key === "g") {
    return event.shiftKey ? "ungroup-selection" : "group-selection";
  }

  if (primaryModifier || event.altKey) {
    return null;
  }

  if (key === "escape") {
    return "clear-selection";
  }

  if (key === "enter") {
    return "finish-draft";
  }

  if (key === "delete" || key === "backspace") {
    return "delete-selection";
  }

  switch (key) {
    case "v":
      return "start-select";
    case "p":
      return "start-draw-point";
    case "l":
      return "start-draw-line";
    case "g":
      return "start-draw-polygon";
    case "m":
      return "start-move";
    case "r":
      return "start-reshape";
    default:
      return null;
  }
}

function getCommandEditMode(command: GeoJsonEditorCommand): GeoJsonEditMode | null {
  switch (command) {
    case "start-select":
      return "select";
    case "start-draw-point":
      return "draw-point";
    case "start-draw-line":
      return "draw-line";
    case "start-draw-polygon":
      return "draw-polygon";
    case "start-move":
      return "move";
    case "start-reshape":
      return "reshape";
    default:
      return null;
  }
}

function isKeyboardShortcutTargetEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();

  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

function resolveEditorStyle(
  style: GeoJsonLayerStyle | undefined,
  selectedStyle: GeoJsonLayerStyle | undefined,
  selected: boolean,
): Required<GeoJsonLayerStyle> {
  return {
    ...EDITOR_STYLE,
    ...style,
    ...(selected ? SELECTED_EDITOR_STYLE : null),
    ...(selected ? selectedStyle : null),
  };
}

function ensureCreatedFeatureId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  counterRef: { current: number },
) {
  const currentId = getCreatedFeatureId(feature);

  if (currentId) {
    return feature;
  }

  counterRef.current += 1;

  return {
    ...feature,
    id: `geojson-edit-${Date.now()}-${counterRef.current}`,
  };
}

function getCreatedFeatureId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
) {
  return String(feature.id ?? feature.properties?.id ?? feature.properties?.trackId ?? "");
}

function getEventCoordinate(
  map: FlatMapAdapter & {
    containerPointToLatLng?: (point: [number, number]) => { lat: number; lng: number };
  },
  event: FlatFeaturePointerEvent,
): GeoJsonPosition | null {
  if (event.latlng) {
    return [event.latlng.lng, event.latlng.lat];
  }

  if (event.lngLat) {
    return [event.lngLat.lng, event.lngLat.lat];
  }

  if (event.containerPoint && map.containerPointToLatLng) {
    const latlng = map.containerPointToLatLng([event.containerPoint.x, event.containerPoint.y]);

    return [latlng.lng, latlng.lat];
  }

  return null;
}

function countDistinctPositions(coordinates: readonly GeoJsonPosition[]) {
  return new Set(coordinates.map((coordinate) => `${coordinate[0]}:${coordinate[1]}`)).size;
}
