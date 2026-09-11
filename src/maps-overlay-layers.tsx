"use client";

import {
  Children,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SVGProps,
} from "react";

import {
  GeoJsonLayer,
  createGeoJsonLayerFeatures,
  type GeoJsonLayerFeature,
  type GeoJsonLayerProps,
  type GeoJsonLayerStyle,
} from "./geojson-layer";
import { resolveFeatureStyle } from "./geojson-rendering";
import {
  PointLayer,
  createPointLayerFeatures,
  type PointLayerFeature,
  type PointLayerProps,
} from "./point-layer";
import type { TemporalGeoJsonSupportedGeometry } from "./temporal-geojson-types";

export type MapsProjectCoordinate = (
  coordinates: [longitude: number, latitude: number],
) => { x: number; y: number } | null;

type AnyRecord = Record<string, unknown>;

type MapsOverlayLayersProps = {
  children: ReactNode;
  project: MapsProjectCoordinate;
};

export function MapsOverlayLayers({ children, project }: MapsOverlayLayersProps) {
  const layers = renderChildren(children, project);

  if (layers.length === 0) {
    return null;
  }

  return (
    <svg
      aria-hidden="true"
      data-map-overlay-runtime="maps"
      style={{
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        position: "absolute",
        zIndex: 1,
      }}
      width="100%"
      height="100%"
    >
      {layers}
    </svg>
  );
}

function renderChildren(children: ReactNode, project: MapsProjectCoordinate): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) {
      if (child === null || child === undefined || child === false) {
        return [];
      }
      throwUnsupportedMapsLayer();
    }

    if (child.type === Fragment) {
      return renderChildren((child.props as { children?: ReactNode }).children, project);
    }

    if (child.type === PointLayer) {
      return [
        <MapsPointLayer
          key={child.key ?? "maps-point-layer"}
          {...(child.props as PointLayerProps<AnyRecord>)}
          project={project}
        />,
      ];
    }

    if (child.type === GeoJsonLayer) {
      return [
        <MapsGeoJsonLayer
          key={child.key ?? "maps-geojson-layer"}
          {...(child.props as GeoJsonLayerProps<AnyRecord>)}
          project={project}
        />,
      ];
    }

    throwUnsupportedMapsLayer();
  });
}

function MapsPointLayer({
  draggable,
  filterPoint,
  getPointColor,
  getPointRadius,
  hoveredFeatureId,
  onFeatureContextMenu,
  onFeatureDrag,
  onFeatureDragEnd,
  onFeatureHover,
  onFeatureSelect,
  onHoveredFeatureIdChange,
  onSelectedFeatureIdChange,
  points,
  pointColor = "#0f172a",
  pointRadius = 6,
  project,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
  getFeatureId,
}: PointLayerProps<AnyRecord> & { project: MapsProjectCoordinate }) {
  assertNoUnsupportedPointInteractions({
    draggable,
    onFeatureContextMenu,
    onFeatureDrag,
    onFeatureDragEnd,
    onFeatureHover,
    onFeatureSelect,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    renderFeatureContextMenu,
    renderFeaturePopup,
    renderFeatureTooltip,
  });

  return createPointLayerFeatures(points, { filterPoint }).flatMap((feature) => {
    const position = project(feature.coordinates);
    if (!position) return [];
    const featureId = getFeatureId?.(feature) || feature.point.id;
    const hovered = Boolean(hoveredFeatureId && hoveredFeatureId === featureId);
    const selected = Boolean(selectedFeatureId && selectedFeatureId === featureId);
    const radius = Math.max(0, getPointRadius?.(feature) ?? pointRadius);

    return [
      <circle
        key={featureId}
        className={mapsFeatureClassName("mb-maps__point-marker", hovered, selected)}
        cx={position.x}
        cy={position.y}
        data-map-feature-id={featureId}
        fill={getPointColor?.(feature) ?? pointColor}
        fillOpacity={0.92}
        r={radius}
        stroke="#ffffff"
        strokeWidth={selected ? 3 : 2}
      />,
    ];
  });
}

function MapsGeoJsonLayer({
  featureCollection,
  getFeatureId,
  getFeatureStyle,
  hoveredFeatureId,
  isFeatureInteractive,
  lineColor,
  lineOpacity,
  lineWidth,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onHoveredFeatureIdChange,
  onSelectedFeatureIdChange,
  pointColor,
  pointRadius,
  polygonFillColor,
  polygonFillOpacity,
  polygonStrokeColor,
  polygonStrokeWidth,
  project,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  selectedFeatureId,
}: GeoJsonLayerProps<AnyRecord> & { project: MapsProjectCoordinate }) {
  assertNoUnsupportedGeoJsonInteractions({
    isFeatureInteractive,
    onFeatureContextMenu,
    onFeatureHover,
    onFeatureSelect,
    onHoveredFeatureIdChange,
    onSelectedFeatureIdChange,
    renderFeatureContextMenu,
    renderFeaturePopup,
    renderFeatureTooltip,
  });

  const baseStyle: GeoJsonLayerStyle = compactStyle({
    lineColor,
    lineOpacity,
    lineWidth,
    pointColor,
    pointRadius,
    polygonFillColor,
    polygonFillOpacity,
    polygonStrokeColor,
    polygonStrokeWidth,
  });

  return createGeoJsonLayerFeatures(featureCollection).flatMap((feature) => {
    const featureId = getFeatureId?.(feature) || feature.id;
    const hovered = Boolean(hoveredFeatureId && hoveredFeatureId === featureId);
    const selected = Boolean(selectedFeatureId && selectedFeatureId === featureId);
    const style = resolveFeatureStyle(feature, baseStyle, getFeatureStyle);

    return renderGeometry(feature, featureId, style, hovered, selected, project);
  });
}

function renderGeometry(
  feature: GeoJsonLayerFeature<AnyRecord>,
  featureId: string,
  style: Required<GeoJsonLayerStyle>,
  hovered: boolean,
  selected: boolean,
  project: MapsProjectCoordinate,
): ReactNode[] {
  const common = {
    className: mapsFeatureClassName("mb-maps__geojson-feature", hovered, selected),
    "data-map-feature-id": featureId,
  } satisfies SVGProps<SVGElement>;
  const geometry = feature.geometry;

  switch (geometry.type) {
    case "Point":
      return renderGeoJsonPoint(geometry.coordinates, featureId, style, selected, project, common);
    case "MultiPoint":
      return geometry.coordinates.flatMap((coordinates, index) =>
        renderGeoJsonPoint(coordinates, `${featureId}:${index}`, style, selected, project, common),
      );
    case "LineString":
      return renderLine(geometry, featureId, style, selected, project, common);
    case "MultiLineString":
      return geometry.coordinates.flatMap((coordinates, index) =>
        renderLine(
          { coordinates, type: "LineString" },
          `${featureId}:${index}`,
          style,
          selected,
          project,
          common,
        ),
      );
    case "Polygon":
      return renderPolygon(geometry, featureId, style, selected, project, common);
    case "MultiPolygon":
      return geometry.coordinates.flatMap((coordinates, index) =>
        renderPolygon(
          { coordinates, type: "Polygon" },
          `${featureId}:${index}`,
          style,
          selected,
          project,
          common,
        ),
      );
  }
}

function renderGeoJsonPoint(
  coordinates: [number, number],
  key: string,
  style: Required<GeoJsonLayerStyle>,
  selected: boolean,
  project: MapsProjectCoordinate,
  common: SVGProps<SVGElement>,
): ReactNode[] {
  const position = project(coordinates);
  if (!position) return [];

  return [
    <circle
      {...common}
      key={key}
      cx={position.x}
      cy={position.y}
      fill={style.pointColor}
      fillOpacity={0.94}
      r={style.pointRadius}
      stroke="#ffffff"
      strokeWidth={selected ? 3 : 2}
    />,
  ];
}

function renderLine(
  geometry: Extract<TemporalGeoJsonSupportedGeometry, { type: "LineString" }>,
  key: string,
  style: Required<GeoJsonLayerStyle>,
  selected: boolean,
  project: MapsProjectCoordinate,
  common: SVGProps<SVGElement>,
): ReactNode[] {
  const path = projectPath(geometry.coordinates, project, false);
  if (!path) return [];

  return [
    <path
      {...common}
      key={key}
      d={path}
      fill="none"
      stroke={style.lineColor}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity={style.lineOpacity}
      strokeWidth={selected ? style.lineWidth + 1.5 : style.lineWidth}
    />,
  ];
}

function renderPolygon(
  geometry: Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>,
  key: string,
  style: Required<GeoJsonLayerStyle>,
  selected: boolean,
  project: MapsProjectCoordinate,
  common: SVGProps<SVGElement>,
): ReactNode[] {
  const paths = geometry.coordinates.map((ring) => projectPath(ring, project, true));
  if (paths.some((path) => !path)) return [];

  return [
    <path
      {...common}
      key={key}
      d={paths.join(" ")}
      fill={style.polygonFillColor}
      fillOpacity={style.polygonFillOpacity}
      fillRule="evenodd"
      stroke={style.polygonStrokeColor}
      strokeOpacity={0.9}
      strokeWidth={selected ? style.polygonStrokeWidth + 1.5 : style.polygonStrokeWidth}
    />,
  ];
}

function projectPath(
  coordinates: readonly [number, number][],
  project: MapsProjectCoordinate,
  close: boolean,
) {
  const points = coordinates.map(project);
  if (points.some((point) => !point) || points.length === 0) return null;
  const [first, ...rest] = points as Array<{ x: number; y: number }>;
  const commands = [`M ${first.x} ${first.y}`];

  for (const point of rest) {
    commands.push(`L ${point.x} ${point.y}`);
  }
  if (close) commands.push("Z");

  return commands.join(" ");
}

function mapsFeatureClassName(base: string, hovered: boolean, selected: boolean) {
  return [
    base,
    hovered ? "mb-maps__feature--hovered" : null,
    selected ? "mb-maps__feature--selected" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function compactStyle(style: GeoJsonLayerStyle): GeoJsonLayerStyle {
  return Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined),
  ) as GeoJsonLayerStyle;
}

function assertNoUnsupportedPointInteractions(
  props: Pick<
    PointLayerProps<AnyRecord>,
    | "draggable"
    | "onFeatureContextMenu"
    | "onFeatureDrag"
    | "onFeatureDragEnd"
    | "onFeatureHover"
    | "onFeatureSelect"
    | "onHoveredFeatureIdChange"
    | "onSelectedFeatureIdChange"
    | "renderFeatureContextMenu"
    | "renderFeaturePopup"
    | "renderFeatureTooltip"
  >,
) {
  if (Object.values(props).some(Boolean)) {
    throw new Error(
      'flatRuntime="maps" point overlays are display-only in this slice; interactive or draggable point contracts remain explicit until the Maps interaction overlay slice.',
    );
  }
}

function assertNoUnsupportedGeoJsonInteractions(
  props: Pick<
    GeoJsonLayerProps<AnyRecord>,
    | "isFeatureInteractive"
    | "onFeatureContextMenu"
    | "onFeatureHover"
    | "onFeatureSelect"
    | "onHoveredFeatureIdChange"
    | "onSelectedFeatureIdChange"
    | "renderFeatureContextMenu"
    | "renderFeaturePopup"
    | "renderFeatureTooltip"
  >,
) {
  if (Object.values(props).some(Boolean)) {
    throw new Error(
      'flatRuntime="maps" GeoJSON overlays are display-only in this slice; interactive GeoJSON contracts remain explicit until the Maps interaction overlay slice.',
    );
  }
}

function throwUnsupportedMapsLayer(): never {
  throw new Error(
    'flatRuntime="maps" currently supports PointLayer and GeoJsonLayer only; other map layer types remain explicitly MapLibre-backed.',
  );
}
