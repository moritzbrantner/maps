"use client";

import {
  MapView as LegacyMapView,
  type FlatMapRuntime as LegacyFlatMapRuntime,
  type MapViewProps as LegacyMapViewProps,
} from "./map-view-maplibre";
import { MapsMapView } from "./maps-map-view";

export {
  MapSurfaceContext,
  type MapInteractionMode,
  type MapLibreLayerRegistrationOptions,
  type MapLibreLayerRender,
  type MapSurfaceContextValue,
} from "./map-view-maplibre";

export type FlatMapRuntime = LegacyFlatMapRuntime | "maps";

export type MapViewProps = Omit<LegacyMapViewProps, "flatRuntime"> & {
  flatRuntime?: FlatMapRuntime;
};

export function MapView(props: MapViewProps) {
  const flatRuntime = props.flatRuntime ?? "maplibre";
  const mapDisplay = props.mapDisplay ?? "flat";

  if (mapDisplay === "flat" && flatRuntime === "maps") {
    return <MapsMapView {...props} flatRuntime="maps" mapDisplay="flat" />;
  }

  const legacyFlatRuntime: LegacyFlatMapRuntime =
    flatRuntime === "maps" ? "maplibre" : flatRuntime;

  return <LegacyMapView {...props} flatRuntime={legacyFlatRuntime} mapDisplay={mapDisplay} />;
}

export type {
  MapBounds,
  MapSurfaceController,
  MapViewStateChangeContext,
  MapViewStateChangeReason,
  MapViewportProps,
} from "./map-view-maplibre";
