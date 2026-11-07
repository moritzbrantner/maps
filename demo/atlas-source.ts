import { validateMapsTileset, type MapsTileset } from "../src/maps-tileset";

/** Published Asset Tooling #483 output; resolved by the #270 Pages build. */
const source = {
  provider: "Geofabrik",
  url: "https://download.geofabrik.de/europe/liechtenstein-260101.osm.pbf",
  sha256: "38c281920dcf599754a1e58f399b88c35d18b40dff932bd4dd926aa1a79cda76",
  snapshot: "2026-01-01T21:21:30Z",
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
    archiveSha256: "a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4",
    archiveBytes: 2_730_127,
    archiveName:
      "liechtenstein-a1741ca69459439c72efc66b8c3ceef3447a70ba1a25537c4b29f8c5e4eb00f4.pmtiles",
    bounds: [9.47, 47.04, 9.64, 47.28],
  },
  {
    sourceId: "maps-liechtenstein-north",
    archiveSha256: "286216eaf8884d4ccf4a1b9e9fdc5e0f2fe14291ca9585e9416011baaf4dee92",
    archiveBytes: 1_340_459,
    archiveName:
      "liechtenstein-north-286216eaf8884d4ccf4a1b9e9fdc5e0f2fe14291ca9585e9416011baaf4dee92.pmtiles",
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
