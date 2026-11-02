import { validateMapsTileset, type MapsTileset } from "../src/maps-tileset";
import liechtenstein from "./data/liechtenstein.manifest.json";
import north from "./data/liechtenstein-north.manifest.json";

/** Producer-owned manifests, pinned into the consumer. Never follow a floating asset URL at runtime. */
const candidates = { atlas: liechtenstein, "atlas-north": north } as const;
export type AtlasSourceChoice = keyof typeof candidates;

export function createAtlasTileset(source: AtlasSourceChoice, baseUrl: string): MapsTileset {
  const candidate = candidates[source];
  if (candidate.dataRevision !== `sha256:${candidate.archiveRef.sha256}`) {
    throw new Error(`Atlas ${candidate.sourceId}: manifest revision does not pin archive bytes`);
  }
  return validateMapsTileset({
    ...candidate,
    transport: {
      kind: "pmtiles",
      url: `${baseUrl}tilesets/${candidate.archiveRef.sha256}.pmtiles`,
    },
  });
}
