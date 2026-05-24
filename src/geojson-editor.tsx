"use client";

import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

import { getBoundsFromGeoJson, type GeoJsonMapSource } from "./geojson-source";
import { type GeoJsonLayerStyle } from "./geojson-layer";
import {
  createFlatGeometryLayers,
  type FlatGeometryLayer,
  type LeafletFeaturePointerEvent,
} from "./geojson-rendering";
import {
  defaultRasterMapStyle,
  joinClassNames,
  toLeafletLatLng,
  type GlobeBasemapMode,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import type { MapContextMenuContext } from "./map-interaction";
import { MapSurfaceContext } from "./map-view";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";
import type { MapMeasurementProps } from "./measurement";
import {
  cloneGeometry,
  clonePosition,
  closeRing,
  normalizeSupportedGeometry,
} from "./temporal-geojson-geometry";
import type {
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeature,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";
import { MapView } from "./map-view";

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
  | "draw-complete";

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
    };

export type GeoJsonEditorLayerProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = {
  canEditFeature?: (feature: TemporalGeoJsonGeometryFeature<TProperties>) => boolean;
  createFeatureProperties?: (geometryType: "Point" | "LineString" | "Polygon") => TProperties;
  featureCollection: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string;
  handleColor?: string;
  layerId?: string;
  midpointHandleColor?: string;
  mode: GeoJsonEditMode;
  onFeatureCollectionChange?: (
    next: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
    operation: GeoJsonEditOperation<TProperties>,
  ) => void;
  onSelectionChange?: (featureId: string | null) => void;
  selectedFeatureId?: string | null;
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
    onMapReady?: (map: LeafletMap) => void;
    renderMapContextMenu?: (context: MapContextMenuContext) => React.ReactNode;
    showAttributionControl?: boolean;
    style?: React.CSSProperties;
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
      feature: EditableFeature<TProperties>;
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

export function GeoJsonEditorLayer<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  canEditFeature,
  createFeatureProperties,
  featureCollection,
  getFeatureId,
  handleColor = "#ffffff",
  layerId,
  midpointHandleColor = "#bae6fd",
  mode,
  onFeatureCollectionChange,
  onSelectionChange,
  selectedFeatureId,
  selectedStyle,
  style,
  validateEdit,
}: GeoJsonEditorLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `geojson-editor-layer-${generatedLayerId}`;
  const [draft, setDraft] = useState<GeoJsonPosition[]>([]);
  const draftRef = useRef<GeoJsonPosition[]>([]);
  const [selectedHandle, setSelectedHandle] = useState<GeoJsonVertexHandle | null>(null);
  const selectedHandleRef = useRef<GeoJsonVertexHandle | null>(null);
  const createCounterRef = useRef(0);
  const dragRef = useRef<DragState<TProperties> | null>(null);
  const latestRef = useRef({
    canEditFeature,
    createFeatureProperties,
    featureCollection,
    getFeatureId,
    mode,
    onFeatureCollectionChange,
    onSelectionChange,
    selectedFeatureId,
    validateEdit,
  });
  const features = useMemo(
    () => createEditableFeatures(featureCollection, getFeatureId, canEditFeature),
    [canEditFeature, featureCollection, getFeatureId],
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    selectedHandleRef.current = selectedHandle;
  }, [selectedHandle]);

  useEffect(() => {
    latestRef.current = {
      canEditFeature,
      createFeatureProperties,
      featureCollection,
      getFeatureId,
      mode,
      onFeatureCollectionChange,
      onSelectionChange,
      selectedFeatureId,
      validateEdit,
    };
  }, [
    canEditFeature,
    createFeatureProperties,
    featureCollection,
    getFeatureId,
    mode,
    onFeatureCollectionChange,
    onSelectionChange,
    selectedFeatureId,
    validateEdit,
  ]);

  useEffect(() => {
    if (!surface || surface.display !== "flat" || mode === "none") {
      return;
    }

    return surface.registerInteractionMode(resolvedLayerId, "editing");
  }, [mode, resolvedLayerId, surface]);

  useEffect(() => {
    if (!surface || surface.display !== "flat" || !surface.leafletMap) {
      return;
    }

    const map = surface.leafletMap;

    function getCoordinate(event: LeafletFeaturePointerEvent = {}) {
      return getEventCoordinate(map, event);
    }

    function handleClick(event: LeafletFeaturePointerEvent = {}) {
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
        current.onSelectionChange?.(null);
        setSelectedHandle(null);
        return;
      }

      if (current.mode === "draw-point") {
        const feature = createGeoJsonEditFeature(
          "Point",
          coordinates,
          current.createFeatureProperties?.("Point") ?? ({} as TProperties),
        );

        emitOperation(
          ensureCreatedFeatureId(feature, createCounterRef),
          "create",
        );
        return;
      }

      if (current.mode === "draw-line" || current.mode === "draw-polygon") {
        const nextDraft = [...draftRef.current, coordinates];

        draftRef.current = nextDraft;
        setDraft(nextDraft);
      }
    }

    function handleDoubleClick(event: LeafletFeaturePointerEvent = {}) {
      const current = latestRef.current;

      if (current.mode !== "draw-line" && current.mode !== "draw-polygon") {
        return;
      }

      event.originalEvent?.preventDefault?.();
      completeDraft();
    }

    function handleKeyDown(event: KeyboardEvent) {
      const current = latestRef.current;

      if (current.mode === "draw-line" || current.mode === "draw-polygon") {
        if (event.key === "Escape") {
          draftRef.current = [];
          setDraft([]);
          return;
        }

        if (event.key === "Backspace") {
          const nextDraft = draftRef.current.slice(0, -1);

          draftRef.current = nextDraft;
          setDraft(nextDraft);

          return;
        }

        if (event.key === "Enter") {
          completeDraft();
          return;
        }
      }

      if (current.mode === "reshape" && (event.key === "Delete" || event.key === "Backspace")) {
        const handle = selectedHandleRef.current;

        if (handle?.kind === "vertex") {
          removeSelectedVertex(handle);
        }
      }
    }

    map.on("click", handleClick as never);
    map.on("dblclick", handleDoubleClick as never);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      map.off("click", handleClick as never);
      map.off("dblclick", handleDoubleClick as never);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [surface]);

  useEffect(() => {
    if (mode !== "draw-line" && mode !== "draw-polygon") {
      draftRef.current = [];
      setDraft([]);
    }

    setSelectedHandle(null);
  }, [mode, selectedFeatureId]);

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer(resolvedLayerId, ({ layer, leaflet, map }) => {
      layer.clearLayers();

      if (mode === "none") {
        return;
      }

      for (const feature of features) {
        const selected = feature.id === selectedFeatureId;
        const resolvedStyle = resolveEditorStyle(style, selected ? selectedStyle : undefined, selected);
        const layers = createFlatGeometryLayers(feature.geometry, {
          className: joinClassNames(
            "mb-maps__editor-feature",
            selected && "mb-maps__editor-feature--selected",
            selected && "mb-maps__feature--selected",
          ),
          interactive: true,
          leaflet,
          selected,
          style: resolvedStyle,
        });

        for (const geometryLayer of layers) {
          bindFeatureLayer(geometryLayer, {
            feature,
            map,
            onDragStart: (event) => startFeatureDrag(feature, event, map),
            onSelect: () => selectFeature(feature.id),
          });
          geometryLayer.addTo(layer);
        }

        if (mode === "reshape" && selected && feature.editable) {
          renderVertexHandles(feature, {
            handleColor,
            layer,
            leaflet,
            map,
            midpointHandleColor,
          });
        }
      }

      renderDraft(layer, leaflet, draftRef.current, mode);
    });
  }, [
    features,
    handleColor,
    midpointHandleColor,
    mode,
    resolvedLayerId,
    selectedFeatureId,
    selectedStyle,
    style,
    surface,
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
      draftRef.current = [];
      setDraft([]);
      return;
    }

    if (current.mode === "draw-polygon" && countDistinctPositions(coordinates) >= 3) {
      const feature = createGeoJsonEditFeature(
        "Polygon",
        [closeRing(coordinates)],
        current.createFeatureProperties?.("Polygon") ?? ({} as TProperties),
      );

      emitOperation(ensureCreatedFeatureId(feature, createCounterRef), "create");
      draftRef.current = [];
      setDraft([]);
    }
  }

  function emitOperation(
    operationOrFeature: GeoJsonEditOperation<TProperties> | TemporalGeoJsonGeometryFeature<TProperties>,
    operationType?: "create",
  ) {
    const current = latestRef.current;
    const operation =
      operationType === "create"
        ? ({
            feature: operationOrFeature as TemporalGeoJsonGeometryFeature<TProperties>,
            featureId: getCreatedFeatureId(operationOrFeature as TemporalGeoJsonGeometryFeature<TProperties>),
            type: "create",
          } satisfies GeoJsonEditOperation<TProperties>)
        : (operationOrFeature as GeoJsonEditOperation<TProperties>);

    if (operation.type === "create" || operation.type === "update") {
      const validation = validateOperation(operation, current.validateEdit);

      if (!validation.valid) {
        return;
      }
    }

    const next = applyGeoJsonEditOperationWithResolver(
      current.featureCollection,
      operation,
      current.getFeatureId,
    );

    current.onFeatureCollectionChange?.(next, operation);

    if (operation.type === "delete") {
      current.onSelectionChange?.(null);
    } else {
      current.onSelectionChange?.(operation.featureId);
    }
  }

  function selectFeature(featureId: string) {
    if (mode === "delete") {
      const feature = features.find((candidate) => candidate.id === featureId);

      if (feature?.editable) {
        deleteFeature(feature);
      }
      return;
    }

    onSelectionChange?.(featureId);
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
    event: LeafletFeaturePointerEvent,
    map: LeafletMap,
  ) {
    if (mode !== "move" || !feature.editable || selectedFeatureId !== feature.id) {
      return;
    }

    const coordinate = getEventCoordinate(map, event);

    if (!coordinate) {
      return;
    }

    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();
    dragRef.current = {
      feature,
      from: coordinate,
      type: "feature",
    };
    map.dragging?.disable?.();
    map.on("mouseup", handleDragEnd as never);
  }

  function startVertexDrag(
    feature: EditableFeature<TProperties>,
    handle: GeoJsonVertexHandle,
    event: LeafletFeaturePointerEvent,
    map: LeafletMap,
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
    setSelectedHandle(handle);
    dragRef.current = {
      feature,
      from: coordinate,
      handle,
      type: "vertex",
    };
    map.dragging?.disable?.();
    map.on("mouseup", handleDragEnd as never);
  }

  function handleDragEnd(event: LeafletFeaturePointerEvent = {}) {
    const drag = dragRef.current;
    const map = surface?.leafletMap;

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
      const next = moveGeoJsonGeometry(
        drag.feature.geometry,
        to[0] - drag.from[0],
        to[1] - drag.from[1],
      );

      updateFeature(drag.feature, next, "move-feature");
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
      setSelectedHandle(null);
    }
  }

  function renderVertexHandles(
    feature: EditableFeature<TProperties>,
    options: {
      handleColor: string;
      layer: LayerGroup;
      leaflet: typeof import("leaflet");
      map: LeafletMap;
      midpointHandleColor: string;
    },
  ) {
    for (const handle of getGeoJsonVertexHandles(feature.geometry, feature.id)) {
      const isMidpoint = handle.kind === "midpoint";
      const marker = options.leaflet.circleMarker(toLeafletLatLng(handle.coordinates), {
        bubblingMouseEvents: false,
        className: joinClassNames(
          "mb-maps__editor-handle",
          isMidpoint && "mb-maps__editor-handle--midpoint",
        ),
        color: isMidpoint ? "#0284c7" : "#0f172a",
        fillColor: isMidpoint ? options.midpointHandleColor : options.handleColor,
        fillOpacity: 1,
        interactive: true,
        opacity: 1,
        radius: isMidpoint ? 4 : 5.5,
        weight: 2,
      }) as FlatGeometryLayer;

      marker.on("click", (event: LeafletFeaturePointerEvent = {}) => {
        event.originalEvent?.preventDefault?.();
        event.originalEvent?.stopPropagation?.();

        if (isMidpoint) {
          insertMidpoint(feature, handle);
          return;
        }

        setSelectedHandle(handle);
      });
      marker.on("mousedown", (event: LeafletFeaturePointerEvent = {}) => {
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
  editMode,
  editorStyle,
  fitBoundsPadding = 56,
  fitToData = true,
  geoJson,
  globeBasemapMode,
  initialViewState,
  mapDisplay = "flat",
  mapLabel = "Editable GeoJSON map",
  mapStyle = defaultRasterMapStyle,
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
  style,
  viewState,
  defaultViewState,
  ...editorProps
}: EditableGeoJsonMapProps<TProperties>) {
  return (
    <MapView
      className={className}
      dataBounds={getBoundsFromGeoJson(geoJson)}
      defaultViewState={defaultViewState}
      fitBoundsPadding={fitBoundsPadding}
      fitToData={fitToData}
      globeBasemapMode={globeBasemapMode}
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      onMapControllerReady={onMapControllerReady}
      onMapContextMenu={onMapContextMenu}
      onMapReady={onMapReady}
      onViewStateChange={onViewStateChange}
      renderMapContextMenu={renderMapContextMenu}
      showAttributionControl={showAttributionControl}
      style={style}
      viewState={viewState}
    >
      <GeoJsonEditorLayer
        {...(editorProps as Omit<GeoJsonEditorLayerProps<TProperties>, "featureCollection" | "mode" | "style">)}
        featureCollection={geoJson}
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
    </MapView>
  );
}

export function applyGeoJsonEditOperation<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  operation: GeoJsonEditOperation<TProperties>,
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  return applyGeoJsonEditOperationWithResolver(collection, operation);
}

function applyGeoJsonEditOperationWithResolver<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
  operation: GeoJsonEditOperation<TProperties>,
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string,
): TemporalGeoJsonGeometryFeatureCollection<TProperties> {
  if (operation.type === "create") {
    return {
      ...collection,
      features: [...collection.features.map(cloneFeature), cloneFeature(operation.feature)],
    };
  }

  if (operation.type === "delete") {
    return {
      ...collection,
      features: collection.features
        .map(cloneFeature)
        .filter((feature, index) => resolveFeatureIdWithGetter(feature, index, getFeatureId) !== operation.featureId),
    };
  }

  return {
    ...collection,
    features: collection.features.map((feature, index) =>
      resolveFeatureIdWithGetter(feature, index, getFeatureId) === operation.featureId
        ? cloneFeature(operation.feature)
        : cloneFeature(feature),
    ),
  };
}

export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "Point",
  coordinates: GeoJsonPosition,
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties>;
export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "LineString",
  coordinates: readonly GeoJsonPosition[],
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties>;
export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "Polygon",
  coordinates: readonly (readonly GeoJsonPosition[])[],
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties>;
export function createGeoJsonEditFeature<TProperties extends Record<string, unknown>>(
  geometryType: "Point" | "LineString" | "Polygon",
  coordinates: GeoJsonPosition | readonly GeoJsonPosition[] | readonly (readonly GeoJsonPosition[])[],
  properties: TProperties,
): TemporalGeoJsonGeometryFeature<TProperties> {
  if (geometryType === "Point") {
    return {
      geometry: {
        coordinates: clonePosition(coordinates as GeoJsonPosition),
        type: "Point",
      },
      properties: cloneProperties(properties),
      type: "Feature",
    };
  }

  if (geometryType === "LineString") {
    return {
      geometry: {
        coordinates: (coordinates as readonly GeoJsonPosition[]).map(clonePosition),
        type: "LineString",
      },
      properties: cloneProperties(properties),
      type: "Feature",
    };
  }

  return {
    geometry: {
      coordinates: (coordinates as readonly (readonly GeoJsonPosition[])[]).map((ring) => closeRing(ring)),
      type: "Polygon",
    },
    properties: cloneProperties(properties),
    type: "Feature",
  };
}

export function validateGeoJsonEditableGeometry(
  geometry: TemporalGeoJsonGeometryFeature["geometry"],
): GeoJsonEditValidationResult {
  const normalized = normalizeSupportedGeometry(geometry);

  if (!normalized) {
    return {
      reason: "Unsupported or malformed geometry.",
      valid: false,
    };
  }

  return validateSupportedGeometry(normalized);
}

export function moveGeoJsonGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
  deltaLongitude: number,
  deltaLatitude: number,
): TemporalGeoJsonSupportedGeometry {
  return mapGeometryPositions(geometry, ([longitude, latitude]) => [
    longitude + deltaLongitude,
    latitude + deltaLatitude,
  ]);
}

export function setGeoJsonVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry | null {
  if (handle.kind !== "vertex" || !isValidPosition(coordinates)) {
    return null;
  }

  const next = cloneGeometry(geometry);

  mutateVertex(next, handle, coordinates);

  if (validateSupportedGeometry(next).valid) {
    return next;
  }

  return null;
}

export function insertGeoJsonVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry | null {
  if (handle.kind !== "midpoint" || !isValidPosition(coordinates)) {
    return null;
  }

  const next = cloneGeometry(geometry);

  if (next.type === "LineString") {
    next.coordinates.splice(handle.nextVertexIndex ?? handle.vertexIndex + 1, 0, clonePosition(coordinates));
  } else if (next.type === "MultiLineString" && handle.geometryIndex !== undefined) {
    next.coordinates[handle.geometryIndex]?.splice(handle.nextVertexIndex ?? handle.vertexIndex + 1, 0, clonePosition(coordinates));
  } else if (next.type === "Polygon" && handle.ringIndex !== undefined) {
    insertRingPosition(next.coordinates[handle.ringIndex], handle, coordinates);
  } else if (next.type === "MultiPolygon" && handle.geometryIndex !== undefined && handle.ringIndex !== undefined) {
    insertRingPosition(next.coordinates[handle.geometryIndex]?.[handle.ringIndex], handle, coordinates);
  } else {
    return null;
  }

  if (validateSupportedGeometry(next).valid) {
    return next;
  }

  return null;
}

export function removeGeoJsonVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
): TemporalGeoJsonSupportedGeometry | null {
  if (handle.kind !== "vertex") {
    return null;
  }

  const next = cloneGeometry(geometry);

  if (next.type === "MultiPoint" && handle.geometryIndex !== undefined) {
    next.coordinates.splice(handle.geometryIndex, 1);
  } else if (next.type === "LineString") {
    next.coordinates.splice(handle.vertexIndex, 1);
  } else if (next.type === "MultiLineString" && handle.geometryIndex !== undefined) {
    next.coordinates[handle.geometryIndex]?.splice(handle.vertexIndex, 1);
  } else if (next.type === "Polygon" && handle.ringIndex !== undefined) {
    removeRingPosition(next.coordinates[handle.ringIndex], handle.vertexIndex);
  } else if (next.type === "MultiPolygon" && handle.geometryIndex !== undefined && handle.ringIndex !== undefined) {
    removeRingPosition(next.coordinates[handle.geometryIndex]?.[handle.ringIndex], handle.vertexIndex);
  } else {
    return null;
  }

  if (validateSupportedGeometry(next).valid) {
    return next;
  }

  return null;
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
    map: LeafletMap;
    onDragStart: (event: LeafletFeaturePointerEvent) => void;
    onSelect: () => void;
  },
) {
  layer.on("click", (event: LeafletFeaturePointerEvent = {}) => {
    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();
    options.onSelect();
  });
  layer.on("mousedown", (event: LeafletFeaturePointerEvent = {}) => {
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
  layer: LayerGroup,
  leaflet: typeof import("leaflet"),
  draft: readonly GeoJsonPosition[],
  mode: GeoJsonEditMode,
) {
  if (draft.length === 0 || (mode !== "draw-line" && mode !== "draw-polygon")) {
    return;
  }

  const latLngs = draft.map(toLeafletLatLng);

  if (mode === "draw-polygon" && draft.length >= 3) {
    leaflet.polygon([closeRing(draft).map(toLeafletLatLng)], {
      className: "mb-maps__editor-draft",
      color: "#0284c7",
      fillColor: "#38bdf8",
      fillOpacity: 0.16,
      interactive: false,
      opacity: 0.9,
      weight: 2,
    }).addTo(layer);
    return;
  }

  leaflet.polyline(latLngs, {
    className: "mb-maps__editor-draft",
    color: "#0284c7",
    interactive: false,
    opacity: 0.9,
    weight: 2,
  }).addTo(layer);
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
      handles.push(createMidpointHandle(featureId, coordinates, line[vertexIndex + 1]!, vertexIndex, {
        ...metadata,
        nextVertexIndex: vertexIndex + 1,
      }));
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
    handles.push(createMidpointHandle(
      featureId,
      coordinates,
      openRing[(vertexIndex + 1) % openRing.length]!,
      vertexIndex,
      {
        ...metadata,
        nextVertexIndex: vertexIndex + 1,
      },
    ));
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

function mutateVertex(
  geometry: TemporalGeoJsonSupportedGeometry,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
) {
  if (geometry.type === "Point") {
    geometry.coordinates = clonePosition(coordinates);
  } else if (geometry.type === "MultiPoint" && handle.geometryIndex !== undefined) {
    geometry.coordinates[handle.geometryIndex] = clonePosition(coordinates);
  } else if (geometry.type === "LineString") {
    geometry.coordinates[handle.vertexIndex] = clonePosition(coordinates);
  } else if (geometry.type === "MultiLineString" && handle.geometryIndex !== undefined) {
    geometry.coordinates[handle.geometryIndex]![handle.vertexIndex] = clonePosition(coordinates);
  } else if (geometry.type === "Polygon" && handle.ringIndex !== undefined) {
    setRingPosition(geometry.coordinates[handle.ringIndex], handle.vertexIndex, coordinates);
  } else if (geometry.type === "MultiPolygon" && handle.geometryIndex !== undefined && handle.ringIndex !== undefined) {
    setRingPosition(geometry.coordinates[handle.geometryIndex]?.[handle.ringIndex], handle.vertexIndex, coordinates);
  }
}

function setRingPosition(
  ring: GeoJsonPosition[] | undefined,
  vertexIndex: number,
  coordinates: GeoJsonPosition,
) {
  if (!ring) {
    return;
  }

  const openRing = removeClosingPosition(ring);

  openRing[vertexIndex] = clonePosition(coordinates);
  ring.splice(0, ring.length, ...closeRing(openRing));
}

function insertRingPosition(
  ring: GeoJsonPosition[] | undefined,
  handle: GeoJsonVertexHandle,
  coordinates: GeoJsonPosition,
) {
  if (!ring) {
    return;
  }

  const openRing = removeClosingPosition(ring);
  const insertIndex = Math.min(openRing.length, handle.nextVertexIndex ?? handle.vertexIndex + 1);

  openRing.splice(insertIndex, 0, clonePosition(coordinates));
  ring.splice(0, ring.length, ...closeRing(openRing));
}

function removeRingPosition(ring: GeoJsonPosition[] | undefined, vertexIndex: number) {
  if (!ring) {
    return;
  }

  const openRing = removeClosingPosition(ring);

  openRing.splice(vertexIndex, 1);
  ring.splice(0, ring.length, ...closeRing(openRing));
}

function mapGeometryPositions(
  geometry: TemporalGeoJsonSupportedGeometry,
  transform: (position: GeoJsonPosition) => GeoJsonPosition,
): TemporalGeoJsonSupportedGeometry {
  switch (geometry.type) {
    case "Point":
      return {
        coordinates: transform(geometry.coordinates),
        type: "Point",
      };
    case "MultiPoint":
      return {
        coordinates: geometry.coordinates.map(transform),
        type: "MultiPoint",
      };
    case "LineString":
      return {
        coordinates: geometry.coordinates.map(transform),
        type: "LineString",
      };
    case "MultiLineString":
      return {
        coordinates: geometry.coordinates.map((line) => line.map(transform)),
        type: "MultiLineString",
      };
    case "Polygon":
      return {
        coordinates: geometry.coordinates.map((ring) => ring.map(transform)),
        type: "Polygon",
      };
    case "MultiPolygon":
      return {
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(transform)),
        ),
        type: "MultiPolygon",
      };
  }
}

function validateOperation<TProperties extends Record<string, unknown>>(
  operation: Extract<GeoJsonEditOperation<TProperties>, { type: "create" | "update" }>,
  validateEdit: GeoJsonEditorLayerProps<TProperties>["validateEdit"],
) {
  const baseValidation = validateGeoJsonEditableGeometry(operation.feature.geometry);

  if (!baseValidation.valid) {
    return baseValidation;
  }

  return validateEdit?.(operation.feature, operation) ?? baseValidation;
}

function validateSupportedGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
): GeoJsonEditValidationResult {
  const positionsValid = getAllPositions(geometry).every(isValidPosition);

  if (!positionsValid) {
    return {
      reason: "Geometry contains non-finite coordinates.",
      valid: false,
    };
  }

  switch (geometry.type) {
    case "Point":
      return { valid: true };
    case "MultiPoint":
      return geometry.coordinates.length > 0
        ? { valid: true }
        : { reason: "MultiPoint must contain at least one point.", valid: false };
    case "LineString":
      return geometry.coordinates.length >= 2
        ? { valid: true }
        : { reason: "LineString must contain at least two coordinates.", valid: false };
    case "MultiLineString":
      return geometry.coordinates.length > 0 && geometry.coordinates.every((line) => line.length >= 2)
        ? { valid: true }
        : { reason: "MultiLineString lines must contain at least two coordinates.", valid: false };
    case "Polygon":
      return validatePolygonCoordinates(geometry.coordinates);
    case "MultiPolygon":
      if (geometry.coordinates.length === 0) {
        return { reason: "MultiPolygon must contain at least one polygon.", valid: false };
      }

      for (const polygon of geometry.coordinates) {
        const validation = validatePolygonCoordinates(polygon);

        if (!validation.valid) {
          return validation;
        }
      }

      return { valid: true };
  }
}

function validatePolygonCoordinates(coordinates: readonly (readonly GeoJsonPosition[])[]) {
  if (coordinates.length === 0) {
    return {
      reason: "Polygon must contain at least one ring.",
      valid: false,
    };
  }

  for (const ring of coordinates) {
    if (countDistinctPositions(removeClosingPosition(ring)) < 3) {
      return {
        reason: "Polygon rings must contain at least three distinct coordinates.",
        valid: false,
      };
    }

    if (!isClosedRing(ring)) {
      return {
        reason: "Polygon rings must be closed.",
        valid: false,
      };
    }
  }

  return { valid: true };
}

function getAllPositions(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
      return geometry.coordinates;
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
      return geometry.coordinates.flat();
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
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

function resolveFeatureId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
) {
  return String(feature.id ?? feature.properties?.id ?? feature.properties?.trackId ?? `feature-${index}`);
}

function resolveFeatureIdWithGetter<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
  index: number,
  getFeatureId?: (feature: TemporalGeoJsonGeometryFeature<TProperties>, index: number) => string,
) {
  return getFeatureId?.(feature, index) ?? resolveFeatureId(feature, index);
}

function cloneFeature<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeature<TProperties>,
): TemporalGeoJsonGeometryFeature<TProperties> {
  const normalized = normalizeSupportedGeometry(feature.geometry);

  return {
    ...feature,
    geometry: normalized ? cloneGeometry(normalized) : feature.geometry,
    properties: feature.properties ? cloneProperties(feature.properties) : feature.properties,
  };
}

function cloneProperties<TProperties extends Record<string, unknown>>(properties: TProperties): TProperties {
  return { ...properties };
}

function getEventCoordinate(
  map: LeafletMap & {
    containerPointToLatLng?: (point: [number, number]) => { lat: number; lng: number };
  },
  event: LeafletFeaturePointerEvent,
): GeoJsonPosition | null {
  if (event.latlng) {
    return [event.latlng.lng, event.latlng.lat];
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

function removeClosingPosition(ring: readonly GeoJsonPosition[]) {
  if (ring.length >= 2 && samePosition(ring[0]!, ring.at(-1)!)) {
    return ring.slice(0, -1).map(clonePosition);
  }

  return ring.map(clonePosition);
}

function isClosedRing(ring: readonly GeoJsonPosition[]) {
  return ring.length >= 4 && samePosition(ring[0]!, ring.at(-1)!);
}

function samePosition(left: GeoJsonPosition, right: GeoJsonPosition) {
  return left[0] === right[0] && left[1] === right[1];
}

function isValidPosition(position: readonly number[]) {
  return Number.isFinite(position[0]) && Number.isFinite(position[1]);
}
