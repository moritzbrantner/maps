import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

import type {
  GeoJsonEditMode,
  GeoJsonEditorSelection,
  MapBeeLineMeasurement,
  MapBeeLineMeasurementDraft,
  MapPoint,
  MapSurfaceController,
  MapViewState,
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "@moritzbrantner/maps";

import { demoFlows } from "../data/demo-flows";
import { demoGeoJsonCollection } from "../data/demo-geojson";
import { demoPointHubs, demoPoints } from "../data/demo-points";
import type { DemoGeoJsonProperties, DemoPointProperties, DemoView } from "../types";
import { getDemoFeatureId } from "./geojson-features";

type DemoE2EProbe = {
  activeView: () => DemoView;
  getEditMode: () => GeoJsonEditMode;
  getFeatureCount: () => number;
  getFlowMidpoint: (id: string) => [number, number] | null;
  getGeoJsonFeatureCenter: (id: string) => [number, number] | null;
  getGeoJsonSelection: () => GeoJsonEditorSelection;
  getMapDisplay: () => "flat" | "globe" | null;
  getMapProjection: () => string | null;
  getMeasurementDraft: () => MapBeeLineMeasurementDraft | null;
  getMeasurementCount: () => number;
  getPointCoordinate: (id: string) => [number, number] | null;
  getSelectedFlowId: () => string | null;
  getSelectedPointId: () => string | null;
  getViewState: () => MapViewState | null;
  isMapIdle: () => boolean | null;
  project: (coordinate: [number, number]) => { x: number; y: number } | null;
  unproject: (point: { x: number; y: number }) => [number, number] | null;
};

export type DemoE2ERegistration = {
  onMapControllerReady?: (controller: MapSurfaceController) => void;
  onMapReady?: (map: MapLibreMap) => void;
};

declare global {
  interface Window {
    __mbMapsDemo?: DemoE2EProbe;
    __mbMapsDemoMap?: MapLibreMap;
  }
}

function isDemoE2EEnabled() {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("e2e");
}

type DemoE2EProbeState = {
  editMode: GeoJsonEditMode;
  editableGeoJson: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>;
  geoJsonSelection: GeoJsonEditorSelection;
  measurementDraft: MapBeeLineMeasurementDraft | null;
  measurements: MapBeeLineMeasurement[];
  selectedFlowId: string | null;
  selectedPointId: string | null;
  view: DemoView;
  viewport: MapViewState;
  visibleEditablePoints: Array<MapPoint<DemoPointProperties>>;
  visiblePoints: Array<MapPoint<DemoPointProperties>>;
};

/** Publishes `window.__mbMapsDemo` under `?e2e` and returns the map registration callbacks. */
export function useDemoE2EProbe({
  editMode,
  editableGeoJson,
  geoJsonSelection,
  measurementDraft,
  measurements,
  selectedFlowId,
  selectedPointId,
  view,
  viewport,
  visibleEditablePoints,
  visiblePoints,
}: DemoE2EProbeState) {
  const e2eEnabled = isDemoE2EEnabled();
  const e2eMapRef = useRef<MapLibreMap | null>(null);
  const e2eControllerRef = useRef<MapSurfaceController | null>(null);
  const registerE2EMap = useCallback(
    (map: MapLibreMap) => {
      if (!e2eEnabled || typeof window === "undefined") {
        return;
      }

      e2eMapRef.current = map;
      window.__mbMapsDemoMap = map;
    },
    [e2eEnabled],
  );
  const registerE2EController = useCallback(
    (controller: MapSurfaceController) => {
      if (!e2eEnabled) {
        return;
      }

      e2eControllerRef.current = controller;
    },
    [e2eEnabled],
  );
  const e2eRegistration = useMemo<DemoE2ERegistration>(
    () =>
      e2eEnabled
        ? {
            onMapControllerReady: registerE2EController,
            onMapReady: registerE2EMap,
          }
        : {},
    [e2eEnabled, registerE2EController, registerE2EMap],
  );

  useEffect(() => {
    if (!e2eEnabled || typeof window === "undefined") {
      return;
    }

    const probe: DemoE2EProbe = {
      activeView: () => view,
      getEditMode: () => editMode,
      getFeatureCount: () => editableGeoJson.features.length,
      getFlowMidpoint: (id) => getDemoFlowMidpoint(id),
      getGeoJsonFeatureCenter: (id) =>
        getDemoGeometryCenter(
          getDemoGeoJsonFeatureByProbeId(editableGeoJson, id)?.geometry ?? null,
        ) ??
        getDemoGeometryCenter(
          getDemoGeoJsonFeatureByProbeId(demoGeoJsonCollection, id)?.geometry ?? null,
        ),
      getGeoJsonSelection: () => geoJsonSelection,
      getMapDisplay: () => e2eControllerRef.current?.display ?? null,
      getMapProjection: () => {
        try {
          return e2eMapRef.current?.getProjection?.().type ?? null;
        } catch {
          // After a view switch the previous map is removed until the next one registers.
          return null;
        }
      },
      getMeasurementDraft: () => measurementDraft,
      getMeasurementCount: () => measurements.length,
      getPointCoordinate: (id) => getDemoPointCoordinate(id, visibleEditablePoints, visiblePoints),
      getSelectedFlowId: () => selectedFlowId,
      getSelectedPointId: () => selectedPointId,
      getViewState: () => e2eControllerRef.current?.getViewState() ?? viewport ?? null,
      isMapIdle: () => {
        const map = e2eMapRef.current;

        if (!map) {
          return null;
        }

        return map.idle?.() === true || (map.loaded?.() === true && map.isMoving?.() !== true);
      },
      project: (coordinate) => {
        const point = e2eMapRef.current?.project?.(coordinate);

        if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
          return null;
        }

        return { x: point.x, y: point.y };
      },
      unproject: (point) => {
        const lngLat = e2eMapRef.current?.unproject?.([point.x, point.y]);

        if (!lngLat || typeof lngLat.lng !== "number" || typeof lngLat.lat !== "number") {
          return null;
        }

        return [lngLat.lng, lngLat.lat];
      },
    };

    window.__mbMapsDemo = probe;

    return () => {
      if (window.__mbMapsDemo === probe) {
        delete window.__mbMapsDemo;
      }
    };
  }, [
    e2eEnabled,
    editMode,
    editableGeoJson,
    geoJsonSelection,
    measurementDraft,
    measurements.length,
    selectedFlowId,
    selectedPointId,
    view,
    viewport,
    visibleEditablePoints,
    visiblePoints,
  ]);

  return e2eRegistration;
}

function getDemoGeoJsonFeatureByProbeId(
  collection: TemporalGeoJsonGeometryFeatureCollection<DemoGeoJsonProperties>,
  featureId: string | null,
) {
  if (!featureId) {
    return null;
  }

  return (
    collection.features.find(
      (feature, index) =>
        getDemoFeatureId(feature, index) === featureId || feature.properties?.trackId === featureId,
    ) ?? null
  );
}

function getDemoPointCoordinate(
  id: string,
  editablePoints: Array<MapPoint<DemoPointProperties>>,
  datasetPoints: Array<MapPoint<DemoPointProperties>>,
): [number, number] | null {
  const point = [...editablePoints, ...datasetPoints, ...demoPointHubs, ...demoPoints].find(
    (item) => String(item.id) === id,
  );

  if (!point) {
    return null;
  }

  return [point.longitude, point.latitude];
}

function getDemoFlowMidpoint(id: string): [number, number] | null {
  const flow = demoFlows.find((item) => item.id === id);

  if (!flow) {
    return null;
  }

  return [(flow.from[0] + flow.to[0]) / 2, (flow.from[1] + flow.to[1]) / 2];
}

function getDemoGeometryCenter(
  geometry: TemporalGeoJsonSupportedGeometry | null,
): [number, number] | null {
  if (!geometry) {
    return null;
  }

  const coordinates = getDemoGeometryCoordinates(geometry);

  if (coordinates.length === 0) {
    return null;
  }

  const [longitudeTotal, latitudeTotal] = coordinates.reduce(
    ([longitudeSum, latitudeSum], [longitude, latitude]) => [
      longitudeSum + longitude,
      latitudeSum + latitude,
    ],
    [0, 0],
  );

  return [longitudeTotal / coordinates.length, latitudeTotal / coordinates.length];
}

function getDemoGeometryCoordinates(
  geometry: TemporalGeoJsonSupportedGeometry,
): Array<[number, number]> {
  const values: Array<[number, number]> = [];

  collectDemoCoordinates(geometry.coordinates, values);

  return values;
}

function collectDemoCoordinates(value: unknown, target: Array<[number, number]>) {
  if (!Array.isArray(value)) {
    return;
  }

  if (typeof value[0] === "number" && typeof value[1] === "number") {
    target.push([value[0], value[1]]);
    return;
  }

  for (const item of value) {
    collectDemoCoordinates(item, target);
  }
}
