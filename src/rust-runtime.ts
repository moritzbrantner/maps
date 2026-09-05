export type MapsRustMetricRecord = Record<string, number>;

export type MapsRustPointInput = {
  id?: string | number;
  label?: string;
  latitude: number;
  longitude: number;
  metrics?: MapsRustMetricRecord;
};

export type MapsRustIndexedPoint = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  metrics: MapsRustMetricRecord;
};

export type MapsRustPointAggregationOptions = {
  extent?: number;
  maxZoom?: number;
  minZoom?: number;
  radius?: number;
};

export type MapsRustViewportAggregationQuery = {
  bounds: [number, number, number, number];
  zoom: number;
};

export type MapsRustAggregatedFeature =
  | {
      clusterId: number;
      coordinates: [number, number];
      expansionZoom: number;
      kind: "cluster";
      metrics: MapsRustMetricRecord;
      pointCount: number;
      pointCountAbbreviated: string;
    }
  | {
      coordinates: [number, number];
      kind: "point";
      metrics: MapsRustMetricRecord;
      pointId: string;
    };

export type MapsRustViewportAggregation = {
  features: MapsRustAggregatedFeature[];
  summary: {
    bounds: [number, number, number, number];
    metrics: MapsRustMetricRecord;
    visibleClusterCount: number;
    visiblePointCount: number;
    visibleUnclusteredCount: number;
    zoom: number;
  };
};

export type MapsRustPointAggregationIndex = {
  getClusterExpansionZoom(clusterId: number): number;
  getClusterLeaves(clusterId: number, limit?: number, offset?: number): MapsRustIndexedPoint[];
  getPointById(pointId: string): MapsRustIndexedPoint | null;
  getViewportAggregation(query: MapsRustViewportAggregationQuery): MapsRustViewportAggregation;
};

export type MapsRustRuntime = {
  boundsFromPoints(points: readonly MapsRustPointInput[]): [number, number, number, number] | null;
  createPointAggregationIndex(
    points: readonly MapsRustIndexedPoint[],
    options?: MapsRustPointAggregationOptions,
  ): MapsRustPointAggregationIndex;
  normalizePoints(points: readonly MapsRustPointInput[]): MapsRustIndexedPoint[];
};

type MapsWasmPointInput = Omit<MapsRustPointInput, "id"> & {
  id?: string;
};

type MapsWasmPointAggregationIndex = {
  getClusterExpansionZoom(clusterId: number): unknown;
  getClusterLeaves(clusterId: number, limit: number, offset: number): unknown;
  getPointById(pointId: string): unknown;
  getViewportAggregation(query: MapsRustViewportAggregationQuery): unknown;
};

type MapsWasmPointAggregationIndexConstructor = new (
  points: readonly MapsRustIndexedPoint[],
  options: MapsRustPointAggregationOptions,
) => MapsWasmPointAggregationIndex;

type MapsWasmModule = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  boundsFromMapPoints(points: readonly MapsWasmPointInput[]): unknown;
  MapsPointAggregationIndex?: MapsWasmPointAggregationIndexConstructor;
  normalizeMapPoints(points: readonly MapsWasmPointInput[]): unknown;
};

export async function loadMapsRustRuntime(packageName: string): Promise<MapsRustRuntime> {
  if (!packageName) {
    throw new Error("No Maps-owned WASM package configured.");
  }

  const wasmModule = await importOptionalWasmModule(packageName);
  await wasmModule.default?.();

  return createMapsRustRuntimeFromModule(wasmModule);
}

export function createMapsRustRuntimeFromModule(wasmModule: MapsWasmModule): MapsRustRuntime {
  return {
    boundsFromPoints(points) {
      return parseBounds(wasmModule.boundsFromMapPoints(points.map(toWasmPoint)));
    },
    createPointAggregationIndex(points, options = {}) {
      const Constructor = wasmModule.MapsPointAggregationIndex;
      if (!Constructor) {
        throw new Error("Maps WASM point aggregation is unavailable.");
      }

      const index = new Constructor(points, options);
      return {
        getClusterExpansionZoom(clusterId) {
          return parseNonNegativeInteger(
            index.getClusterExpansionZoom(clusterId),
            "cluster expansion zoom",
          );
        },
        getClusterLeaves(clusterId, limit = 10, offset = 0) {
          return parseIndexedPoints(index.getClusterLeaves(clusterId, limit, offset));
        },
        getPointById(pointId) {
          const point = index.getPointById(pointId);
          return point === null || point === undefined ? null : parseIndexedPoint(point);
        },
        getViewportAggregation(query) {
          return parseViewportAggregation(index.getViewportAggregation(query));
        },
      };
    },
    normalizePoints(points) {
      return parseIndexedPoints(wasmModule.normalizeMapPoints(points.map(toWasmPoint)));
    },
  };
}

function toWasmPoint(point: MapsRustPointInput): MapsWasmPointInput {
  return {
    id: point.id === undefined ? undefined : String(point.id),
    label: point.label,
    latitude: point.latitude,
    longitude: point.longitude,
    metrics: point.metrics ?? {},
  };
}

function parseBounds(value: unknown): [number, number, number, number] | null {
  if (value === null) {
    return null;
  }

  if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber)) {
    throw new Error("Maps WASM returned invalid bounds.");
  }

  return [value[0], value[1], value[2], value[3]];
}

function parseViewportAggregation(value: unknown): MapsRustViewportAggregation {
  if (!isRecord(value) || !Array.isArray(value.features) || !isRecord(value.summary)) {
    throw new Error("Maps WASM returned invalid viewport aggregation.");
  }

  const summary = value.summary;
  const bounds = parseBounds(summary.bounds);
  if (
    bounds === null ||
    !isMetricRecord(summary.metrics) ||
    !isFiniteNumber(summary.zoom)
  ) {
    throw new Error("Maps WASM returned invalid viewport aggregation summary.");
  }

  return {
    features: value.features.map(parseAggregatedFeature),
    summary: {
      bounds,
      metrics: summary.metrics,
      visibleClusterCount: parseNonNegativeInteger(
        summary.visibleClusterCount,
        "visible cluster count",
      ),
      visiblePointCount: parseNonNegativeInteger(summary.visiblePointCount, "visible point count"),
      visibleUnclusteredCount: parseNonNegativeInteger(
        summary.visibleUnclusteredCount,
        "visible unclustered count",
      ),
      zoom: summary.zoom,
    },
  };
}

function parseAggregatedFeature(value: unknown): MapsRustAggregatedFeature {
  if (!isRecord(value) || !parseCoordinates(value.coordinates) || !isMetricRecord(value.metrics)) {
    throw new Error("Maps WASM returned an invalid aggregation feature.");
  }

  const coordinates = parseCoordinates(value.coordinates)!;
  if (value.kind === "cluster") {
    if (typeof value.pointCountAbbreviated !== "string") {
      throw new Error("Maps WASM returned an invalid cluster feature.");
    }

    return {
      clusterId: parseNonNegativeInteger(value.clusterId, "cluster id"),
      coordinates,
      expansionZoom: parseNonNegativeInteger(value.expansionZoom, "expansion zoom"),
      kind: "cluster",
      metrics: value.metrics,
      pointCount: parseNonNegativeInteger(value.pointCount, "point count"),
      pointCountAbbreviated: value.pointCountAbbreviated,
    };
  }

  if (value.kind === "point" && typeof value.pointId === "string") {
    return {
      coordinates,
      kind: "point",
      metrics: value.metrics,
      pointId: value.pointId,
    };
  }

  throw new Error("Maps WASM returned an invalid aggregation feature.");
}

function parseCoordinates(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
    ? [value[0], value[1]]
    : null;
}

function parseIndexedPoints(value: unknown): MapsRustIndexedPoint[] {
  if (!Array.isArray(value)) {
    throw new Error("Maps WASM returned invalid normalized points.");
  }

  return value.map(parseIndexedPoint);
}

function parseIndexedPoint(point: unknown): MapsRustIndexedPoint {
  if (!isRecord(point)) {
    throw new Error("Maps WASM returned an invalid normalized point.");
  }

  const { id, label, latitude, longitude, metrics } = point;
  if (
    typeof id !== "string" ||
    typeof label !== "string" ||
    !isFiniteNumber(latitude) ||
    !isFiniteNumber(longitude) ||
    !isMetricRecord(metrics)
  ) {
    throw new Error("Maps WASM returned an invalid normalized point.");
  }

  return {
    id,
    label,
    latitude,
    longitude,
    metrics,
  };
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Maps WASM returned invalid ${label}.`);
  }

  return value;
}

function isMetricRecord(value: unknown): value is MapsRustMetricRecord {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function importOptionalWasmModule(packageName: string): Promise<MapsWasmModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<MapsWasmModule>;

  return dynamicImport(packageName);
}
