"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, useRef, type ReactNode } from "react";

import { joinClassNames, toLatLng } from "./map-display";
import {
  createFlatGeometryLayers,
  getGeometryCenter,
  resolveFeatureStyle,
  type FlatGeometryLayer,
  type FlatFeaturePointerEvent,
} from "./geojson-rendering";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext, type MapSurfaceContextValue } from "./map-view";
import { cloneGeometry, normalizeGeometryParts } from "./temporal-geojson-geometry";
import { reconcileFlatLayerEntries } from "./flat-layer-reconciler";
import type {
  TemporalGeoJsonGeometryFeatureCollection,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";

export type GeoJsonLayerFeature<TProperties = Record<string, unknown>> = {
  geometry: TemporalGeoJsonSupportedGeometry;
  id: string;
  properties: TProperties;
  sourceIndex: number;
};

export type GeoJsonLayerStyle = {
  lineColor?: string;
  lineOpacity?: number;
  lineWidth?: number;
  pointColor?: string;
  pointRadius?: number;
  polygonFillColor?: string;
  polygonFillOpacity?: number;
  polygonStrokeColor?: string;
  polygonStrokeWidth?: number;
};

export type GeoJsonLayerProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = MapFeatureInteractionProps<GeoJsonLayerFeature<TProperties>> &
  GeoJsonLayerStyle & {
    featureCollection: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
    getFeatureStyle?: (feature: GeoJsonLayerFeature<TProperties>) => GeoJsonLayerStyle;
    layerId?: string;
    onFeatureSelect?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
  };

export function GeoJsonLayer<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  featureCollection,
  getFeatureId,
  getFeatureStyle,
  hoveredFeatureId,
  layerId,
  onHoveredFeatureIdChange,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onSelectedFeatureIdChange,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
  lineColor,
  lineOpacity,
  lineWidth,
  pointColor,
  pointRadius,
  polygonFillColor,
  polygonFillOpacity,
  polygonStrokeColor,
  polygonStrokeWidth,
}: GeoJsonLayerProps<TProperties>) {
  const surface = useContext(MapSurfaceContext);
  const generatedLayerId = useId();
  const resolvedLayerId = layerId ?? `geojson-layer-${generatedLayerId}`;
  const surfaceRef = useRef(surface);
  const flatFeatureCacheRef = useRef<Map<string, FlatGeoJsonCacheEntry>>(new Map());
  const deferredFeatureCollection = useDeferredValue(featureCollection);
  const features = useMemo(
    () => createGeoJsonLayerFeatures(deferredFeatureCollection),
    [deferredFeatureCollection],
  );
  const styleProps = useMemo(
    () =>
      compactGeoJsonLayerStyle({
        lineColor,
        lineOpacity,
        lineWidth,
        pointColor,
        pointRadius,
        polygonFillColor,
        polygonFillOpacity,
        polygonStrokeColor,
        polygonStrokeWidth,
      }),
    [
      lineColor,
      lineOpacity,
      lineWidth,
      pointColor,
      pointRadius,
      polygonFillColor,
      polygonFillOpacity,
      polygonStrokeColor,
      polygonStrokeWidth,
    ],
  );
  const surfaceDisplay = surface?.display;
  const registerMapLibreLayer = surface?.registerMapLibreLayer;

  useEffect(() => {
    surfaceRef.current = surface;
  });

  useEffect(() => {
    if (!registerMapLibreLayer || (surfaceDisplay !== "flat" && surfaceDisplay !== "globe")) {
      flatFeatureCacheRef.current.clear();
      return;
    }

    return registerMapLibreLayer(
      resolvedLayerId,
      ({ interactionMode, layer, flat, map }) => {
        const currentSurface = surfaceRef.current;

        if (!currentSurface) {
          return;
        }

        reconcileFlatLayerEntries<FlatGeoJsonCacheEntry>({
          cache: flatFeatureCacheRef.current,
          layer,
          plans: features.map((feature) => {
            const style = resolveFeatureStyle(feature, styleProps, getFeatureStyle);
            const selected = currentSurface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
            const hovered = currentSurface.isFeatureHovered(feature, hoveredFeatureId, getFeatureId);
            const className = joinClassNames(
              "mb-maps__geojson-feature",
              hovered && "mb-maps__feature--hovered",
              selected && "mb-maps__feature--selected",
            );
            const featureKey = getFlatGeoJsonFeatureKey(feature, getFeatureId);
            const geometryKey = createFlatGeoJsonGeometryKey(feature.geometry);
            const signature = createFlatGeoJsonSignature({
              className,
              feature,
              interactionMode,
              selected,
              style,
            });

            return {
              key: featureKey,
              render: () => {
                const layers = createFlatGeometryLayers(feature.geometry, {
                  bubblingMouseEvents: false,
                  className,
                  interactive: interactionMode === "none",
                  flat,
                  selected,
                  style,
                });

                for (const geometryLayer of layers) {
                  if (interactionMode === "none") {
                    bindFlatLayerInteraction(geometryLayer, {
                      feature,
                      getFeatureId,
                      getPosition: (event) => getFlatFeaturePosition(map, feature.geometry, event),
                      map,
                      onHoveredFeatureIdChange,
                      onFeatureContextMenu,
                      onFeatureHover,
                      onFeatureSelect,
                      onSelectedFeatureIdChange,
                      renderFeatureContextMenu,
                      renderFeaturePopup,
                      renderFeatureTooltip,
                      surface: currentSurface,
                    });
                  }

                  geometryLayer.addTo(layer);
                }

                return {
                  geometryKey,
                  layers,
                  signature,
                };
              },
              signature,
              update: (entry) => {
                if (entry.geometryKey === geometryKey) {
                  return true;
                }

                const updated = updateFlatGeoJsonCachedGeometry(entry.layers, feature.geometry);

                if (updated) {
                  entry.geometryKey = geometryKey;
                }

                return updated;
              },
            };
          }),
        });
      },
      { preserveOnRender: true, renderOnViewStateChange: false },
    );
  }, [
    featureCollection,
    features,
    getFeatureId,
    getFeatureStyle,
    hoveredFeatureId,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    renderFeatureContextMenu,
    renderFeaturePopup,
    renderFeatureTooltip,
    resolvedLayerId,
    selectedFeatureId,
    styleProps,
    registerMapLibreLayer,
    surfaceDisplay,
  ]);

  return null;
}

function compactGeoJsonLayerStyle(style: GeoJsonLayerStyle) {
  return Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined),
  ) as GeoJsonLayerStyle;
}

export function createGeoJsonLayerFeatures<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
): Array<GeoJsonLayerFeature<TProperties>> {
  return collection.features.flatMap((feature, index) => {
    const parts = normalizeGeometryParts(feature.geometry);

    return parts.map((part) => ({
      geometry: cloneGeometry(part.geometry),
      id: createGeoJsonLayerFeatureId(
        feature,
        index,
        parts.length > 1 ? part.partIndex : undefined,
      ),
      properties: feature.properties ?? ({} as TProperties),
      sourceIndex: index,
    }));
  });
}

type FlatGeoJsonCacheEntry = {
  geometryKey: string;
  layers: FlatGeometryLayer[];
  signature: string;
};

function getFlatGeoJsonFeatureKey<TProperties extends Record<string, unknown>>(
  feature: GeoJsonLayerFeature<TProperties>,
  getFeatureId?: (feature: GeoJsonLayerFeature<TProperties>) => string,
) {
  return getFeatureId?.(feature) || feature.id;
}

function createFlatGeoJsonGeometryKey(geometry: TemporalGeoJsonSupportedGeometry) {
  return JSON.stringify(geometry);
}

function createFlatGeoJsonSignature<TProperties extends Record<string, unknown>>({
  className,
  feature,
  interactionMode,
  selected,
  style,
}: {
  className: string;
  feature: GeoJsonLayerFeature<TProperties>;
  interactionMode: string;
  selected: boolean;
  style: Required<GeoJsonLayerStyle>;
}) {
  return JSON.stringify({
    className,
    feature: {
      id: feature.id,
      properties: feature.properties,
      sourceIndex: feature.sourceIndex,
    },
    interactive: interactionMode === "none",
    selected,
    style,
  });
}

function updateFlatGeoJsonCachedGeometry(
  layers: FlatGeometryLayer[],
  geometry: TemporalGeoJsonSupportedGeometry,
) {
  switch (geometry.type) {
    case "Point":
      return Boolean(layers[0]?.setLatLng?.(toLatLng(geometry.coordinates)));
    case "MultiPoint":
      if (layers.length !== geometry.coordinates.length) {
        return false;
      }
      return geometry.coordinates.every((coordinates, index) =>
        Boolean(layers[index]?.setLatLng?.(toLatLng(coordinates))),
      );
    case "LineString":
      return Boolean(layers[0]?.setLatLngs?.(geometry.coordinates.map(toLatLng)));
    case "MultiLineString":
      if (layers.length !== geometry.coordinates.length) {
        return false;
      }
      return geometry.coordinates.every((coordinates, index) =>
        Boolean(layers[index]?.setLatLngs?.(coordinates.map(toLatLng))),
      );
    case "Polygon":
      return Boolean(layers[0]?.setLatLngs?.(geometry.coordinates.map((ring) => ring.map(toLatLng))));
    case "MultiPolygon":
      if (layers.length !== geometry.coordinates.length) {
        return false;
      }
      return geometry.coordinates.every((coordinates, index) =>
        Boolean(layers[index]?.setLatLngs?.(coordinates.map((ring) => ring.map(toLatLng)))),
      );
  }
}

function bindFlatLayerInteraction<TProperties extends Record<string, unknown>>(
  layer: FlatGeometryLayer,
	options: {
	    feature: GeoJsonLayerFeature<TProperties>;
	    getFeatureId?: (feature: GeoJsonLayerFeature<TProperties>) => string;
	    getPosition: (event: FlatFeaturePointerEvent) => { x: number; y: number };
	    map: { getContainer: () => { style: { cursor: string } } };
	    onHoveredFeatureIdChange?: import("./map-interaction").MapFeatureInteractionProps<
	      GeoJsonLayerFeature<TProperties>
	    >["onHoveredFeatureIdChange"];
	    onFeatureContextMenu?: (feature: GeoJsonLayerFeature<TProperties>) => void;
	    onFeatureHover?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
	    onFeatureSelect?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
	    onSelectedFeatureIdChange?: import("./map-interaction").MapFeatureInteractionProps<
	      GeoJsonLayerFeature<TProperties>
	    >["onSelectedFeatureIdChange"];
    renderFeatureContextMenu?: (
      feature: GeoJsonLayerFeature<TProperties>,
      context: import("./map-interaction").MapFeatureContextMenuContext<
        GeoJsonLayerFeature<TProperties>
      >,
    ) => ReactNode;
    renderFeaturePopup?: (feature: GeoJsonLayerFeature<TProperties>) => ReactNode;
    renderFeatureTooltip?: (feature: GeoJsonLayerFeature<TProperties>) => ReactNode;
    surface: MapSurfaceContextValue;
  },
) {
	  layer.on("click", (event: FlatFeaturePointerEvent = {}) => {
	    options.surface.handleFeatureClick(options.feature, options.getPosition(event), {
	      getFeatureId: options.getFeatureId,
	      onFeatureSelect: options.onFeatureSelect,
	      onSelectedFeatureIdChange: options.onSelectedFeatureIdChange,
	      renderFeaturePopup: options.renderFeaturePopup,
	    });
	  });
  layer.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
    suppressNativeContextMenu(event);
	    options.surface.handleFeatureContextMenu(options.feature, options.getPosition(event), {
	      coordinates: getGeometryCenter(options.feature.geometry),
	      getFeatureId: options.getFeatureId,
	      onFeatureContextMenu: options.onFeatureContextMenu,
	      onFeatureSelect: options.onFeatureSelect,
	      onSelectedFeatureIdChange: options.onSelectedFeatureIdChange,
	      renderFeatureContextMenu: options.renderFeatureContextMenu,
	      renderFeaturePopup: options.renderFeaturePopup,
	    });
  });
  layer.on("mouseover", (event: FlatFeaturePointerEvent = {}) => {
	    options.map.getContainer().style.cursor = "pointer";
	    options.surface.handleFeatureHover(options.feature, options.getPosition(event), {
	      getFeatureId: options.getFeatureId,
	      onHoveredFeatureIdChange: options.onHoveredFeatureIdChange,
	      onFeatureHover: options.onFeatureHover,
	      renderFeatureTooltip: options.renderFeatureTooltip,
	    });
	  });
	  layer.on("mousemove", (event: FlatFeaturePointerEvent = {}) => {
	    options.surface.handleFeatureHover(options.feature, options.getPosition(event), {
	      getFeatureId: options.getFeatureId,
	      onHoveredFeatureIdChange: options.onHoveredFeatureIdChange,
	      onFeatureHover: options.onFeatureHover,
	      renderFeatureTooltip: options.renderFeatureTooltip,
	    });
	  });
  layer.on("mouseout", () => {
	    options.map.getContainer().style.cursor = "";
	    options.surface.handleFeatureHover(null, null, {
	      getFeatureId: options.getFeatureId,
	      onHoveredFeatureIdChange: options.onHoveredFeatureIdChange,
	      onFeatureHover: options.onFeatureHover,
	      renderFeatureTooltip: options.renderFeatureTooltip,
	    });
  });
}

function getFlatFeaturePosition(
  map: { latLngToContainerPoint?: (latLng: [number, number]) => { x: number; y: number } },
  geometry: TemporalGeoJsonSupportedGeometry,
  event: FlatFeaturePointerEvent,
) {
  if (event.containerPoint) {
    return event.containerPoint;
  }

  return (
    map.latLngToContainerPoint?.(toLatLng(getGeometryCenter(geometry))) ?? { x: 0, y: 0 }
  );
}

function createGeoJsonLayerFeatureId<TProperties extends Record<string, unknown>>(
  feature: TemporalGeoJsonGeometryFeatureCollection<TProperties>["features"][number],
  index: number,
  partIndex?: number,
) {
  const baseId =
    feature.id ?? feature.properties?.id ?? feature.properties?.trackId ?? `feature-${index}`;

  return partIndex === undefined ? String(baseId) : `${String(baseId)}:part-${partIndex}`;
}

function suppressNativeContextMenu(event: FlatFeaturePointerEvent) {
  event.originalEvent?.preventDefault?.();
}
