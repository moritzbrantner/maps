import * as flat from "flat";

type Handler = (...args: unknown[]) => void;
const flatRuntime = flat as unknown as {
  circleMarker: (...args: never[]) => { addTo: (group: unknown) => unknown };
  imageOverlay: (...args: never[]) => { addTo: (group: unknown) => unknown };
  layerGroup: () => unknown;
  marker?: (...args: never[]) => { addTo: (group: unknown) => unknown };
  map: () => {
    containerPointToLatLng: (point: [number, number]) => { lat: number; lng: number };
    latLngToContainerPoint: (latLng: [number, number]) => { x: number; y: number };
  };
  polygon: (...args: never[]) => { addTo: (group: unknown) => unknown };
  polyline: (...args: never[]) => { addTo: (group: unknown) => unknown };
};

export class Map {
  private baseMap: ReturnType<typeof flatRuntime.map>;
  private center = { lat: 25, lng: 12 };
  private handlers = new globalThis.Map<string, Handler[]>();
  private activeLayerGroup: unknown = null;
  private fallbackLayerGroup: unknown = null;
  private layers = new globalThis.Map<string, unknown>();
  private mockLayers = new globalThis.Map<string, unknown>();
  private maxBounds: [[number, number], [number, number]] | null = null;
  private minZoom = 0;
  private sources = new globalThis.Map<
    string,
    {
      coordinates?: Array<[number, number]>;
      data?: unknown;
      setData: (data: unknown) => void;
      updateImage?: (next: {
        coordinates?: Array<[number, number]>;
        url: string;
      }) => void;
      url?: string;
    }
  >();
  private zoom = 5;

  constructor(options: {
    center?: [number, number];
    container?: HTMLElement;
    maxBounds?: [[number, number], [number, number]];
    minZoom?: number;
    zoom?: number;
  }) {
    const baseMap = flatRuntime.map();
    this.baseMap = baseMap;

    this.center = {
      lat: options.center?.[1] ?? 25,
      lng: options.center?.[0] ?? 12,
    };
    this.maxBounds = options.maxBounds ?? null;
    this.minZoom = options.minZoom ?? this.minZoom;
    this.zoom = options.zoom ?? this.zoom;

    queueMicrotask(() => {
      this.fire("load");
    });
  }

  addControl() {}

  __mbCreateFlatLayerGroup() {
    return flatRuntime.layerGroup();
  }

  __mbSetActiveFlatLayerGroup(group: unknown) {
    this.activeLayerGroup = group;
  }

  __mbOpenFlatTooltip(
    layerId: string,
    label: string,
    options: Record<string, unknown> | undefined,
    latLng: [number, number] | undefined,
  ) {
    const layer = this.mockLayers.get(layerId) as
      | {
          bindTooltip?: (label: string, options?: Record<string, unknown>) => unknown;
          openTooltip?: (latLng?: [number, number]) => unknown;
        }
      | undefined;

    layer?.bindTooltip?.(label, options);
    layer?.openTooltip?.(latLng);
  }

  __mbBindFlatTooltip(layerId: string, label: string, options: Record<string, unknown> | undefined) {
    const layer = this.mockLayers.get(layerId) as
      | {
          bindTooltip?: (label: string, options?: Record<string, unknown>) => unknown;
        }
      | undefined;

    layer?.bindTooltip?.(label, options);
  }

  __mbUpdateFlatImageOverlay(
    layerId: string,
    next: { bounds?: [[number, number], [number, number]]; opacity?: number; url?: string },
  ) {
    const layer = this.mockLayers.get(layerId) as
      | {
          bounds?: [[number, number], [number, number]];
          options?: Record<string, unknown>;
          url?: string;
        }
      | undefined;

    if (!layer) {
      return;
    }

    if (next.bounds) {
      layer.bounds = next.bounds;
    }

    if (typeof next.opacity === "number") {
      layer.options = { ...layer.options, opacity: next.opacity };
    }

    if (next.url) {
      layer.url = next.url;
    }
  }

  __mbAddFlatMarker(coordinates: [number, number], options: Record<string, unknown>) {
    if (!flatRuntime.marker) {
      return null;
    }

    const legacyOptions = options.icon
      ? {
          ...options,
          icon: {
            options: options.icon,
            type: "divIcon",
          },
        }
      : options;

    return flatRuntime.marker(toLatLng(coordinates) as never, legacyOptions as never).addTo(
      this.getCurrentLayerGroup() as never,
    );
  }

  containerPointToLatLng(point: [number, number]) {
    return this.baseMap.containerPointToLatLng(point);
  }

  addLayer(layer: {
    id: string;
    metadata?: { flatOptions?: Record<string, unknown> };
    paint?: Record<string, unknown>;
    source?: string;
    type: string;
  }) {
    this.layers.set(layer.id, layer);
    const source = layer.source ? this.sources.get(layer.source) : null;
    const data = source?.data as GeoJSON.Feature | undefined;
    const geometry = data?.geometry;
    const coordinates = geometry && "coordinates" in geometry ? geometry.coordinates : undefined;
    const flatOptions = layer.metadata?.flatOptions ?? {};

    if (layer.type === "line" && (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon")) {
      return;
    }

    if (layer.type === "circle") {
      const point = Array.isArray(coordinates) && typeof coordinates[0] === "number"
        ? ([coordinates[1], coordinates[0]] as [number, number])
        : ([0, 0] as [number, number]);
      const mockLayer = flatRuntime.circleMarker(point as never, {
        ...flatOptions,
        fillColor: layer.paint?.["circle-color"] as string | undefined,
        radius: layer.paint?.["circle-radius"] as number | undefined,
        weight: layer.paint?.["circle-stroke-width"] as number | undefined,
      } as never).addTo(this.getCurrentLayerGroup() as never);
      this.mockLayers.set(layer.id, mockLayer);
      return;
    }

    if (layer.type === "line") {
      const mockLayer = flatRuntime.polyline(toLatLngCoordinates(coordinates) as never, {
        ...flatOptions,
        color: layer.paint?.["line-color"] as string | undefined,
        opacity: layer.paint?.["line-opacity"] as number | undefined,
        weight: layer.paint?.["line-width"] as number | undefined,
      } as never).addTo(this.getCurrentLayerGroup() as never);
      this.mockLayers.set(layer.id, mockLayer);
      return;
    }

    if (layer.type === "fill") {
      const mockLayer = flatRuntime.polygon(toLatLngCoordinates(coordinates) as never, {
        ...flatOptions,
        fillColor: layer.paint?.["fill-color"] as string | undefined,
        fillOpacity: layer.paint?.["fill-opacity"] as number | undefined,
      } as never).addTo(this.getCurrentLayerGroup() as never);
      this.mockLayers.set(layer.id, mockLayer);
      return;
    }

    if (layer.type === "raster") {
      const imageSource = source as
        | {
            coordinates?: Array<[number, number]>;
            url?: string;
          }
        | undefined;
      const mockLayer = flatRuntime.imageOverlay((imageSource?.url ?? "") as never, imageCoordinatesToBounds(imageSource?.coordinates) as never, {
        ...flatOptions,
        opacity: layer.paint?.["raster-opacity"] as number | undefined,
      } as never).addTo(this.getCurrentLayerGroup() as never);
      this.mockLayers.set(layer.id, mockLayer);
    }
  }

  addSource(id: string, source: { data?: unknown }) {
      this.sources.set(id, {
        data: source.data,
        setData: (data) => {
          const current = this.sources.get(id);

          if (current) {
            current.data = data;
          }

          this.updateMockLayersForSource(id);
        },
        updateImage: (next) => {
          const current = this.sources.get(id);

          if (!current) {
            return;
          }

          current.url = next.url;
          current.coordinates = next.coordinates ?? current.coordinates;
          this.updateMockLayersForImageSource(id);
        },
        ...(source as Record<string, unknown>),
      });
  }

  dragPan = {
    disable() {},
    enable() {},
  };

  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(normalizeEventPayload(payload));
    }
  }

  getCenter() {
    return this.center;
  }

  getBounds() {
    return (this.baseMap as unknown as { getBounds: () => unknown }).getBounds();
  }

  getContainer() {
    return (this.baseMap as unknown as { getContainer: () => HTMLElement }).getContainer();
  }

  getZoom() {
    return (this.baseMap as unknown as { getZoom?: () => number }).getZoom?.() ?? this.zoom;
  }

  getMaxBounds() {
    return this.maxBounds;
  }

  getMinZoom() {
    return this.minZoom;
  }

  getLayer(id: string) {
    return this.layers.get(id);
  }

  getSource(id: string) {
    return this.sources.get(id);
  }

  private getCurrentLayerGroup() {
    if (this.activeLayerGroup) {
      return this.activeLayerGroup;
    }

    this.fallbackLayerGroup ??= flatRuntime.layerGroup();
    return this.fallbackLayerGroup;
  }

  jumpTo(options: { center?: [number, number]; zoom?: number }) {
    if (options.center) {
      this.center = { lat: options.center[1], lng: options.center[0] };
    }

    if (typeof options.zoom === "number") {
      this.zoom = Math.max(this.minZoom, options.zoom);
    }
  }

  flyTo(options: { center?: [number, number]; zoom?: number }) {
    this.jumpTo(options);
  }

  fitBounds(
    bounds: [[number, number], [number, number]],
    options: { maxZoom?: number } = {},
  ) {
    const west = bounds[0][0];
    const south = bounds[0][1];
    const east = bounds[1][0];
    const north = bounds[1][1];
    const camera = this.cameraForBounds(bounds);

    this.center = {
      lat: (south + north) / 2,
      lng: (west + east) / 2,
    };
    this.zoom = Math.max(this.minZoom, Math.min(options.maxZoom ?? Number.POSITIVE_INFINITY, camera.zoom));
  }

  cameraForBounds(bounds: [[number, number], [number, number]]) {
    const west = bounds[0][0];
    const south = bounds[0][1];
    const east = bounds[1][0];
    const north = bounds[1][1];
    const longitudeSpan = Math.max(1e-6, Math.abs(east - west));
    const latitudeSpan = Math.max(1e-6, Math.abs(north - south));
    const zoom = Math.max(0, Math.log2(Math.min(360 / longitudeSpan, 180 / latitudeSpan)));

    return { zoom };
  }

  moveLayer() {}

  off(event: string, ...args: unknown[]) {
    const handler = args.at(-1) as Handler;
    const handlers = this.handlers.get(event) ?? [];

    this.handlers.set(event, handlers.filter((candidate) => candidate !== handler));

    if (args.length === 1) {
      (this.baseMap as unknown as { off?: (event: string, handler: Handler) => void }).off?.(
        event,
        handler,
      );
    }
  }

  on(event: string, ...args: unknown[]) {
    const handler = args.at(-1) as Handler;
    const handlers = this.handlers.get(event) ?? [];

    handlers.push(handler);
    this.handlers.set(event, handlers);

    if (args.length === 1) {
      (this.baseMap as unknown as { on?: (event: string, handler: Handler) => void }).on?.(
        event,
        (payload) => handler(normalizeEventPayload(payload)),
      );
    } else if (typeof args[0] === "string") {
      this.addMockLayerHandler(args[0], event, handler);
    }
  }

  once(event: string, handler: Handler) {
    const onceHandler = (...args: unknown[]) => {
      this.off(event, onceHandler);
      handler(...args);
    };

    this.on(event, onceHandler);
  }

  project(coordinate: [number, number]) {
    return this.baseMap.latLngToContainerPoint([coordinate[1], coordinate[0]]);
  }

  remove() {
    (this.baseMap as unknown as { remove: () => void }).remove();
  }

  removeLayer(id: string) {
    (this.mockLayers.get(id) as { remove?: () => void } | undefined)?.remove?.();
    this.layers.delete(id);
    this.mockLayers.delete(id);
  }

  removeSource(id: string) {
    this.sources.delete(id);
  }

  setPaintProperty() {}

  setMaxBounds(bounds: [[number, number], [number, number]] | null) {
    this.maxBounds = bounds;
  }

  setMinZoom(zoom: number) {
    this.minZoom = zoom;
    this.zoom = Math.max(this.zoom, zoom);
  }

  unproject(point: [number, number]) {
    return this.baseMap.containerPointToLatLng(point);
  }

  private addMockLayerHandler(layerId: string, event: string, handler: Handler) {
    const layer = this.mockLayers.get(layerId) as
      | {
          on?: (event: string, handler: Handler) => unknown;
        }
      | undefined;

    layer?.on?.(event, (payload) => handler(normalizeEventPayload(payload)));

    if (event === "mouseenter") {
      layer?.on?.("mouseover", (payload) => handler(normalizeEventPayload(payload)));
    } else if (event === "mouseleave") {
      layer?.on?.("mouseout", (payload) => handler(normalizeEventPayload(payload)));
    }
  }

  private updateMockLayersForSource(sourceId: string) {
    const source = this.sources.get(sourceId);
    const data = source?.data as GeoJSON.Feature | undefined;
    const coordinates = data?.geometry && "coordinates" in data.geometry ? data.geometry.coordinates : undefined;

    for (const [layerId, layerDefinition] of this.layers) {
      const layer = layerDefinition as { source?: string; type?: string };

      if (layer.source !== sourceId) {
        continue;
      }

      const mockLayer = this.mockLayers.get(layerId) as
        | {
            latLng?: [number, number];
            latLngs?: unknown;
          }
        | undefined;

      if (!mockLayer) {
        continue;
      }

      if (layer.type === "circle" && Array.isArray(coordinates) && typeof coordinates[0] === "number") {
        mockLayer.latLng = toLatLng(coordinates as [number, number]);
      } else {
        mockLayer.latLngs = toLatLngCoordinates(coordinates);
      }
    }
  }

  private updateMockLayersForImageSource(sourceId: string) {
    const source = this.sources.get(sourceId);

    for (const [layerId, layerDefinition] of this.layers) {
      const layer = layerDefinition as { source?: string; type?: string };

      if (layer.source !== sourceId || layer.type !== "raster") {
        continue;
      }

      const mockLayer = this.mockLayers.get(layerId) as
        | {
            bounds?: [[number, number], [number, number]];
            url?: string;
          }
        | undefined;

      if (!mockLayer) {
        continue;
      }

      mockLayer.bounds = imageCoordinatesToBounds(source?.coordinates);
      mockLayer.url = source?.url;
    }
  }
}

function normalizeEventPayload(payload: unknown) {
  if (
    payload &&
    typeof payload === "object" &&
    "latlng" in payload &&
    !("lngLat" in payload)
  ) {
    const event = payload as {
      containerPoint?: { x: number; y: number };
      latlng?: { lat?: number; lng?: number };
      originalEvent?: unknown;
    };

    return {
      ...event,
      lngLat: {
        lat: event.latlng?.lat ?? 0,
        lng: event.latlng?.lng ?? 0,
      },
      point: event.containerPoint ?? { x: 0, y: 0 },
    };
  }

  return payload;
}

function toLatLng([longitude, latitude]: [number, number]) {
  return [latitude, longitude] as [number, number];
}

function toLatLngCoordinates(coordinates: unknown): unknown {
  if (!Array.isArray(coordinates)) {
    return coordinates;
  }

  if (coordinates.length >= 2 && typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    return toLatLng(coordinates as [number, number]);
  }

  return coordinates.map(toLatLngCoordinates);
}

function imageCoordinatesToBounds(coordinates: Array<[number, number]> | undefined) {
  if (!coordinates || coordinates.length < 4) {
    return undefined;
  }

  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);

  return [
    [Math.min(...latitudes), Math.min(...longitudes)],
    [Math.max(...latitudes), Math.max(...longitudes)],
  ] as [[number, number], [number, number]];
}

export class Marker {
  addTo() {
    return this;
  }

  remove() {}

  setLngLat() {
    return this;
  }
}

export class NavigationControl {}
