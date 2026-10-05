"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type {
  TimelineEditorSelection,
  TimelineEditorSnapOptions,
  TimelineEditorViewport,
} from "@moritzbrantner/timeline-editor";

import {
  GeoJsonEditorLayer,
  type GeoJsonEditMode,
  type GeoJsonEditorLayerProps,
} from "./geojson-editor";
import { type GeoJsonLayerStyle } from "./geojson-layer";
import { getBoundsFromGeoJson, type GeoJsonMapSource } from "./geojson-source";
import {
  GeoJsonTimelineEditor,
  createGeoJsonTimelineDocument,
  getGeoJsonTimelineFeatureCollectionAtTime,
  type GeoJsonTimelineDocument,
} from "./geojson-timeline";
import {
  defaultRasterMapStyle,
  joinClassNames,
  type MapDisplayMode,
  type MapSurfaceController,
  type MapViewState,
  type MapViewportProps,
  type RasterMapStyle,
} from "./map-display";
import type { MapContextMenuContext } from "./map-interaction";
import { MapView } from "./map-view";
import type { MapMeasurementProps } from "./measurement";
import { BeeLineMeasurementLayer } from "./measurement-map-layer";

// EditableGeoJsonMap integrates the optional @moritzbrantner/timeline-editor peer, so it lives
// apart from GeoJsonEditorLayer and is exported only from the editor subpath, keeping the root
// entry bundleable without the peer.

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
    /**
     * @deprecated Use `defaultViewState` for an uncontrolled initial viewport.
     */
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
  const handleEditorMapReady = useCallback(
    (map: MapLibreMap) => {
      map.boxZoom?.disable();
      onMapReady?.(map);
    },
    [onMapReady],
  );
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
      initialViewState={initialViewState}
      mapDisplay={mapDisplay}
      mapLabel={mapLabel}
      mapStyle={mapStyle}
      maxBounds={maxBounds}
      maxZoom={maxZoom}
      onMapControllerReady={onMapControllerReady}
      onMapContextMenu={onMapContextMenu}
      onMapReady={handleEditorMapReady}
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
