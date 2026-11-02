// Copy only approved, digest-pinned Asset Tooling #409 bytes into the Pages artifact.
// The browser reads these same-origin files with HTTP 206 ranges, never OSM's tile service.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atlasReleaseIndex } from "../demo/atlas-source.ts";

const RELEASE_URL =
  "https://github.com/moritzbrantner/asset-tooling/releases/download/maps-shortbread";

export function verifyAtlasArchive(bytes: Uint8Array, sha256: string, length: number): void {
  if (bytes.byteLength !== length) {
    throw new Error(`Atlas archive size mismatch: expected ${length}, got ${bytes.byteLength}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) {
    throw new Error(`Atlas archive SHA-256 mismatch: expected ${sha256}, got ${actual}`);
  }
}

async function download(name: string): Promise<Uint8Array> {
  const response = await fetch(`${RELEASE_URL}/${name}`, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) {
    throw new Error(`Asset Tooling published file ${name}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchAtlasTiles(
  outDir: string = fileURLToPath(new URL("../public/tilesets", import.meta.url)),
): Promise<void> {
  // The checked-in index records the reviewed release metadata. The rolling
  // manifest may move, but digest-named archives remain addressable.
  await mkdir(outDir, { recursive: true });
  for (const tileset of atlasReleaseIndex.tilesets) {
    const { path: name, sha256, bytes: length } = tileset.archiveRef;
    const file = path.join(outDir, name);
    let verified = false;
    try {
      if ((await stat(file)).size === length) {
        verifyAtlasArchive(await readFile(file), sha256, length);
        verified = true;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (verified) continue;
    const archive = await download(name);
    verifyAtlasArchive(archive, sha256, length);
    const temporary = `${file}.partial`;
    await writeFile(temporary, archive);
    await rename(temporary, file);
  }
}

if (import.meta.main) {
  await fetchAtlasTiles();
}
