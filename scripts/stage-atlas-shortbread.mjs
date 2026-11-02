/** Stage verified asset-tooling PMTiles for immutable Pages URLs. No producer logic lives in Maps. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile, mkdir, copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = import.meta.url.startsWith("file:") ? fileURLToPath(import.meta.url) : undefined;
const root = modulePath ? path.dirname(path.dirname(modulePath)) : process.cwd();
const candidates = ["liechtenstein", "liechtenstein-north"];

export async function inspectAtlasCandidate(name, producerRoot, pinsRoot = root) {
  if (!candidates.includes(name)) throw new Error(`unknown Atlas candidate ${name}`);
  const pinned = JSON.parse(
    await readFile(path.join(pinsRoot, "demo/data", `${name}.manifest.json`), "utf8"),
  );
  const produced = JSON.parse(
    await readFile(
      path.join(producerRoot, ".asset-tooling/maps-shortbread", `${name}.manifest.json`),
      "utf8",
    ),
  );
  if (!isDeepStrictEqual(pinned, produced))
    throw new Error(`${name}: producer manifest differs from the consumer pin`);
  const ref = pinned.archiveRef;
  if (
    ref?.format !== "pmtiles" ||
    ref.version !== 3 ||
    ref.path !== `${name}.pmtiles` ||
    !/^[0-9a-f]{64}$/.test(ref.sha256) ||
    pinned.dataRevision !== `sha256:${ref.sha256}` ||
    pinned.schema?.id !== "shortbread" ||
    pinned.schema.version !== "1.0" ||
    pinned.license !== "ODbL-1.0" ||
    !pinned.attribution?.includes("OpenStreetMap contributors")
  ) {
    throw new Error(`${name}: unsupported schema, license or mutable archive identity`);
  }
  const archive = path.join(producerRoot, ".asset-tooling/maps-shortbread", ref.path);
  const bytes = await readFile(archive);
  if (
    bytes.length !== ref.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== ref.sha256 ||
    bytes.toString("ascii", 0, 7) !== "PMTiles"
  ) {
    throw new Error(`${name}: archive size, SHA-256 or PMTiles v3 header mismatch`);
  }
  return {
    name,
    archive,
    filename: `${ref.sha256}.pmtiles`,
    bytes: bytes.length,
    sha256: ref.sha256,
  };
}

export async function stageAtlasShortbread(
  producerRoot,
  outputRoot = path.join(root, "public/tilesets"),
  pinsRoot = root,
) {
  // Validate *both* archives and *both* manifests before mutating the public asset directory.
  const staged = await Promise.all(
    candidates.map((name) => inspectAtlasCandidate(name, producerRoot, pinsRoot)),
  );
  if (staged[0].sha256 === staged[1].sha256) throw new Error("Atlas candidate identity collision");
  await mkdir(outputRoot, { recursive: true });
  for (const entry of staged) {
    const dest = path.join(outputRoot, entry.filename);
    const pending = `${dest}.pending`;
    await copyFile(entry.archive, pending);
    await rename(pending, dest);
  }
  return staged;
}

if (modulePath && process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const producer = process.argv[2];
  if (!producer) {
    console.error("Usage: node scripts/stage-atlas-shortbread.mjs <asset-tooling-checkout>");
    process.exitCode = 2;
  } else {
    stageAtlasShortbread(path.resolve(producer)).then(
      (staged) => console.log(JSON.stringify(staged)),
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
