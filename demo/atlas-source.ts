import { validateMapsTileset, type MapsTileset } from "../src/maps-tileset";

/** Exact reviewed Asset Tooling #409 output; resolved by the #270 Pages build. */
const source = {
  provider: "Geofabrik",
  url: "https://download.geofabrik.de/europe/liechtenstein-261025.osm.pbf",
  sha256: "bd5cca3fdcb4e9900ad74b4c33e554750088705bd4b4deaa35c1517d7be2378b",
  snapshot: "2026-10-25T21:21:21Z",
  license: "ODbL-1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright",
} as const;

const profileSha256 = "dfabde2760810c4a1d3431543742addae23e1882a55beeffe939af66eee16d70";
const planetilerSha256 = "f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d";
const provenance =
  `Geofabrik Liechtenstein PBF ${source.sha256}; Planetiler 0.10.2 JAR ${planetilerSha256}; ` +
  `profile ${profileSha256}. Published and content-pinned for Maps #270; browser transport is independently verified by Maps.`;

const regions = [
  {
    sourceId: "maps-liechtenstein",
    archiveSha256: "749bc3ac9a430b41fb7613686b7898b43ed11d8e8321624559ea591f49cc8fdf",
    archiveBytes: 2_780_045,
    archiveName:
      "liechtenstein-749bc3ac9a430b41fb7613686b7898b43ed11d8e8321624559ea591f49cc8fdf.pmtiles",
    bounds: [9.47, 47.04, 9.64, 47.28],
  },
  {
    sourceId: "maps-liechtenstein-north",
    archiveSha256: "7761a554051b9d8a77cf9c1f790b03a4e66a15fbe91dde46c488a10e0f95bf3e",
    archiveBytes: 1_366_814,
    archiveName:
      "liechtenstein-north-7761a554051b9d8a77cf9c1f790b03a4e66a15fbe91dde46c488a10e0f95bf3e.pmtiles",
    bounds: [9.47, 47.16, 9.64, 47.28],
  },
] as const;

export type AtlasRegion = "liechtenstein" | "liechtenstein-north";

export const atlasReleaseIndex = {
  schema: "maps-shortbread-release-v1",
  release: "maps-shortbread",
  source,
  tilesets: regions.map((region) => ({
    version: 1 as const,
    sourceId: region.sourceId,
    dataRevision: `sha256:${region.archiveSha256}`,
    format: "mvt" as const,
    schema: {
      id: "shortbread" as const,
      version: "1.0" as const,
      sourceLayers: ["land", "water_polygons", "water_lines", "streets", "buildings", "boundaries"],
    },
    projection: "web-mercator" as const,
    scheme: "xyz" as const,
    bounds: region.bounds,
    minZoom: 10,
    maxZoom: 14,
    tileSize: 512 as const,
    attribution: "© OpenStreetMap contributors (ODbL-1.0)",
    license: "ODbL-1.0",
    provenance,
    observation: { snapshot: source.snapshot },
    archiveRef: {
      format: "pmtiles" as const,
      version: 3 as const,
      path: region.archiveName,
      sha256: region.archiveSha256,
      bytes: region.archiveBytes,
      mvtExtent: 4096 as const,
    },
  })),
};

export function createAtlasTileset(region: AtlasRegion, baseUrl: string): MapsTileset {
  const index = region === "liechtenstein" ? 0 : 1;
  const metadata = atlasReleaseIndex.tilesets[index]!;
  return validateMapsTileset({
    ...metadata,
    transport: { kind: "pmtiles", url: `${baseUrl}tilesets/${metadata.archiveRef.path}` },
  });
}
