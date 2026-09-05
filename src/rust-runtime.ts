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

export type MapsRustRuntime = {
  boundsFromPoints(points: readonly MapsRustPointInput[]): [number, number, number, number] | null;
  normalizePoints(points: readonly MapsRustPointInput[]): MapsRustIndexedPoint[];
};

type MapsWasmPointInput = Omit<MapsRustPointInput, "id"> & {
  id?: string;
};

type MapsWasmModule = {
  default?: (moduleOrPath?: unknown) => Promise<unknown>;
  boundsFromMapPoints(points: readonly MapsWasmPointInput[]): unknown;
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

function parseIndexedPoints(value: unknown): MapsRustIndexedPoint[] {
  if (!Array.isArray(value)) {
    throw new Error("Maps WASM returned invalid normalized points.");
  }

  return value.map((point) => {
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
  });
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
