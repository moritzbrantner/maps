"use client";

import type {
  Coordinates,
  GeoJSONSource,
  ImageSource,
  LngLatLike,
  Map as MapLibreMap,
  Marker as MapLibreMarker,
  StyleSpecification,
} from "maplibre-gl";

export type MapLibreMapStyle = string | StyleSpecification;

export type FlatPointerEvent = {
  containerPoint?: { x: number; y: number };
  latlng?: { lat: number; lng: number };
  lngLat?: { lat: number; lng: number };
  originalEvent?: {
    defaultPrevented?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  };
};

export type FlatLayerOptions = {
  bubblingMouseEvents?: boolean;
  className?: string;
  color?: string;
  fillColor?: string;
  fillOpacity?: number;
  interactive?: boolean;
  opacity?: number;
  radius?: number;
  weight?: number;
};

export type FlatDivIconOptions = {
  className?: string;
  html?: string;
  iconAnchor?: [number, number];
  iconSize?: [number, number];
};

export type FlatMarkerOptions = {
  icon?: FlatDivIconOptions;
  interactive?: boolean;
  keyboard?: boolean;
  opacity?: number;
};

export type FlatTooltipOptions = {
  className?: string;
  direction?: string;
  permanent?: boolean;
};

export type FlatLayer = {
  addTo: (group: FlatLayerGroup) => FlatLayer;
  bindTooltip: (label: string, options?: FlatTooltipOptions) => FlatLayer;
  bringToFront?: () => FlatLayer;
  off?: (event: string, handler: (event?: FlatPointerEvent) => void) => FlatLayer;
  on: (event: string, handler: (event?: FlatPointerEvent) => void) => FlatLayer;
  openTooltip: (latLng?: [number, number]) => FlatLayer;
  remove?: () => void;
  setBounds?: (bounds: [[number, number], [number, number]]) => FlatLayer;
  setLatLng?: (latLng: [number, number]) => FlatLayer;
  setLatLngs?: (latLngs: unknown) => FlatLayer;
  setOpacity?: (opacity: number) => FlatLayer;
  setStyle?: (options: FlatLayerOptions) => FlatLayer;
  setUrl?: (url: string) => FlatLayer;
};

export type FlatLayerGroup = {
  addLayer: (layer: FlatLayer) => FlatLayerGroup;
  addTo: (map: MapLibreMap) => FlatLayerGroup;
  clearLayers: () => FlatLayerGroup;
  layers: FlatLayer[];
  remove: () => void;
  removeLayer: (layer: FlatLayer) => FlatLayerGroup;
};

export type FlatMapAdapter = MapLibreMap & {
  containerPointToLatLng: (point: [number, number]) => { lat: number; lng: number };
  dragging: {
    disable: () => void;
    enable: () => void;
  };
  getSize: () => { x: number; y: number };
  latLngToContainerPoint: (latLng: [number, number] | { lat: number; lng: number }) => {
    x: number;
    y: number;
  };
  setView: (latLng: [number, number] | { lat: number; lng: number }, zoom: number) => void;
};

export type FlatLayerFactory = {
  circleMarker: (latLng: [number, number], options?: FlatLayerOptions) => FlatLayer;
  divIcon: (options?: FlatDivIconOptions) => FlatDivIconOptions;
  imageOverlay: (
    url: string,
    bounds: [[number, number], [number, number]],
    options?: FlatLayerOptions,
  ) => FlatLayer;
  layerGroup: () => FlatLayerGroup;
  marker: (latLng: [number, number], options?: FlatMarkerOptions) => FlatLayer;
  polygon: (latLngs: unknown, options?: FlatLayerOptions) => FlatLayer;
  polyline: (latLngs: unknown, options?: FlatLayerOptions) => FlatLayer;
};

let nextLayerId = 0;

export function createMapLibreFlatMapAdapter(map: MapLibreMap): FlatMapAdapter {
  const adapter = map as FlatMapAdapter;

  adapter.latLngToContainerPoint = (latLng) => {
    const coordinates = Array.isArray(latLng) ? latLngToLngLat(latLng) : [latLng.lng, latLng.lat];
    const point = map.project(coordinates as LngLatLike);

    return { x: point.x, y: point.y };
  };
  adapter.containerPointToLatLng = ([x, y]) => {
    const lngLat = map.unproject([x, y]);

    return { lat: lngLat.lat, lng: lngLat.lng };
  };
  adapter.setView = (latLng, zoom) => {
    const center = Array.isArray(latLng) ? latLngToLngLat(latLng) : [latLng.lng, latLng.lat];

    map.jumpTo({ center: center as LngLatLike, zoom });
  };
  adapter.dragging = {
    disable: () => map.dragPan.disable(),
    enable: () => map.dragPan.enable(),
  };
  adapter.getSize = () => {
    const container = map.getContainer();

    return { x: container.clientWidth, y: container.clientHeight };
  };

  return adapter;
}

export function createMapLibreFlatLayerFactory(
  maplibre: typeof import("maplibre-gl"),
  map: MapLibreMap,
): FlatLayerFactory {
  return {
    circleMarker(latLng, options = {}) {
      return new MapLibrePointLayer(map, latLngToLngLat(latLng), options);
    },
    divIcon(options = {}) {
      return options;
    },
    imageOverlay(url, bounds, options = {}) {
      return new MapLibreImageLayer(map, url, bounds, options);
    },
    layerGroup() {
      return new MapLibreLayerGroup(map);
    },
    marker(latLng, options = {}) {
      return new MapLibreDomMarkerLayer(maplibre, map, latLngToLngLat(latLng), options);
    },
    polygon(latLngs, options = {}) {
      return new MapLibrePolygonLayer(map, latLngs, options);
    },
    polyline(latLngs, options = {}) {
      return new MapLibreLineLayer(map, latLngs, options);
    },
  };
}

export function removeMapLibreLayerIfExists(map: MapLibreMap, layerId: string) {
  try {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
  } catch (error) {
    if (!isDisposedMapLibreStyleAccessError(error, ["getLayer", "removeLayer"])) {
      throw error;
    }
  }
}

export function removeMapLibreSourceIfExists(map: MapLibreMap, sourceId: string) {
  try {
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
  } catch (error) {
    if (!isDisposedMapLibreStyleAccessError(error, ["getSource", "removeSource"])) {
      throw error;
    }
  }
}

function isDisposedMapLibreStyleAccessError(error: unknown, properties: string[]) {
  if (!(error instanceof TypeError)) {
    return false;
  }

  const message = String(error.message);

  return properties.some((property) => message.includes(property)) && message.includes("undefined");
}

export function upsertGeoJsonSource(
  map: MapLibreMap,
  sourceId: string,
  data: GeoJSON.FeatureCollection | GeoJSON.Feature,
) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;

  if (source && typeof source.setData === "function") {
    source.setData(data);
    return source;
  }

  map.addSource(sourceId, {
    data,
    type: "geojson",
  });

  return map.getSource(sourceId) as GeoJSONSource;
}

export function toLngLat([longitude, latitude]: [number, number]) {
  return [longitude, latitude] as [number, number];
}

export function toLatLng([longitude, latitude]: [number, number]) {
  return [latitude, longitude] as [number, number];
}

export function toMapLibreBounds([west, south, east, north]: [number, number, number, number]) {
  return [
    [west, south],
    [east, north],
  ] as [[number, number], [number, number]];
}

class MapLibreLayerGroup implements FlatLayerGroup {
  layers: FlatLayer[] = [];
  private readonly testLayerGroup: unknown;

  constructor(private readonly map: MapLibreMap) {
    this.testLayerGroup = (
      map as unknown as {
        __mbCreateFlatLayerGroup?: () => unknown;
      }
    ).__mbCreateFlatLayerGroup?.();
  }

  addLayer(layer: FlatLayer) {
    if (!this.layers.includes(layer)) {
      this.layers.push(layer);
      layer.addTo(this);
    }

    return this;
  }

  addTo() {
    return this;
  }

  clearLayers() {
    for (const layer of this.layers) {
      layer.remove?.();
    }

    this.layers = [];
    (
      this.testLayerGroup as
        | {
            clearLayers?: () => void;
          }
        | undefined
    )?.clearLayers?.();
    return this;
  }

  remove() {
    this.clearLayers();
  }

  removeLayer(layer: FlatLayer) {
    const index = this.layers.indexOf(layer);

    if (index >= 0) {
      this.layers.splice(index, 1);
    }

    layer.remove?.();
    return this;
  }

  setAsActiveTestLayerGroup() {
    (
      this.map as unknown as {
        __mbSetActiveFlatLayerGroup?: (group: unknown) => void;
      }
    ).__mbSetActiveFlatLayerGroup?.(this.testLayerGroup);
  }

  clearActiveTestLayerGroup() {
    (
      this.map as unknown as {
        __mbSetActiveFlatLayerGroup?: (group: unknown) => void;
      }
    ).__mbSetActiveFlatLayerGroup?.(null);
  }
}

abstract class MapLibreSourceLayer implements FlatLayer {
  protected readonly id = `mb-maps-flat-${nextLayerId++}`;
  protected readonly layerIds: string[] = [];
  protected readonly sourceId = `${this.id}:source`;
  protected group: FlatLayerGroup | null = null;
  protected tooltip: { label: string; marker: MapLibreMarker; options?: FlatTooltipOptions } | null = null;
  private pendingTooltipLatLng: [number, number] | undefined;
  private readonly pendingHandlers: Array<{
    event: string;
    publicHandler: (event?: FlatPointerEvent) => void;
  }> = [];
  private readonly handlers: Array<{
    event: string;
    handler: (event: unknown) => void;
    layerId: string;
    mapLevel: boolean;
    publicHandler: (event?: FlatPointerEvent) => void;
  }> = [];

  constructor(protected readonly map: MapLibreMap) {}

  addTo(group: FlatLayerGroup) {
    this.group = group;

    if (!group.layers.includes(this)) {
      group.layers.push(this);
    }

    const testGroup = group as unknown as {
      clearActiveTestLayerGroup?: () => void;
      setAsActiveTestLayerGroup?: () => void;
    };

    testGroup.setAsActiveTestLayerGroup?.();
    try {
      this.render();
      for (const { event, publicHandler } of this.pendingHandlers) {
        this.attachHandler(event, publicHandler);
      }
      if (this.tooltip) {
        this.applyFlatTooltip();
      }
      if (this.pendingTooltipLatLng) {
        this.openTooltip(this.pendingTooltipLatLng);
      }
    } finally {
      testGroup.clearActiveTestLayerGroup?.();
    }
    return this;
  }

  bindTooltip(label: string, options?: FlatTooltipOptions) {
    this.tooltip = {
      label,
      marker: this.tooltip?.marker as MapLibreMarker,
      options,
    };
    this.applyFlatTooltip();

    return this;
  }

  bringToFront() {
    for (const layerId of this.layerIds) {
      if (this.map.getLayer(layerId)) {
        this.map.moveLayer(layerId);
      }
    }

    return this;
  }

  on(event: string, publicHandler: (event?: FlatPointerEvent) => void) {
    this.pendingHandlers.push({ event, publicHandler });
    this.attachHandler(event, publicHandler);

    return this;
  }

  off(event: string, publicHandler: (event?: FlatPointerEvent) => void) {
    const mapEvent = event === "mouseover" ? "mouseenter" : event === "mouseout" ? "mouseleave" : event;

    for (const entry of this.handlers.filter(
      (entry) => entry.event === mapEvent && entry.publicHandler === publicHandler,
    )) {
      if (entry.mapLevel) {
        (this.map as unknown as EventedMap).off(entry.event, entry.handler);
      } else {
        (this.map as unknown as EventedMap).off(entry.event, entry.layerId, entry.handler);
      }
      this.handlers.splice(this.handlers.indexOf(entry), 1);
    }
    for (const entry of this.pendingHandlers.filter(
      (entry) => entry.event === event && entry.publicHandler === publicHandler,
    )) {
      this.pendingHandlers.splice(this.pendingHandlers.indexOf(entry), 1);
    }

    return this;
  }

  openTooltip(latLng?: [number, number]) {
    this.pendingTooltipLatLng = latLng;

    if (!this.tooltip || !latLng) {
      return this;
    }

    this.tooltip.marker?.remove?.();
    const layerId = this.layerIds[0];

    if (layerId) {
      (
        this.map as unknown as {
          __mbOpenFlatTooltip?: (
            layerId: string,
            label: string,
            options: FlatTooltipOptions | undefined,
            latLng: [number, number] | undefined,
          ) => void;
        }
      ).__mbOpenFlatTooltip?.(layerId, this.tooltip.label, this.tooltip.options, latLng);
    }

    const element = document.createElement("div");
    element.className = this.tooltip.options?.className ?? "mb-maps__tooltip";
    element.textContent = this.tooltip.label;
    this.tooltip.marker = new (getMarkerConstructor(this.map))({ element, anchor: "center" })
      .setLngLat(latLngToLngLat(latLng) as LngLatLike)
      .addTo(this.map);

    return this;
  }

  remove() {
    for (const entry of this.handlers) {
      if (entry.mapLevel) {
        (this.map as unknown as EventedMap).off(entry.event, entry.handler);
      } else {
        (this.map as unknown as EventedMap).off(entry.event, entry.layerId, entry.handler);
      }
    }
    this.handlers.length = 0;
    this.tooltip?.marker?.remove?.();

    for (const layerId of [...this.layerIds].reverse()) {
      removeMapLibreLayerIfExists(this.map, layerId);
    }
    removeMapLibreSourceIfExists(this.map, this.sourceId);
  }

  protected abstract render(): void;

  private applyFlatTooltip() {
    if (!this.tooltip) {
      return;
    }

    for (const layerId of this.layerIds) {
      (
        this.map as unknown as {
          __mbBindFlatTooltip?: (
            layerId: string,
            label: string,
            options: FlatTooltipOptions | undefined,
          ) => void;
        }
      ).__mbBindFlatTooltip?.(layerId, this.tooltip.label, this.tooltip.options);
    }
  }

  private attachHandler(event: string, publicHandler: (event?: FlatPointerEvent) => void) {
    const mapEvent = event === "mouseover" ? "mouseenter" : event === "mouseout" ? "mouseleave" : event;
    const seenEvents = new WeakSet<object>();
    const emit = (mapEventObject: unknown) => {
      if (mapEventObject && typeof mapEventObject === "object") {
        if (seenEvents.has(mapEventObject)) {
          return;
        }

        seenEvents.add(mapEventObject);
      }

      publicHandler(toFlatPointerEvent(mapEventObject));
    };

    for (const layerId of this.layerIds) {
      if (
        this.handlers.some(
          (entry) => entry.event === mapEvent && entry.layerId === layerId && entry.publicHandler === publicHandler,
        )
      ) {
        continue;
      }

      const handler = (mapEventObject: unknown) => emit(mapEventObject);

      (this.map as unknown as EventedMap).on(mapEvent, layerId, handler);
      this.handlers.push({ event: mapEvent, handler, layerId, mapLevel: false, publicHandler });

      if (!usesMapLevelHitTestFallback(mapEvent)) {
        continue;
      }

      if (typeof this.map.queryRenderedFeatures !== "function") {
        continue;
      }

      const fallbackHandler = (mapEventObject: unknown) => {
        const point = (mapEventObject as { point?: { x: number; y: number } } | undefined)?.point;

        if (!point || !this.map.getLayer(layerId)) {
          return;
        }

        const hits = this.map.queryRenderedFeatures(
          [
            [point.x - 6, point.y - 6],
            [point.x + 6, point.y + 6],
          ],
          { layers: [layerId] },
        );

        if (hits.length === 0) {
          return;
        }

        emit(mapEventObject);
      };

      (this.map as unknown as EventedMap).on(mapEvent, fallbackHandler);
      this.handlers.push({
        event: mapEvent,
        handler: fallbackHandler,
        layerId,
        mapLevel: true,
        publicHandler,
      });
    }
  }
}

class MapLibrePointLayer extends MapLibreSourceLayer {
  private coordinates: [number, number];

  constructor(map: MapLibreMap, coordinates: [number, number], private readonly options: FlatLayerOptions) {
    super(map);
    this.coordinates = coordinates;
  }

  setLatLng(latLng: [number, number]) {
    this.coordinates = latLngToLngLat(latLng);
    const source = this.map.getSource(this.sourceId) as GeoJSONSource | undefined;
    source?.setData?.(this.getData());

    return this;
  }

  setStyle(options: FlatLayerOptions) {
    Object.assign(this.options, options);
    const layerId = this.layerIds[0];

    if (layerId && this.map.getLayer(layerId)) {
      this.map.setPaintProperty(layerId, "circle-color", this.options.fillColor ?? "#0f172a");
      this.map.setPaintProperty(
        layerId,
        "circle-opacity",
        this.options.fillOpacity ?? this.options.opacity ?? 1,
      );
      this.map.setPaintProperty(layerId, "circle-radius", this.options.radius ?? 6);
      this.map.setPaintProperty(layerId, "circle-stroke-color", this.options.color ?? "#ffffff");
      this.map.setPaintProperty(layerId, "circle-stroke-opacity", this.options.opacity ?? 1);
      this.map.setPaintProperty(layerId, "circle-stroke-width", this.options.weight ?? 1);
    }

    return this;
  }

  protected render() {
    upsertGeoJsonSource(this.map, this.sourceId, this.getData());
    const layerId = `${this.id}:circle`;
    this.layerIds.push(layerId);
    this.map.addLayer({
      id: layerId,
      metadata: {
        flatOptions: this.options,
      },
      paint: {
        "circle-color": this.options.fillColor ?? "#0f172a",
        "circle-opacity": this.options.fillOpacity ?? this.options.opacity ?? 1,
        "circle-radius": this.options.radius ?? 6,
        "circle-stroke-color": this.options.color ?? "#ffffff",
        "circle-stroke-opacity": this.options.opacity ?? 1,
        "circle-stroke-width": this.options.weight ?? 1,
      },
      source: this.sourceId,
      type: "circle",
    } as never);
  }

  private getData(): GeoJSON.Feature {
    return {
      geometry: {
        coordinates: this.coordinates,
        type: "Point",
      },
      properties: {},
      type: "Feature",
    };
  }
}

class MapLibreLineLayer extends MapLibreSourceLayer {
  private coordinates: GeoJSON.Position[][] = [];

  constructor(map: MapLibreMap, latLngs: unknown, private readonly options: FlatLayerOptions) {
    super(map);
    this.coordinates = normalizeLineCoordinates(latLngs);
  }

  setLatLngs(latLngs: unknown) {
    this.coordinates = normalizeLineCoordinates(latLngs);
    const source = this.map.getSource(this.sourceId) as GeoJSONSource | undefined;
    source?.setData?.(this.getData());

    return this;
  }

  setStyle(options: FlatLayerOptions) {
    Object.assign(this.options, options);
    const layerId = this.layerIds[0];

    if (layerId && this.map.getLayer(layerId)) {
      this.map.setPaintProperty(layerId, "line-color", this.options.color ?? "#2563eb");
      this.map.setPaintProperty(layerId, "line-opacity", this.options.opacity ?? 1);
      this.map.setPaintProperty(layerId, "line-width", this.options.weight ?? 2);
    }

    return this;
  }

  protected render() {
    upsertGeoJsonSource(this.map, this.sourceId, this.getData());
    const layerId = `${this.id}:line`;
    this.layerIds.push(layerId);
    this.map.addLayer({
      id: layerId,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      metadata: {
        flatOptions: this.options,
      },
      paint: {
        "line-color": this.options.color ?? "#2563eb",
        "line-opacity": this.options.opacity ?? 1,
        "line-width": this.options.weight ?? 2,
      },
      source: this.sourceId,
      type: "line",
    } as never);
  }

  private getData(): GeoJSON.Feature {
    return {
      geometry:
        this.coordinates.length === 1
          ? {
              coordinates: this.coordinates[0]!,
              type: "LineString",
            }
          : {
              coordinates: this.coordinates,
              type: "MultiLineString",
            },
      properties: {},
      type: "Feature",
    };
  }
}

class MapLibrePolygonLayer extends MapLibreSourceLayer {
  private coordinates: GeoJSON.Position[][][] = [];

  constructor(map: MapLibreMap, latLngs: unknown, private readonly options: FlatLayerOptions) {
    super(map);
    this.coordinates = normalizePolygonCoordinates(latLngs);
  }

  setLatLngs(latLngs: unknown) {
    this.coordinates = normalizePolygonCoordinates(latLngs);
    const source = this.map.getSource(this.sourceId) as GeoJSONSource | undefined;
    source?.setData?.(this.getData());

    return this;
  }

  setStyle(options: FlatLayerOptions) {
    Object.assign(this.options, options);
    const fillLayerId = this.layerIds[0];
    const lineLayerId = this.layerIds[1];

    if (fillLayerId && this.map.getLayer(fillLayerId)) {
      this.map.setPaintProperty(
        fillLayerId,
        "fill-color",
        this.options.fillColor ?? this.options.color ?? "#14b8a6",
      );
      this.map.setPaintProperty(fillLayerId, "fill-opacity", this.options.fillOpacity ?? 0.2);
    }

    if (lineLayerId && this.map.getLayer(lineLayerId)) {
      this.map.setPaintProperty(lineLayerId, "line-color", this.options.color ?? "#0f766e");
      this.map.setPaintProperty(lineLayerId, "line-opacity", this.options.opacity ?? 1);
      this.map.setPaintProperty(lineLayerId, "line-width", this.options.weight ?? 2);
    }

    return this;
  }

  protected render() {
    upsertGeoJsonSource(this.map, this.sourceId, this.getData());
    const fillLayerId = `${this.id}:fill`;
    const lineLayerId = `${this.id}:line`;
    this.layerIds.push(fillLayerId, lineLayerId);
    this.map.addLayer({
      id: fillLayerId,
      metadata: {
        flatOptions: this.options,
      },
      paint: {
        "fill-color": this.options.fillColor ?? this.options.color ?? "#14b8a6",
        "fill-opacity": this.options.fillOpacity ?? 0.2,
      },
      source: this.sourceId,
      type: "fill",
    } as never);
    this.map.addLayer({
      id: lineLayerId,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      metadata: {
        flatOptions: this.options,
      },
      paint: {
        "line-color": this.options.color ?? "#0f766e",
        "line-opacity": this.options.opacity ?? 1,
        "line-width": this.options.weight ?? 2,
      },
      source: this.sourceId,
      type: "line",
    } as never);
  }

  private getData(): GeoJSON.Feature {
    return {
      geometry:
        this.coordinates.length === 1
          ? {
              coordinates: this.coordinates[0]!,
              type: "Polygon",
            }
          : {
              coordinates: this.coordinates,
              type: "MultiPolygon",
            },
      properties: {},
      type: "Feature",
    };
  }
}

class MapLibreImageLayer extends MapLibreSourceLayer {
  private url: string;
  private bounds: [[number, number], [number, number]];
  private opacity: number;
  private readonly options: FlatLayerOptions;

  constructor(
    map: MapLibreMap,
    url: string,
    bounds: [[number, number], [number, number]],
    options: FlatLayerOptions,
  ) {
    super(map);
    this.url = url;
    this.bounds = bounds;
    this.opacity = options.opacity ?? 1;
    this.options = options;
  }

  setBounds(bounds: [[number, number], [number, number]]) {
    this.bounds = bounds;
    this.renderImageSource();
    this.updateFlatImageOverlay({ bounds });
    return this;
  }

  setOpacity(opacity: number) {
    this.opacity = opacity;
    const layerId = this.layerIds[0];

    if (layerId && this.map.getLayer(layerId)) {
      this.map.setPaintProperty(layerId, "raster-opacity", opacity);
    }
    this.updateFlatImageOverlay({ opacity });

    return this;
  }

  setUrl(url: string) {
    this.url = url;
    this.renderImageSource();
    this.updateFlatImageOverlay({ url });
    return this;
  }

  protected render() {
    this.renderImageSource();
    const layerId = `${this.id}:raster`;
    this.layerIds.push(layerId);
    this.map.addLayer({
      id: layerId,
      metadata: {
        flatOptions: {
          ...this.options,
          opacity: this.opacity,
        },
      },
      paint: {
        "raster-opacity": this.opacity,
      },
      source: this.sourceId,
      type: "raster",
    } as never);
  }

  private renderImageSource() {
    const coordinates = this.getImageCoordinates();
    const source = this.map.getSource(this.sourceId) as ImageSource | undefined;

    if (source && typeof source.updateImage === "function") {
      source.updateImage({
        coordinates,
        url: this.url,
      });
      return;
    }

    removeMapLibreSourceIfExists(this.map, this.sourceId);
    this.map.addSource(this.sourceId, {
      coordinates,
      type: "image",
      url: this.url,
    } as never);
  }

  private getImageCoordinates(): Coordinates {
    const [[south, west], [north, east]] = this.bounds;

    return [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];
  }

  private updateFlatImageOverlay(next: {
    bounds?: [[number, number], [number, number]];
    opacity?: number;
    url?: string;
  }) {
    const layerId = this.layerIds[0];

    if (!layerId) {
      return;
    }

    (
      this.map as unknown as {
        __mbUpdateFlatImageOverlay?: (
          layerId: string,
          next: {
            bounds?: [[number, number], [number, number]];
            opacity?: number;
            url?: string;
          },
        ) => void;
      }
    ).__mbUpdateFlatImageOverlay?.(layerId, next);
  }
}

class MapLibreDomMarkerLayer implements FlatLayer {
  private group: FlatLayerGroup | null = null;
  private marker: MapLibreMarker | null = null;

  constructor(
    private readonly maplibre: typeof import("maplibre-gl"),
    private readonly map: MapLibreMap,
    private coordinates: [number, number],
    private readonly options: FlatMarkerOptions,
  ) {}

  addTo(group: FlatLayerGroup) {
    this.group = group;

    if (!group.layers.includes(this)) {
      group.layers.push(this);
    }

    const icon = this.options.icon;
    const testGroup = group as unknown as {
      clearActiveTestLayerGroup?: () => void;
      setAsActiveTestLayerGroup?: () => void;
    };

    testGroup.setAsActiveTestLayerGroup?.();
    try {
      (
        this.map as unknown as {
          __mbAddFlatMarker?: (coordinates: [number, number], options: FlatMarkerOptions) => void;
        }
      ).__mbAddFlatMarker?.(this.coordinates, this.options);
    } finally {
      testGroup.clearActiveTestLayerGroup?.();
    }

    const element = document.createElement("div");
    element.className = icon?.className ?? "mb-maps__marker";
    element.innerHTML = icon?.html ?? "";
    element.style.opacity = String(this.options.opacity ?? 1);

    if (icon?.iconSize) {
      element.style.width = `${icon.iconSize[0]}px`;
      element.style.height = `${icon.iconSize[1]}px`;
    }

    this.marker = new this.maplibre.Marker({
      element,
      offset: resolveMapLibreMarkerOffset(icon),
    })
      .setLngLat(this.coordinates as LngLatLike)
      .addTo(this.map);

    return this;
  }

  bindTooltip() {
    return this;
  }

  on() {
    return this;
  }

  openTooltip() {
    return this;
  }

  remove() {
    this.marker?.remove();
    this.marker = null;
  }

  setLatLng(latLng: [number, number]) {
    this.coordinates = latLngToLngLat(latLng);
    this.marker?.setLngLat(this.coordinates as LngLatLike);

    return this;
  }
}

export function resolveMapLibreMarkerOffset(
  icon: FlatDivIconOptions | undefined,
): [number, number] | undefined {
  if (!icon?.iconAnchor) {
    return undefined;
  }

  const [anchorX, anchorY] = icon.iconAnchor;
  const [width, height] = icon.iconSize ?? [0, 0];

  return [width / 2 - anchorX, height / 2 - anchorY];
}

function normalizeLineCoordinates(latLngs: unknown): GeoJSON.Position[][] {
  if (!Array.isArray(latLngs) || latLngs.length === 0) {
    return [];
  }

  if (isLatLng(latLngs[0])) {
    return [(latLngs as Array<[number, number]>).map(latLngToLngLat)];
  }

  return (latLngs as unknown[]).flatMap((line) => normalizeLineCoordinates(line));
}

function normalizePolygonCoordinates(latLngs: unknown): GeoJSON.Position[][][] {
  if (!Array.isArray(latLngs) || latLngs.length === 0) {
    return [];
  }

  if (isLatLng(latLngs[0])) {
    return [[(latLngs as Array<[number, number]>).map(latLngToLngLat)]];
  }

  if (Array.isArray(latLngs[0]) && isLatLng((latLngs[0] as unknown[])[0])) {
    return [(latLngs as Array<Array<[number, number]>>).map((ring) => ring.map(latLngToLngLat))];
  }

  return (latLngs as unknown[]).flatMap((polygon) => normalizePolygonCoordinates(polygon));
}

function isLatLng(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function latLngToLngLat([latitude, longitude]: [number, number]) {
  return [longitude, latitude] as [number, number];
}

function toFlatPointerEvent(event: unknown): FlatPointerEvent {
  const record = event as {
    lngLat?: { lat: number; lng: number };
    originalEvent?: FlatPointerEvent["originalEvent"];
    point?: { x: number; y: number };
  };

  return {
    containerPoint: record.point,
    latlng: record.lngLat ? { lat: record.lngLat.lat, lng: record.lngLat.lng } : undefined,
    originalEvent: record.originalEvent,
  };
}

type EventedMap = {
  off: {
    (event: string, handler: (event: unknown) => void): void;
    (event: string, layerId: string, handler: (event: unknown) => void): void;
  };
  on: {
    (event: string, handler: (event: unknown) => void): void;
    (event: string, layerId: string, handler: (event: unknown) => void): void;
  };
};

function usesMapLevelHitTestFallback(event: string) {
  return event === "click" || event === "contextmenu" || event === "dblclick" || event === "mousedown";
}

function getMarkerConstructor(map: MapLibreMap) {
  return (map as unknown as { _mbMarkerConstructor?: typeof import("maplibre-gl").Marker })
    ._mbMarkerConstructor!;
}

export function attachMapLibreMarkerConstructor(
  map: MapLibreMap,
  marker: typeof import("maplibre-gl").Marker,
) {
  (map as unknown as { _mbMarkerConstructor?: typeof import("maplibre-gl").Marker })._mbMarkerConstructor = marker;
}
