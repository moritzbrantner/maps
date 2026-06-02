"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, useRef, type ReactNode } from "react";

import { createVisibleSvgPath, joinClassNames, toLatLng } from "./map-display";
import {
  createFlatGeometryLayers,
  getGeometryCenter,
  projectGeometryCenter,
  resolveFeatureStyle,
  type FlatGeometryLayer,
  type FlatFeaturePointerEvent,
} from "./geojson-rendering";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext, type MapSurfaceContextValue } from "./map-view";
import { cloneGeometry, normalizeGeometryCollection } from "./temporal-geojson-geometry";
import type {
  GeoJsonLineStringGeometry,
  GeoJsonMultiPointGeometry,
  GeoJsonPointGeometry,
  GeoJsonPolygonGeometry,
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
  layerId,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
  ...styleProps
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
  const surfaceDisplay = surface?.display;
  const registerFlatLayer = surface?.registerFlatLayer;

  useEffect(() => {
    surfaceRef.current = surface;
  });

  useEffect(() => {
    if (!registerFlatLayer || surfaceDisplay !== "flat") {
      flatFeatureCacheRef.current.clear();
      return;
    }

    return registerFlatLayer(
      resolvedLayerId,
      ({ interactionMode, layer, flat, map }) => {
        const currentSurface = surfaceRef.current;

        if (!currentSurface) {
          return;
        }

        const cache = flatFeatureCacheRef.current;
        const seen = new Set<string>();

        for (const feature of features) {
          const style = resolveFeatureStyle(feature, styleProps, getFeatureStyle);
          const selected = currentSurface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
          const hovered = currentSurface.isFeatureHovered(feature, getFeatureId);
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
          const cached = cache.get(featureKey);

          seen.add(featureKey);

          if (cached?.signature === signature) {
            if (cached.geometryKey !== geometryKey) {
              if (updateFlatGeoJsonCachedGeometry(cached.layers, feature.geometry)) {
                cached.geometryKey = geometryKey;
                continue;
              }

              removeFlatGeoJsonCacheEntry(layer, cached);
              cache.delete(featureKey);
            } else {
              continue;
            }
          } else if (cached) {
            removeFlatGeoJsonCacheEntry(layer, cached);
          }

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
                getPosition: (event) => getFlatFeaturePosition(map, feature.geometry, event),
                map,
                onFeatureContextMenu,
                onFeatureHover,
                onFeatureSelect,
                renderFeatureContextMenu,
                renderFeaturePopup,
                renderFeatureTooltip,
                surface: currentSurface,
              });
            }

            geometryLayer.addTo(layer);
          }

          cache.set(featureKey, {
            geometryKey,
            layers,
            signature,
          });
        }

        for (const [featureKey, cached] of cache) {
          if (seen.has(featureKey)) {
            continue;
          }

          removeFlatGeoJsonCacheEntry(layer, cached);
          cache.delete(featureKey);
        }
      },
      { preserveOnRender: true, renderOnViewStateChange: false },
    );
  }, [
    featureCollection,
    features,
    getFeatureId,
    getFeatureStyle,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    renderFeatureContextMenu,
    renderFeaturePopup,
    renderFeatureTooltip,
    resolvedLayerId,
    selectedFeatureId,
    styleProps,
    registerFlatLayer,
    surfaceDisplay,
  ]);

  if (!surface || surface.display !== "globe") {
    return null;
  }

  return (
    <>
      {features.map((feature) => {
        const style = resolveFeatureStyle(feature, styleProps, getFeatureStyle);
        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, getFeatureId);
        const position = projectGeometryCenter(feature.geometry, surface);

        if (!position) {
          return null;
        }

        return (
          <g
            className={joinClassNames(
              "mb-maps__globe-geojson",
              hovered && "mb-maps__feature--hovered",
              selected && "mb-maps__feature--selected",
            )}
            key={feature.id}
            onClick={(event) => {
              event.stopPropagation();
              surface.handleFeatureClick(feature, position, {
                onFeatureSelect,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
              });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              surface.handleFeatureContextMenu(feature, position, {
                coordinates: getGeometryCenter(feature.geometry),
                onFeatureContextMenu,
                onFeatureSelect,
                renderFeatureContextMenu,
                renderFeaturePopup,
                suppress: surface.isMeasuring,
              });
            }}
            onPointerEnter={() => {
              if (!surface.isMeasuring) {
                surface.handleFeatureHover(feature, position, {
                  onFeatureHover,
                  renderFeatureTooltip,
                });
              }
            }}
            onPointerLeave={() => {
              surface.handleFeatureHover(null, null, { onFeatureHover, renderFeatureTooltip });
            }}
          >
            {renderGlobeGeometry(feature.geometry, style, selected)}
          </g>
        );
      })}
    </>
  );
}

export function createGeoJsonLayerFeatures<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>(
  collection: TemporalGeoJsonGeometryFeatureCollection<TProperties>,
): Array<GeoJsonLayerFeature<TProperties>> {
  return collection.features.flatMap((feature, index) => {
    const geometries = normalizeGeometryCollection(feature.geometry);

    return geometries.map((geometry, geometryIndex) => ({
      geometry: cloneGeometry(geometry),
      id: createGeoJsonLayerFeatureId(
        feature,
        index,
        geometries.length > 1 ? geometryIndex : undefined,
      ),
      properties: feature.properties ?? ({} as TProperties),
      sourceIndex: index,
    }));
  });
}

function renderGlobeGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
  style: Required<GeoJsonLayerStyle>,
  selected: boolean,
) {
  switch (geometry.type) {
    case "Point":
      return <GlobePoint geometry={geometry} style={style} selected={selected} />;
    case "MultiPoint":
      return <GlobeMultiPoint geometry={geometry} style={style} selected={selected} />;
    case "LineString":
      return <GlobeLine geometry={geometry} style={style} selected={selected} />;
    case "MultiLineString":
      return (
        <>
          {geometry.coordinates.map((coordinates, index) => (
            <GlobeLine
              geometry={{ coordinates, type: "LineString" }}
              key={index}
              selected={selected}
              style={style}
            />
          ))}
        </>
      );
    case "Polygon":
      return <GlobePolygon geometry={geometry} selected={selected} style={style} />;
    case "MultiPolygon":
      return (
        <>
          {geometry.coordinates.map((coordinates, index) => (
            <GlobePolygon
              geometry={{ coordinates, type: "Polygon" }}
              key={index}
              selected={selected}
              style={style}
            />
          ))}
        </>
      );
  }
}

function GlobeMultiPoint({
  geometry,
  selected,
  style,
}: {
  geometry: GeoJsonMultiPointGeometry;
  selected: boolean;
  style: Required<GeoJsonLayerStyle>;
}) {
  return (
    <>
      {geometry.coordinates.map((coordinates, index) => (
        <GlobePoint
          geometry={{ coordinates, type: "Point" }}
          key={`${coordinates[0]}:${coordinates[1]}:${index}`}
          selected={selected}
          style={style}
        />
      ))}
    </>
  );
}

function GlobePoint({
  geometry,
  selected,
  style,
}: {
  geometry: GeoJsonPointGeometry;
  selected: boolean;
  style: Required<GeoJsonLayerStyle>;
}) {
  const surface = useContext(MapSurfaceContext);
  const projected = surface?.projectGlobeCoordinate(geometry.coordinates, surface.viewState);

  if (!projected?.visible) {
    return null;
  }

  return (
    <circle
      cx={projected.x}
      cy={projected.y}
      fill={style.pointColor}
      r={style.pointRadius * (0.72 + projected.scale * 0.28)}
      stroke="#ffffff"
      strokeWidth={selected ? 3 : 2}
    />
  );
}

function GlobeLine({
  geometry,
  selected,
  style,
}: {
  geometry: GeoJsonLineStringGeometry;
  selected: boolean;
  style: Required<GeoJsonLayerStyle>;
}) {
  const surface = useContext(MapSurfaceContext);
  const path = surface
    ? createVisibleSvgPath(
        geometry.coordinates.map((coordinate) =>
          surface.projectGlobeCoordinate(coordinate, surface.viewState),
        ),
      )
    : "";

  return path ? (
    <path
      d={path}
      fill="none"
      stroke={style.lineColor}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity={style.lineOpacity}
      strokeWidth={selected ? style.lineWidth + 1.5 : style.lineWidth}
    />
  ) : null;
}

function GlobePolygon({
  geometry,
  selected,
  style,
}: {
  geometry: GeoJsonPolygonGeometry;
  selected: boolean;
  style: Required<GeoJsonLayerStyle>;
}) {
  const surface = useContext(MapSurfaceContext);

  if (!surface) {
    return null;
  }

  const path = geometry.coordinates
    .map((ring) =>
      createVisibleSvgPath(
        ring.map((coordinate) => surface.projectGlobeCoordinate(coordinate, surface.viewState)),
      ),
    )
    .filter(Boolean)
    .map((ringPath) => `${ringPath}Z`)
    .join("");

  return path ? (
    <path
      d={path}
      fill={style.polygonFillColor}
      fillOpacity={style.polygonFillOpacity}
      stroke={style.polygonStrokeColor}
      strokeOpacity={0.9}
      strokeWidth={selected ? style.polygonStrokeWidth + 1.5 : style.polygonStrokeWidth}
    />
  ) : null;
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

function removeFlatGeoJsonCacheEntry(
  layer: { removeLayer: (cachedLayer: FlatGeometryLayer) => unknown },
  entry: FlatGeoJsonCacheEntry,
) {
  for (const cachedLayer of entry.layers) {
    layer.removeLayer(cachedLayer);
  }
}

function bindFlatLayerInteraction<TProperties extends Record<string, unknown>>(
  layer: FlatGeometryLayer,
  options: {
    feature: GeoJsonLayerFeature<TProperties>;
    getPosition: (event: FlatFeaturePointerEvent) => { x: number; y: number };
    map: { getContainer: () => { style: { cursor: string } } };
    onFeatureContextMenu?: (feature: GeoJsonLayerFeature<TProperties>) => void;
    onFeatureHover?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
    onFeatureSelect?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
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
      onFeatureSelect: options.onFeatureSelect,
      renderFeaturePopup: options.renderFeaturePopup,
    });
  });
  layer.on("contextmenu", (event: FlatFeaturePointerEvent = {}) => {
    suppressNativeContextMenu(event);
    options.surface.handleFeatureContextMenu(options.feature, options.getPosition(event), {
      coordinates: getGeometryCenter(options.feature.geometry),
      onFeatureContextMenu: options.onFeatureContextMenu,
      onFeatureSelect: options.onFeatureSelect,
      renderFeatureContextMenu: options.renderFeatureContextMenu,
      renderFeaturePopup: options.renderFeaturePopup,
    });
  });
  layer.on("mouseover", (event: FlatFeaturePointerEvent = {}) => {
    options.map.getContainer().style.cursor = "pointer";
    options.surface.handleFeatureHover(options.feature, options.getPosition(event), {
      onFeatureHover: options.onFeatureHover,
      renderFeatureTooltip: options.renderFeatureTooltip,
    });
  });
  layer.on("mousemove", (event: FlatFeaturePointerEvent = {}) => {
    options.surface.handleFeatureHover(options.feature, options.getPosition(event), {
      onFeatureHover: options.onFeatureHover,
      renderFeatureTooltip: options.renderFeatureTooltip,
    });
  });
  layer.on("mouseout", () => {
    options.map.getContainer().style.cursor = "";
    options.surface.handleFeatureHover(null, null, {
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
