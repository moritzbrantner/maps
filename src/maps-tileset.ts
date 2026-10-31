/** Versioned data-only contract; style and historical interpretation are separate inputs. */
export type MapsTilesetMetadata = {
  version: 1;
  sourceId: string;
  dataRevision: string;
  format: "mvt";
  schema: { id: "shortbread"; version: "1.0"; sourceLayers: readonly string[] };
  projection: "web-mercator";
  scheme: "xyz";
  /** West, south, east, north. West > east denotes antimeridian coverage. */
  bounds: readonly [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  tileSize: 256 | 512;
  attribution: string;
  license: string;
  provenance: string;
  observation?: { snapshot: string; effectiveDate?: string };
};

/** A metadata-valid artifact becomes activatable only with a supported transport. */
export type MapsTileset = MapsTilesetMetadata & {
  /** Future archive transports extend this boundary, without changing canonical tile identity. */
  transport: { kind: "xyz"; urlTemplate: string };
};

const SOURCE_LAYERS = [
  "ocean",
  "water_polygons",
  "land",
  "sites",
  "buildings",
  "water_lines",
  "streets",
  "boundaries",
];
const MERCATOR_LATITUDE = 85.0511287798066;

const fail = (message: string): never => {
  throw new Error(`Maps Tileset: ${message}`);
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected manifest object");
  }
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    return fail("required metadata is missing or too long");
  }
  return value;
};

/** Validate/copy common producer metadata. This does not grant archive or activation support. */
export function validateMapsTilesetMetadata(input: unknown): MapsTilesetMetadata {
  const value = record(input);
  if (
    value.version !== 1 ||
    value.format !== "mvt" ||
    value.projection !== "web-mercator" ||
    value.scheme !== "xyz"
  ) {
    fail("only version 1 MVT XYZ Web Mercator is supported");
  }
  const schema = record(value.schema);
  if (schema.id !== "shortbread" || schema.version !== "1.0") {
    fail("requires compatible Shortbread 1.0 schema");
  }
  const layers = schema.sourceLayers;
  if (
    !Array.isArray(layers) ||
    !layers.length ||
    layers.length > SOURCE_LAYERS.length ||
    layers.some((layer) => typeof layer !== "string" || !SOURCE_LAYERS.includes(layer))
  ) {
    return fail("unsupported Shortbread source layers");
  }
  const minZoom = value.minZoom;
  const maxZoom = value.maxZoom;
  if (
    typeof minZoom !== "number" ||
    typeof maxZoom !== "number" ||
    !Number.isInteger(minZoom) ||
    !Number.isInteger(maxZoom) ||
    minZoom < 0 ||
    maxZoom > 31 ||
    minZoom > maxZoom
  ) {
    return fail("invalid zoom range");
  }
  const tileSize = value.tileSize;
  if (tileSize !== 256 && tileSize !== 512) {
    return fail("tileSize must be 256 or 512");
  }
  const bounds = value.bounds;
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return fail("invalid coverage bounds");
  }
  const [west, south, east, north] = bounds as number[];
  if (
    west! < -180 ||
    west! > 180 ||
    east! < -180 ||
    east! > 180 ||
    west === east ||
    south! < -MERCATOR_LATITUDE ||
    north! > MERCATOR_LATITUDE ||
    south! >= north!
  ) {
    return fail("invalid coverage bounds");
  }
  const observation = value.observation === undefined ? undefined : record(value.observation);
  return {
    version: 1,
    sourceId: text(value.sourceId),
    dataRevision: text(value.dataRevision),
    format: "mvt",
    schema: { id: "shortbread", version: "1.0", sourceLayers: [...layers] },
    projection: "web-mercator",
    scheme: "xyz",
    bounds: [west!, south!, east!, north!],
    minZoom,
    maxZoom,
    tileSize,
    attribution: text(value.attribution),
    license: text(value.license),
    provenance: text(value.provenance),
    ...(observation
      ? {
          observation: {
            snapshot: text(observation.snapshot),
            ...(observation.effectiveDate === undefined
              ? {}
              : { effectiveDate: text(observation.effectiveDate) }),
          },
        }
      : {}),
  };
}

/** Validate the complete activatable source; metadata validity alone is insufficient. */
export function validateMapsTileset(input: unknown): MapsTileset {
  const metadata = validateMapsTilesetMetadata(input);
  const value = record(input);
  const transport = record(value.transport);
  if (transport.kind !== "xyz" || typeof transport.urlTemplate !== "string") {
    return fail("unsupported transport; expected XYZ");
  }
  const urlTemplate = transport.urlTemplate;
  if (
    urlTemplate.length > 8192 ||
    !["{z}", "{x}", "{y}"].every((token) => urlTemplate.includes(token)) ||
    !/^(https?:\/\/|\/)/.test(urlTemplate)
  ) {
    fail("XYZ requires an HTTP(S) or root-relative z/x/y template");
  }
  return { ...metadata, transport: { kind: "xyz", urlTemplate } };
}
