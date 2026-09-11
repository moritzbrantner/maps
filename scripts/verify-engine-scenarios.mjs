import { readFile, readdir } from "node:fs/promises";

const root = new URL("../engine-scenarios/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const schema = JSON.parse(await readFile(new URL("schema.json", root), "utf8"));

if (manifest.schemaVersion !== "maps.engine-scenarios/v1") {
  throw new Error(`Unsupported engine scenario manifest: ${manifest.schemaVersion}`);
}
if (schema.properties?.schemaVersion?.const !== "maps.engine-scenario/v1") {
  throw new Error("Engine scenario schema does not declare maps.engine-scenario/v1");
}

const files = (await readdir(root))
  .filter((name) => name.endsWith(".json") && name !== "manifest.json" && name !== "schema.json")
  .sort();
const manifestIds = new Set();

for (const entry of manifest.scenarios ?? []) {
  if (typeof entry.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(entry.id)) {
    throw new Error(`Invalid engine scenario id: ${entry.id}`);
  }
  if (manifestIds.has(entry.id)) {
    throw new Error(`Duplicate engine scenario id: ${entry.id}`);
  }
  manifestIds.add(entry.id);

  if (!files.includes(`${entry.id}.json`)) {
    throw new Error(`Missing scenario fixture for ${entry.id}`);
  }
  if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
    throw new Error(`${entry.id} must declare capabilities`);
  }
  if (!Array.isArray(entry.runtimePhases) || entry.runtimePhases.length === 0) {
    throw new Error(`${entry.id} must declare runtime phases`);
  }
}

for (const file of files) {
  const scenario = JSON.parse(await readFile(new URL(file, root), "utf8"));
  if (scenario.schemaVersion !== "maps.engine-scenario/v1") {
    throw new Error(`${file} has unsupported schemaVersion ${scenario.schemaVersion}`);
  }
  if (`${scenario.id}.json` !== file) {
    throw new Error(`${file} must contain matching scenario id`);
  }
  if (!manifestIds.has(scenario.id)) {
    throw new Error(`${file} is not registered in manifest.json`);
  }
  if (!Array.isArray(scenario.observations) || scenario.observations.length === 0) {
    throw new Error(`${file} must declare semantic observations`);
  }
  if (!Array.isArray(scenario.runtimePhases) || scenario.runtimePhases.length === 0) {
    throw new Error(`${file} must declare runtime phases`);
  }

  const manifestEntry = manifest.scenarios.find((entry) => entry.id === scenario.id);
  if (JSON.stringify(manifestEntry.runtimePhases) !== JSON.stringify(scenario.runtimePhases)) {
    throw new Error(`${file} runtime phases must match manifest.json`);
  }
}

console.log(`Verified ${files.length} canonical engine scenarios.`);
