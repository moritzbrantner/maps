"use client";

import {
  Children,
  Fragment,
  isValidElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import {
  GeoJsonLayer,
  createGeoJsonLayerFeatures,
  type GeoJsonLayerFeature,
  type GeoJsonLayerProps,
  type GeoJsonLayerStyle,
} from "./geojson-layer";
import { getGeometryCenter, resolveFeatureStyle } from "./geojson-rendering";
import type { MapSurfaceContextValue } from "./map-surface-context";
import { PointLayer, createPointLayerFeatures, type PointLayerProps } from "./point-layer";
import type { TemporalGeoJsonSupportedGeometry } from "./temporal-geojson-types";

export type MapsProjectCoordinate = (
  coordinates: [longitude: number, latitude: number],
) => { x: number; y: number } | null;

type AnyRecord = Record<string, unknown>;
type MapsOverlayInteractionSurface = Pick<
  MapSurfaceContextValue,
  | "handleFeatureClick"
  | "handleFeatureContextMenu"
  | "handleFeatureHover"
  | "isFeatureHovered"
  | "isFeatureSelected"
>;

type MapsFeatureSvgCommon = {
  className: string;
  featureId: string;
  interaction: ReturnType<typeof createFeaturePointerInteraction>;
};

type MapsOverlayLayersProps = {
  children: ReactNode;
  project: MapsProjectCoordinate;
  surface: MapsOverlayInteractionSurface;
};

export function MapsOverlayLayers({ children, project, surface }: MapsOverlayLayersProps) {
  const layers = renderChildren(children, project, surface);

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

function renderChildren(
  children: ReactNode,
  project: MapsProjectCoordinate,
  surface: MapsOverlayInteractionSurface,
): ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) {
      throwUnsupportedMapsLayer();
    }

    if (child.type === Fragment) {
      return renderChildren((child.props as { children?: ReactNode }).children, project, surface);
    }

    if (child.type === PointLayer) {
      return [
        <MapsPointLayer
          key={child.key ?? "maps-point-layer"}
          {...(child.props as PointLayerProps<AnyRecord>)}
          project={project}
          surface={surface}
        />,
      ];
    }

    if (child.type === GeoJsonLayer) {
      return [
        <MapsGeoJsonLayer
          key={child.key ?? "maps-geojson-layer"}
          {...(child.props as GeoJsonLayerProps<AnyRecord>)}
          project={project}
          surface={surface}
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
  surface,
}: PointLayerProps<AnyRecord> & {
  project: MapsProjectCoordinate;
  surface: MapsOverlayInteractionSurface;
}) {
  assertNoUnsupportedPointDrag({
    draggable,
    onFeatureDrag,
    onFeatureDragEnd,
  });

  return createPointLayerFeatures(points, { filterPoint }).flatMap((feature) => {
    const position = project(feature.coordinates);
    if (!position) return [];
    const featureId = getFeatureId?.(feature) || feature.point.id;
    const resolveFeatureId = () => featureId;
    const hovered = surface.isFeatureHovered(feature, hoveredFeatureId, resolveFeatureId);
    const selected = surface.isFeatureSelected(feature, selectedFeatureId, resolveFeatureId);
    const radius = Math.max(0, getPointRadius?.(feature) ?? pointRadius);
    const interaction = createFeaturePointerInteraction({
      coordinates: feature.coordinates,
      feature,
      featureId,
      getFeatureId: resolveFeatureId,
      onFeatureContextMenu,
      onFeatureHover,
      onFeatureSelect,
      onHoveredFeatureIdChange,
      onSelectedFeatureIdChange,
      renderFeatureContextMenu,
      renderFeaturePopup,
      renderFeatureTooltip,
      surface,
    });

    return [
      <circle
        key={featureId}
        className={mapsFeatureClassName("mb-maps__point-marker", hovered, selected)}
        cx={position.x}
        cy={position.y}
        data-map-feature-id={featureId}
        data-map-feature-interactive="true"
        fill={getPointColor?.(feature) ?? pointColor}
        fillOpacity={0.92}
        r={radius}
        stroke="#ffffff"
        strokeWidth={selected ? 3 : 2}
        style={interactiveFeatureStyle}
        {...interaction}
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
  surface,
}: GeoJsonLayerProps<AnyRecord> & {
  project: MapsProjectCoordinate;
  surface: MapsOverlayInteractionSurface;
}) {
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
    const resolveFeatureId = () => featureId;
    const hovered = surface.isFeatureHovered(feature, hoveredFeatureId, resolveFeatureId);
    const selected = surface.isFeatureSelected(feature, selectedFeatureId, resolveFeatureId);
    const style = resolveFeatureStyle(feature, baseStyle, getFeatureStyle);
    const interactive = isFeatureInteractive?.(feature) ?? true;
    const interaction = interactive
      ? createFeaturePointerInteraction({
          coordinates: getGeometryCenter(feature.geometry),
          feature,
          featureId,
          getFeatureId: resolveFeatureId,
          onFeatureContextMenu,
          onFeatureHover,
          onFeatureSelect,
          onHoveredFeatureIdChange,
          onSelectedFeatureIdChange,
          renderFeatureContextMenu,
          renderFeaturePopup,
          renderFeatureTooltip,
          surface,
        })
      : {};

    return renderGeometry(feature, featureId, style, hovered, selected, project, {
      className: mapsFeatureClassName("mb-maps__geojson-feature", hovered, selected),
      featureId,
      interaction,
    }, interactive);
  });
}

function renderGeometry(
  feature: GeoJsonLayerFeature<AnyRecord>,
  featureId: string,
  style: Required<GeoJsonLayerStyle>,
  hovered: boolean,
  selected: boolean,
  project: MapsProjectCoordinate,
  common: MapsFeatureSvgCommon,
  interactive: boolean,
): ReactNode[] {
  const geometry = feature.geometry;

  switch (geometry.type) {
    case "Point":
      return renderGeoJsonPoint(
        geometry.coordinates,
        featureId,
        style,
        selected,
        project,
        common,
        interactive,
      );
    case "MultiPoint":
      return geometry.coordinates.flatMap((coordinates, index) =>
        renderGeoJsonPoint(
          coordinates,
          `${featureId}:${index}`,
          style,
          selected,
          project,
          common,
          interactive,
        ),
      );
    case "LineString":
      return renderLine(geometry, featureId, style, selected, project, common, interactive);
    case "MultiLineString":
      return geometry.coordinates.flatMap((coordinates, index) =>
        renderLine(
          { coordinates, type: "LineString" },
          `${featureId}:${index}`,
          style,
          selected,
          project,
          common,
          interactive,
        ),
      );
    case "Polygon":
      return renderPolygon(geometry, featureId, style, selected, project, common, interactive);
    case "MultiPolygon":
      return geometry.coordinates.flatMap((coordinates, index) =>
        renderPolygon(
          { coordinates, type: "Polygon" },
          `${featureId}:${index}`,
          style,
          selected,
          project,
          common,
          interactive,
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
  common: MapsFeatureSvgCommon,
  interactive: boolean,
): ReactNode[] {
  const position = project(coordinates);
  if (!position) return [];

  return [
    <circle
      key={key}
      className={common.className}
      cx={position.x}
      cy={position.y}
      data-map-feature-id={common.featureId}
      data-map-feature-interactive={String(interactive)}
      fill={style.pointColor}
      fillOpacity={0.94}
      r={style.pointRadius}
      stroke="#ffffff"
      strokeWidth={selected ? 3 : 2}
      style={interactive ? interactiveFeatureStyle : nonInteractiveFeatureStyle}
      {...common.interaction}
    />,
  ];
}

function renderLine(
  geometry: Extract<TemporalGeoJsonSupportedGeometry, { type: "LineString" }>,
  key: string,
  style: Required<GeoJsonLayerStyle>,
  selected: boolean,
  project: MapsProjectCoordinate,
  common: MapsFeatureSvgCommon,
  interactive: boolean,
): ReactNode[] {
  const path = projectPath(geometry.coordinates, project, false);
  if (!path) return [];

  return [
    <path
      key={key}
      className={common.className}
      d={path}
      data-map-feature-id={common.featureId}
      data-map-feature-interactive={String(interactive)}
      fill="none"
      stroke={style.lineColor}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity={style.lineOpacity}
      strokeWidth={selected ? style.lineWidth + 1.5 : style.lineWidth}
      style={interactive ? interactiveFeatureStyle : nonInteractiveFeatureStyle}
      {...common.interaction}
    />,
  ];
}

function renderPolygon(
  geometry: Extract<TemporalGeoJsonSupportedGeometry, { type: "Polygon" }>,
  key: string,
  style: Required<GeoJsonLayerStyle>,
  selected: boolean,
  project: MapsProjectCoordinate,
  common: MapsFeatureSvgCommon,
  interactive: boolean,
): ReactNode[] {
  const paths = geometry.coordinates.map((ring) => projectPath(ring, project, true));
  if (paths.some((path) => !path)) return [];

  return [
    <path
      key={key}
      className={common.className}
      d={paths.join(" ")}
      data-map-feature-id={common.featureId}
      data-map-feature-interactive={String(interactive)}
      fill={style.polygonFillColor}
      fillOpacity={style.polygonFillOpacity}
      fillRule="evenodd"
      stroke={style.polygonStrokeColor}
      strokeOpacity={0.9}
      strokeWidth={selected ? style.polygonStrokeWidth + 1.5 : style.polygonStrokeWidth}
      style={interactive ? interactiveFeatureStyle : nonInteractiveFeatureStyle}
      {...common.interaction}
    />,
  ];
}

function createFeaturePointerInteraction<TFeature>({
  coordinates,
  feature,
  featureId,
  getFeatureId,
  onFeatureContextMenu,
  onFeatureHover,
  onFeatureSelect,
  onHoveredFeatureIdChange,
  onSelectedFeatureIdChange,
  renderFeatureContextMenu,
  renderFeaturePopup,
  renderFeatureTooltip,
  surface,
}: {
  coordinates: [longitude: number, latitude: number];
  feature: TFeature;
  featureId: string;
  getFeatureId: (feature: TFeature) => string;
  onFeatureContextMenu?: (feature: TFeature) => void;
  onFeatureHover?: (feature: TFeature | null) => void;
  onFeatureSelect?: (feature: TFeature | null) => void;
  onHoveredFeatureIdChange?: PointLayerProps<AnyRecord>["onHoveredFeatureIdChange"];
  onSelectedFeatureIdChange?: PointLayerProps<AnyRecord>["onSelectedFeatureIdChange"];
  renderFeatureContextMenu?: PointLayerProps<AnyRecord>["renderFeatureContextMenu"];
  renderFeaturePopup?: (feature: TFeature) => ReactNode;
  renderFeatureTooltip?: (feature: TFeature) => ReactNode;
  surface: MapsOverlayInteractionSurface;
}) {
  const interactionId = () => featureId;

  return {
    onClick(event: ReactMouseEvent<SVGElement>) {
      event.stopPropagation();
      surface.handleFeatureClick(feature, getPointerPosition(event), {
        getFeatureId: interactionId,
        onFeatureSelect,
        onSelectedFeatureIdChange: onSelectedFeatureIdChange as never,
        renderFeaturePopup,
      });
    },
    onContextMenu(event: ReactMouseEvent<SVGElement>) {
      event.preventDefault();
      event.stopPropagation();
      surface.handleFeatureContextMenu(feature, getPointerPosition(event), {
        coordinates,
        getFeatureId: interactionId,
        onFeatureContextMenu,
        onFeatureSelect,
        onSelectedFeatureIdChange: onSelectedFeatureIdChange as never,
        renderFeatureContextMenu: renderFeatureContextMenu as never,
        renderFeaturePopup,
      });
    },
    onMouseEnter(event: ReactMouseEvent<SVGElement>) {
      surface.handleFeatureHover(feature, getPointerPosition(event), {
        getFeatureId,
        onHoveredFeatureIdChange: onHoveredFeatureIdChange as never,
        onFeatureHover,
        renderFeatureTooltip,
      });
    },
    onMouseLeave() {
      surface.handleFeatureHover(null, null, {
        getFeatureId,
        onHoveredFeatureIdChange: onHoveredFeatureIdChange as never,
        onFeatureHover,
        renderFeatureTooltip,
      });
    },
    onMouseMove(event: ReactMouseEvent<SVGElement>) {
      surface.handleFeatureHover(feature, getPointerPosition(event), {
        getFeatureId,
        onHoveredFeatureIdChange: onHoveredFeatureIdChange as never,
        onFeatureHover,
        renderFeatureTooltip,
      });
    },
  };
}

function getPointerPosition(event: ReactMouseEvent<SVGElement>) {
  const overlay = event.currentTarget.ownerSVGElement;
  const bounds = overlay?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();

  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
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

function assertNoUnsupportedPointDrag(
  props: Pick<PointLayerProps<AnyRecord>, "draggable" | "onFeatureDrag" | "onFeatureDragEnd">,
) {
  if (Object.values(props).some(Boolean)) {
    throw new Error(
      'flatRuntime="maps" does not support draggable PointLayer features yet; drag/edit contracts remain explicit until a Maps-owned editing slice lands.',
    );
  }
}

const interactiveFeatureStyle = {
  cursor: "pointer",
  pointerEvents: "auto" as const,
};

const nonInteractiveFeatureStyle = {
  pointerEvents: "none" as const,
};

function throwUnsupportedMapsLayer(): never {
  throw new Error(
    'flatRuntime="maps" currently supports PointLayer and GeoJsonLayer only; other map layer types remain explicitly MapLibre-backed.',
  );
}
