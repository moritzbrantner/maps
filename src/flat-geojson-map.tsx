"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";

import {
  getBoundsFromGeoJson,
  type GeoJsonMapSource,
} from "./geojson-source";
import {
  createFlatGeometryLayers,
  resolveFeatureStyle,
} from "./geojson-rendering";
import type {
  GeoJsonLayerFeature,
  GeoJsonLayerProps,
} from "./geojson-layer";
import {
  defaultRasterMapStyle,
  joinClassNames,
  resolveTileLayerOptions,
  toLeafletLatLng,
  type MapViewState,
  type RasterMapStyle,
} from "./map-display";
import { cloneGeometry, normalizeGeometryCollection } from "./temporal-geojson-geometry";

export type FlatGeoJsonMapProps<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
  GeoJsonLayerProps<TProperties>,
  | "featureCollection"
  | "onFeatureContextMenu"
  | "onFeatureHover"
  | "renderFeatureContextMenu"
  | "renderFeaturePopup"
  | "renderFeatureTooltip"
> & {
  className?: string;
  fitBoundsPadding?: number;
  fitToData?: boolean;
  geoJson: GeoJsonMapSource<TProperties>;
  initialViewState?: MapViewState;
  mapLabel?: string;
  mapStyle?: string | RasterMapStyle;
  onMapReady?: (map: LeafletMap) => void;
  showAttributionControl?: boolean;
  style?: React.CSSProperties;
};

export function FlatGeoJsonMap<
  TProperties extends Record<string, unknown> = Record<string, unknown>,
>({
  className,
  fitBoundsPadding = 56,
  fitToData = true,
  geoJson,
  getFeatureId,
  getFeatureStyle,
  initialViewState,
  lineColor,
  lineOpacity,
  lineWidth,
  mapLabel = "Interactive GeoJSON map",
  mapStyle = defaultRasterMapStyle,
  onFeatureSelect,
  onMapReady,
  pointColor,
  pointRadius,
  polygonFillColor,
  polygonFillOpacity,
  polygonStrokeColor,
  polygonStrokeWidth,
  selectedFeatureId,
  showAttributionControl = true,
  style,
}: FlatGeoJsonMapProps<TProperties>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const [isReady, setIsReady] = useState(false);
  const deferredGeoJson = useDeferredValue(geoJson);
  const features = useMemo(() => createFlatGeoJsonFeatures(deferredGeoJson), [deferredGeoJson]);
  const styleProps = {
    lineColor,
    lineOpacity,
    lineWidth,
    pointColor,
    pointRadius,
    polygonFillColor,
    polygonFillOpacity,
    polygonStrokeColor,
    polygonStrokeWidth,
  };

  const handleMapReady = useEffectEvent((map: LeafletMap) => {
    setIsReady(true);
    startTransition(() => {
      onMapReady?.(map);
    });
  });

  const renderFeatures = useEffectEvent(() => {
    const layer = layerRef.current;
    const leaflet = leafletRef.current;

    if (!layer || !leaflet) {
      return;
    }

    layer.clearLayers();

    for (const feature of features) {
      const selected =
        selectedFeatureId !== null &&
        selectedFeatureId !== undefined &&
        selectedFeatureId === (getFeatureId?.(feature) ?? feature.id);
      const geometryLayers = createFlatGeometryLayers(feature.geometry, {
        className: joinClassNames(
          "mb-maps__geojson-feature",
          selected && "mb-maps__feature--selected",
        ),
        interactive: Boolean(onFeatureSelect),
        leaflet,
        selected,
        style: resolveFeatureStyle(feature, styleProps, getFeatureStyle),
      });

      for (const geometryLayer of geometryLayers) {
        geometryLayer.on("click", () => {
          startTransition(() => {
            onFeatureSelect?.(feature);
          });
        });
        geometryLayer.addTo(layer);
      }
    }
  });

  useEffect(() => {
    let isCancelled = false;
    let localMap: LeafletMap | null = null;

    async function initializeMap() {
      if (!containerRef.current) {
        return;
      }

      const leaflet = await import("leaflet");

      if (isCancelled || !containerRef.current) {
        return;
      }

      leafletRef.current = leaflet;
      localMap = leaflet.map(containerRef.current, {
        attributionControl: showAttributionControl,
        center: toLeafletLatLng(initialViewState?.center ?? [12, 25]),
        zoom: initialViewState?.zoom ?? 1.6,
        zoomControl: true,
      });
      mapRef.current = localMap;

      const tileLayerOptions = resolveTileLayerOptions(mapStyle);

      if (tileLayerOptions) {
        leaflet.tileLayer(tileLayerOptions.url, tileLayerOptions.options).addTo(localMap);
      }

      layerRef.current = leaflet.layerGroup().addTo(localMap);

      queueMicrotask(() => {
        if (isCancelled || !localMap) {
          return;
        }

        renderFeatures();
        handleMapReady(localMap);
      });
    }

    initializeMap();

    return () => {
      isCancelled = true;
      setIsReady(false);

      if (localMap) {
        localMap.remove();
      }

      layerRef.current = null;
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    if (fitToData && !initialViewState) {
      const dataBounds = getBoundsFromGeoJson(deferredGeoJson);

      if (dataBounds) {
        map.fitBounds(
          [
            [dataBounds[1], dataBounds[0]],
            [dataBounds[3], dataBounds[2]],
          ],
          {
            animate: false,
            padding: [fitBoundsPadding, fitBoundsPadding],
          },
        );
      }
    }

    renderFeatures();
  }, [deferredGeoJson, features, fitBoundsPadding, fitToData, initialViewState, renderFeatures]);

  return (
    <div
      aria-label={mapLabel}
      className={joinClassNames("mb-maps", className)}
      data-map-ready={isReady ? "true" : "false"}
      style={{
        minHeight: 480,
        width: "100%",
        ...style,
      }}
    >
      <div ref={containerRef} className="mb-maps__canvas" />
    </div>
  );
}

function createFlatGeoJsonFeatures<TProperties extends Record<string, unknown>>(
  featureCollection: GeoJsonMapSource<TProperties>,
): Array<GeoJsonLayerFeature<TProperties>> {
  return featureCollection.features.flatMap((feature, sourceIndex) => {
    const geometries = normalizeGeometryCollection(feature.geometry);
    const properties = feature.properties ?? ({} as TProperties);

    return geometries.map((geometry, geometryIndex) => ({
      geometry: cloneGeometry(geometry),
      id: String(properties.id ?? feature.id ?? `${sourceIndex}-${geometryIndex}`),
      properties,
      sourceIndex,
    }));
  });
}
