"use client";

import { useContext, useDeferredValue, useEffect, useId, useMemo, type ReactNode } from "react";

import {
  createVisibleSvgPath,
  joinClassNames,
  toLeafletLatLng,
} from "./map-display";
import type { MapFeatureInteractionProps } from "./map-interaction";
import { MapSurfaceContext, type MapSurfaceContextValue } from "./map-view";
import { cloneGeometry, normalizeSupportedGeometry } from "./temporal-geojson-geometry";
import type {
  GeoJsonLineStringGeometry,
  GeoJsonPointGeometry,
  GeoJsonPolygonGeometry,
  GeoJsonPosition,
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

export type GeoJsonLayerProps<TProperties extends Record<string, unknown> = Record<string, unknown>> =
  MapFeatureInteractionProps<GeoJsonLayerFeature<TProperties>> &
    GeoJsonLayerStyle & {
      featureCollection: TemporalGeoJsonGeometryFeatureCollection<TProperties>;
      getFeatureStyle?: (feature: GeoJsonLayerFeature<TProperties>) => GeoJsonLayerStyle;
      layerId?: string;
      onFeatureSelect?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
    };

const DEFAULT_STYLE: Required<GeoJsonLayerStyle> = {
  lineColor: "#2563eb",
  lineOpacity: 0.82,
  lineWidth: 4,
  pointColor: "#0f766e",
  pointRadius: 7,
  polygonFillColor: "#14b8a6",
  polygonFillOpacity: 0.22,
  polygonStrokeColor: "#0f766e",
  polygonStrokeWidth: 2,
};

export function GeoJsonLayer<TProperties extends Record<string, unknown> = Record<string, unknown>>({
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
  const deferredFeatureCollection = useDeferredValue(featureCollection);
  const features = useMemo(
    () => createGeoJsonLayerFeatures(deferredFeatureCollection),
    [deferredFeatureCollection],
  );

  useEffect(() => {
    if (!surface || surface.display !== "flat") {
      return;
    }

    return surface.registerFlatLayer(resolvedLayerId, ({ isMeasuring, layer, leaflet, map }) => {
      layer.clearLayers();

      for (const feature of features) {
        const style = resolveFeatureStyle(feature, styleProps, getFeatureStyle);
        const selected = surface.isFeatureSelected(feature, selectedFeatureId, getFeatureId);
        const hovered = surface.isFeatureHovered(feature, getFeatureId);
        const className = joinClassNames(
          "mb-maps__geojson-feature",
          hovered && "mb-maps__feature--hovered",
          selected && "mb-maps__feature--selected",
        );
        const layers = createFlatGeometryLayers(feature.geometry, {
          className,
          interactive: !isMeasuring,
          leaflet,
          selected,
          style,
        });

        for (const geometryLayer of layers) {
          if (!isMeasuring) {
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
              surface,
            });
          }

          geometryLayer.addTo(layer);
        }
      }
    });
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
    surface,
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
    const geometry = normalizeSupportedGeometry(feature.geometry);

    if (!geometry) {
      return [];
    }

    return [
      {
        geometry: cloneGeometry(geometry),
        id: String(feature.id ?? feature.properties?.id ?? feature.properties?.trackId ?? `feature-${index}`),
        properties: feature.properties ?? ({} as TProperties),
        sourceIndex: index,
      },
    ];
  });
}

function createFlatGeometryLayers(
  geometry: TemporalGeoJsonSupportedGeometry,
  options: {
    className: string;
    interactive: boolean;
    leaflet: typeof import("leaflet");
    selected: boolean;
    style: Required<GeoJsonLayerStyle>;
  },
): FlatGeometryLayer[] {
  const { className, interactive, leaflet, selected, style } = options;

  switch (geometry.type) {
    case "Point":
      return [
        leaflet.circleMarker(toLeafletLatLng(geometry.coordinates), {
          className,
          color: "#ffffff",
          fillColor: style.pointColor,
          fillOpacity: 0.94,
          interactive,
          opacity: 1,
          radius: style.pointRadius,
          weight: selected ? 3 : 2,
        }) as FlatGeometryLayer,
      ];
    case "LineString":
      return [createFlatLineLayer(leaflet, geometry, className, interactive, selected, style)];
    case "MultiLineString":
      return geometry.coordinates.map((coordinates) =>
        createFlatLineLayer(leaflet, { coordinates, type: "LineString" }, className, interactive, selected, style),
      );
    case "Polygon":
      return [createFlatPolygonLayer(leaflet, geometry, className, interactive, selected, style)];
    case "MultiPolygon":
      return geometry.coordinates.map((coordinates) =>
        createFlatPolygonLayer(leaflet, { coordinates, type: "Polygon" }, className, interactive, selected, style),
      );
  }
}

function createFlatLineLayer(
  leaflet: typeof import("leaflet"),
  geometry: GeoJsonLineStringGeometry,
  className: string,
  interactive: boolean,
  selected: boolean,
  style: Required<GeoJsonLayerStyle>,
) {
  return leaflet.polyline(geometry.coordinates.map(toLeafletLatLng), {
    className,
    color: style.lineColor,
    interactive,
    opacity: style.lineOpacity,
    weight: selected ? style.lineWidth + 1.5 : style.lineWidth,
  }) as FlatGeometryLayer;
}

function createFlatPolygonLayer(
  leaflet: typeof import("leaflet"),
  geometry: GeoJsonPolygonGeometry,
  className: string,
  interactive: boolean,
  selected: boolean,
  style: Required<GeoJsonLayerStyle>,
) {
  return leaflet.polygon(geometry.coordinates.map((ring) => ring.map(toLeafletLatLng)), {
    className,
    color: style.polygonStrokeColor,
    fillColor: style.polygonFillColor,
    fillOpacity: style.polygonFillOpacity,
    interactive,
    opacity: 0.9,
    weight: selected ? style.polygonStrokeWidth + 1.5 : style.polygonStrokeWidth,
  }) as FlatGeometryLayer;
}

function renderGlobeGeometry(
  geometry: TemporalGeoJsonSupportedGeometry,
  style: Required<GeoJsonLayerStyle>,
  selected: boolean,
) {
  switch (geometry.type) {
    case "Point":
      return <GlobePoint geometry={geometry} style={style} selected={selected} />;
    case "LineString":
      return <GlobeLine geometry={geometry} style={style} selected={selected} />;
    case "MultiLineString":
      return (
        <>
          {geometry.coordinates.map((coordinates, index) => (
            <GlobeLine geometry={{ coordinates, type: "LineString" }} key={index} selected={selected} style={style} />
          ))}
        </>
      );
    case "Polygon":
      return <GlobePolygon geometry={geometry} selected={selected} style={style} />;
    case "MultiPolygon":
      return (
        <>
          {geometry.coordinates.map((coordinates, index) => (
            <GlobePolygon geometry={{ coordinates, type: "Polygon" }} key={index} selected={selected} style={style} />
          ))}
        </>
      );
  }
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
    ? createVisibleSvgPath(geometry.coordinates.map((coordinate) => surface.projectGlobeCoordinate(coordinate, surface.viewState)))
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
    .map((ring) => createVisibleSvgPath(ring.map((coordinate) => surface.projectGlobeCoordinate(coordinate, surface.viewState))))
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

function bindFlatLayerInteraction<TProperties extends Record<string, unknown>>(
  layer: FlatGeometryLayer,
  options: {
    feature: GeoJsonLayerFeature<TProperties>;
    getPosition: (event: LeafletFeaturePointerEvent) => { x: number; y: number };
    map: { getContainer: () => { style: { cursor: string } } };
    onFeatureContextMenu?: (feature: GeoJsonLayerFeature<TProperties>) => void;
    onFeatureHover?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
    onFeatureSelect?: (feature: GeoJsonLayerFeature<TProperties> | null) => void;
    renderFeatureContextMenu?: (
      feature: GeoJsonLayerFeature<TProperties>,
      context: import("./map-interaction").MapFeatureContextMenuContext<GeoJsonLayerFeature<TProperties>>,
    ) => ReactNode;
    renderFeaturePopup?: (feature: GeoJsonLayerFeature<TProperties>) => ReactNode;
    renderFeatureTooltip?: (feature: GeoJsonLayerFeature<TProperties>) => ReactNode;
    surface: MapSurfaceContextValue;
  },
) {
  layer.on("click", (event: LeafletFeaturePointerEvent = {}) => {
    options.surface.handleFeatureClick(options.feature, options.getPosition(event), {
      onFeatureSelect: options.onFeatureSelect,
      renderFeaturePopup: options.renderFeaturePopup,
    });
  });
  layer.on("contextmenu", (event: LeafletFeaturePointerEvent = {}) => {
    suppressNativeContextMenu(event);
    options.surface.handleFeatureContextMenu(options.feature, options.getPosition(event), {
      coordinates: getGeometryCenter(options.feature.geometry),
      onFeatureContextMenu: options.onFeatureContextMenu,
      onFeatureSelect: options.onFeatureSelect,
      renderFeatureContextMenu: options.renderFeatureContextMenu,
      renderFeaturePopup: options.renderFeaturePopup,
    });
  });
  layer.on("mouseover", (event: LeafletFeaturePointerEvent = {}) => {
    options.map.getContainer().style.cursor = "pointer";
    options.surface.handleFeatureHover(options.feature, options.getPosition(event), {
      onFeatureHover: options.onFeatureHover,
      renderFeatureTooltip: options.renderFeatureTooltip,
    });
  });
  layer.on("mousemove", (event: LeafletFeaturePointerEvent = {}) => {
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
  event: LeafletFeaturePointerEvent,
) {
  if (event.containerPoint) {
    return event.containerPoint;
  }

  return map.latLngToContainerPoint?.(toLeafletLatLng(getGeometryCenter(geometry))) ?? { x: 0, y: 0 };
}

function projectGeometryCenter(
  geometry: TemporalGeoJsonSupportedGeometry,
  surface: MapSurfaceContextValue,
) {
  const center = getGeometryCenter(geometry);
  const projected = surface.projectGlobeCoordinate(center, surface.viewState);

  return projected.visible ? { x: projected.x, y: projected.y } : getFirstVisiblePosition(geometry, surface);
}

function getFirstVisiblePosition(
  geometry: TemporalGeoJsonSupportedGeometry,
  surface: MapSurfaceContextValue,
) {
  for (const coordinate of getGeometryPositions(geometry)) {
    const projected = surface.projectGlobeCoordinate(coordinate, surface.viewState);

    if (projected.visible) {
      return { x: projected.x, y: projected.y };
    }
  }

  return null;
}

function getGeometryCenter(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition {
  const positions = getGeometryPositions(geometry);
  const sum = positions.reduce(
    (current, position) => [current[0] + position[0], current[1] + position[1]] as GeoJsonPosition,
    [0, 0] as GeoJsonPosition,
  );

  return [sum[0] / Math.max(1, positions.length), sum[1] / Math.max(1, positions.length)];
}

function getGeometryPositions(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
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

function resolveFeatureStyle<TProperties extends Record<string, unknown>>(
  feature: GeoJsonLayerFeature<TProperties>,
  props: GeoJsonLayerStyle,
  getFeatureStyle: ((feature: GeoJsonLayerFeature<TProperties>) => GeoJsonLayerStyle) | undefined,
): Required<GeoJsonLayerStyle> {
  return {
    ...DEFAULT_STYLE,
    ...props,
    ...getFeatureStyle?.(feature),
  };
}

type FlatGeometryLayer = {
  addTo: (layer: unknown) => FlatGeometryLayer;
  on: (event: string, handler: (event?: LeafletFeaturePointerEvent) => void) => FlatGeometryLayer;
};

type LeafletFeaturePointerEvent = {
  containerPoint?: { x: number; y: number };
  originalEvent?: {
    preventDefault?: () => void;
  };
};

function suppressNativeContextMenu(event: LeafletFeaturePointerEvent) {
  event.originalEvent?.preventDefault?.();
}
