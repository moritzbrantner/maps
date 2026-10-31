"use client";

import type { MapsTileset } from "./maps-tileset";
import type { MapsVectorBasemapStyle } from "./maps-tileset-style";

import { useEffect } from "react";

import { ensureMapsAggregationWasm } from "./aggregation-runtime";
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
  /** One active versioned MVT source, supported by flatRuntime="maps" only. */
  tileset?: MapsTileset;
  tilesetStyle?: MapsVectorBasemapStyle;
  /** Existing Rust request/decoded-resource budgets, shared across source revisions. */
  tileLimits?: import("./flat-runtime-wasm").MapsFlatRasterRuntimeConfig["limits"];
};

export function MapView(props: MapViewProps) {
  const flatRuntime = props.flatRuntime ?? "maplibre";
  const mapDisplay = props.mapDisplay ?? "flat";

  // Map Views own starting the Rust clustering runtime; layers rebuild their indexes when it is ready.
  useEffect(() => {
    void ensureMapsAggregationWasm();
  }, []);

  if (String(flatRuntime) === "webgl") {
    throw new Error(
      'flatRuntime="webgl" was retired; use flatRuntime="maps" with an explicit raster tile style. MapLibre-specific styles and interactions still require flatRuntime="maplibre".',
    );
  }

  if (mapDisplay === "flat" && flatRuntime === "maps") {
    return <MapsMapView {...props} flatRuntime="maps" mapDisplay="flat" />;
  }

  if (props.tileset) throw new Error('Maps Tileset requires flatRuntime="maps" on a Flat Map.');

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
