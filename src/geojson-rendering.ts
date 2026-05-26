import { toLeafletLatLng } from "./map-display";
import type { MapSurfaceContextValue } from "./map-view";
import type {
  GeoJsonLineStringGeometry,
  GeoJsonPolygonGeometry,
  GeoJsonPosition,
  TemporalGeoJsonSupportedGeometry,
} from "./temporal-geojson-types";
import type { GeoJsonLayerFeature, GeoJsonLayerStyle } from "./geojson-layer";

export const DEFAULT_GEOJSON_LAYER_STYLE: Required<GeoJsonLayerStyle> = {
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

export type FlatGeometryLayer = {
  addTo: (layer: unknown) => FlatGeometryLayer;
  bringToFront?: () => FlatGeometryLayer;
  on: (event: string, handler: (event?: LeafletFeaturePointerEvent) => void) => FlatGeometryLayer;
  setLatLng?: (latLng: [number, number]) => FlatGeometryLayer;
  setLatLngs?: (latLngs: unknown) => FlatGeometryLayer;
};

export type LeafletFeaturePointerEvent = {
  containerPoint?: { x: number; y: number };
  latlng?: { lat: number; lng: number };
  originalEvent?: {
    defaultPrevented?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
};

export function createFlatGeometryLayers(
  geometry: TemporalGeoJsonSupportedGeometry,
  options: {
    bubblingMouseEvents?: boolean;
    className: string;
    interactive: boolean;
    leaflet: typeof import("leaflet");
    selected: boolean;
    style: Required<GeoJsonLayerStyle>;
  },
): FlatGeometryLayer[] {
  const { bubblingMouseEvents, className, interactive, leaflet, selected, style } = options;

  switch (geometry.type) {
    case "Point":
      return [
        leaflet.circleMarker(toLeafletLatLng(geometry.coordinates), {
          className,
          bubblingMouseEvents,
          color: "#ffffff",
          fillColor: style.pointColor,
          fillOpacity: 0.94,
          interactive,
          opacity: 1,
          radius: style.pointRadius,
          weight: selected ? 3 : 2,
        }) as FlatGeometryLayer,
      ];
    case "MultiPoint":
      return geometry.coordinates.map((coordinates) =>
        leaflet.circleMarker(toLeafletLatLng(coordinates), {
          className,
          bubblingMouseEvents,
          color: "#ffffff",
          fillColor: style.pointColor,
          fillOpacity: 0.94,
          interactive,
          opacity: 1,
          radius: style.pointRadius,
          weight: selected ? 3 : 2,
        }) as FlatGeometryLayer,
      );
    case "LineString":
      return [createFlatLineLayer(leaflet, geometry, className, interactive, selected, style, bubblingMouseEvents)];
    case "MultiLineString":
      return geometry.coordinates.map((coordinates) =>
        createFlatLineLayer(
          leaflet,
          { coordinates, type: "LineString" },
          className,
          interactive,
          selected,
          style,
          bubblingMouseEvents,
        ),
      );
    case "Polygon":
      return [createFlatPolygonLayer(leaflet, geometry, className, interactive, selected, style, bubblingMouseEvents)];
    case "MultiPolygon":
      return geometry.coordinates.map((coordinates) =>
        createFlatPolygonLayer(
          leaflet,
          { coordinates, type: "Polygon" },
          className,
          interactive,
          selected,
          style,
          bubblingMouseEvents,
        ),
      );
  }
}

export function getGeometryCenter(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition {
  const positions = getGeometryPositions(geometry);
  const sum = positions.reduce(
    (current, position) => [current[0] + position[0], current[1] + position[1]] as GeoJsonPosition,
    [0, 0] as GeoJsonPosition,
  );

  return [sum[0] / Math.max(1, positions.length), sum[1] / Math.max(1, positions.length)];
}

export function getGeometryPositions(geometry: TemporalGeoJsonSupportedGeometry): GeoJsonPosition[] {
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

export function projectGeometryCenter(
  geometry: TemporalGeoJsonSupportedGeometry,
  surface: MapSurfaceContextValue,
) {
  const center = getGeometryCenter(geometry);
  const projected = surface.projectGlobeCoordinate(center, surface.viewState);

  return projected.visible ? { x: projected.x, y: projected.y } : getFirstVisiblePosition(geometry, surface);
}

export function resolveFeatureStyle<TProperties extends Record<string, unknown>>(
  feature: GeoJsonLayerFeature<TProperties>,
  props: GeoJsonLayerStyle,
  getFeatureStyle: ((feature: GeoJsonLayerFeature<TProperties>) => GeoJsonLayerStyle) | undefined,
): Required<GeoJsonLayerStyle> {
  return {
    ...DEFAULT_GEOJSON_LAYER_STYLE,
    ...props,
    ...getFeatureStyle?.(feature),
  };
}

function createFlatLineLayer(
  leaflet: typeof import("leaflet"),
  geometry: GeoJsonLineStringGeometry,
  className: string,
  interactive: boolean,
  selected: boolean,
  style: Required<GeoJsonLayerStyle>,
  bubblingMouseEvents?: boolean,
) {
  return leaflet.polyline(geometry.coordinates.map(toLeafletLatLng), {
    bubblingMouseEvents,
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
  bubblingMouseEvents?: boolean,
) {
  return leaflet.polygon(geometry.coordinates.map((ring) => ring.map(toLeafletLatLng)), {
    bubblingMouseEvents,
    className,
    color: style.polygonStrokeColor,
    fillColor: style.polygonFillColor,
    fillOpacity: style.polygonFillOpacity,
    interactive,
    opacity: 0.9,
    weight: selected ? style.polygonStrokeWidth + 1.5 : style.polygonStrokeWidth,
  }) as FlatGeometryLayer;
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
