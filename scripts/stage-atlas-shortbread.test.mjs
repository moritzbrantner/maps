import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectAtlasCandidate, stageAtlasShortbread } from "./stage-atlas-shortbread.mjs";

const created = [];
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-stage-test-"));
  created.push(directory);
  const input = path.join(directory, "producer/.asset-tooling/maps-shortbread");
  const pinned = path.join(directory, "consumer/demo/data");
  await mkdir(input, { recursive: true });
  await mkdir(pinned, { recursive: true });
  for (const name of ["liechtenstein", "liechtenstein-north"]) {
    const bytes = await readFile(path.join(process.cwd(), "demo/data", `${name}.manifest.json`));
    await writeFile(path.join(input, `${name}.manifest.json`), bytes);
    await writeFile(path.join(pinned, `${name}.manifest.json`), bytes);
    await writeFile(path.join(input, `${name}.pmtiles`), "PMTiles\0deliberately-corrupt");
  }
  return {
    directory,
    input,
    producer: path.join(directory, "producer"),
    consumer: path.join(directory, "consumer"),
    output: path.join(directory, "public"),
  };
}

it("refuses any corrupted or truncated PMTiles before staging either archive", async () => {
  const target = await fixture();
  await expect(
    stageAtlasShortbread(target.producer, target.output, target.consumer),
  ).rejects.toThrow(/size|SHA-256/);
  await expect(stat(target.output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses mismatched producer metadata and wrong Shortbread schema", async () => {
  const target = await fixture();
  const file = path.join(target.input, "liechtenstein.manifest.json");
  const modified = JSON.parse(await readFile(file, "utf8"));
  modified.schema.version = "2.0";
  await writeFile(file, JSON.stringify(modified));
  await expect(
    inspectAtlasCandidate("liechtenstein", target.producer, target.consumer),
  ).rejects.toThrow(/manifest differs/);
});

it("does not silently accept a revision bump or a moving archive ref", async () => {
  const target = await fixture();
  const file = path.join(target.input, "liechtenstein-north.manifest.json");
  const modified = JSON.parse(await readFile(file, "utf8"));
  modified.dataRevision = "sha256:" + "f".repeat(64);
  await writeFile(file, JSON.stringify(modified));
  await expect(
    stageAtlasShortbread(target.producer, target.output, target.consumer),
  ).rejects.toThrow(/manifest differs/);
});
