import { readFile, readdir } from "node:fs/promises";

const root = new URL("../engine-scenarios/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const schema = JSON.parse(await readFile(new URL("schema.json", root), "utf8"));
const scenarioIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;
const supportedSchemaKeywords = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "required",
  "properties",
  "const",
  "pattern",
  "minItems",
  "uniqueItems",
  "items",
  "minLength",
  "additionalProperties",
]);
const supportedSchemaTypes = new Set(["object", "array", "string"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function assertString(value, path) {
  if (typeof value !== "string") {
    fail(path, "must be a string");
  }
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    fail(path, "must be a non-negative integer");
  }
}

function assertUniqueStringArray(value, path) {
  if (!Array.isArray(value)) {
    fail(path, "must be an array");
  }
  if (value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(path, "must contain non-empty strings");
  }
  if (new Set(value).size !== value.length) {
    fail(path, "must contain unique strings");
  }
}

function assertSupportedSchema(node, path = "schema") {
  if (!isPlainObject(node)) {
    fail(path, "schema node must be an object");
  }

  for (const key of Object.keys(node)) {
    if (!supportedSchemaKeywords.has(key)) {
      fail(path, `unsupported schema keyword ${key}`);
    }
  }

  for (const key of ["$schema", "$id", "title", "description"]) {
    if (node[key] !== undefined) {
      assertString(node[key], `${path}.${key}`);
    }
  }

  if (node.type !== undefined) {
    assertString(node.type, `${path}.type`);
    if (!supportedSchemaTypes.has(node.type)) {
      fail(`${path}.type`, `unsupported schema type ${node.type}`);
    }
  }

  if (node.required !== undefined) {
    assertUniqueStringArray(node.required, `${path}.required`);
  }

  if (node.pattern !== undefined) {
    assertString(node.pattern, `${path}.pattern`);
    try {
      new RegExp(node.pattern);
    } catch (error) {
      fail(`${path}.pattern`, `must be a valid regular expression: ${error.message}`);
    }
  }

  if (node.minItems !== undefined) {
    assertNonNegativeInteger(node.minItems, `${path}.minItems`);
  }
  if (node.minLength !== undefined) {
    assertNonNegativeInteger(node.minLength, `${path}.minLength`);
  }
  if (node.uniqueItems !== undefined && typeof node.uniqueItems !== "boolean") {
    fail(`${path}.uniqueItems`, "must be a boolean");
  }
  if (
    node.additionalProperties !== undefined &&
    typeof node.additionalProperties !== "boolean"
  ) {
    fail(`${path}.additionalProperties`, "must be a boolean in the supported schema subset");
  }

  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      fail(path, "properties must be an object");
    }
    for (const [name, child] of Object.entries(node.properties)) {
      assertSupportedSchema(child, `${path}.properties.${name}`);
    }
  }

  if (node.items !== undefined) {
    assertSupportedSchema(node.items, `${path}.items`);
  }
}

function validateAgainstSchema(value, rule, path) {
  if (Object.hasOwn(rule, "const") && value !== rule.const) {
    fail(path, `must equal ${JSON.stringify(rule.const)}`);
  }

  if (rule.type === "object") {
    if (!isPlainObject(value)) {
      fail(path, "must be an object");
    }

    for (const required of rule.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        fail(path, `missing required property ${required}`);
      }
    }

    for (const [name, childRule] of Object.entries(rule.properties ?? {})) {
      if (Object.hasOwn(value, name)) {
        validateAgainstSchema(value[name], childRule, `${path}.${name}`);
      }
    }

    if (rule.additionalProperties === false) {
      const allowed = new Set(Object.keys(rule.properties ?? {}));
      for (const name of Object.keys(value)) {
        if (!allowed.has(name)) {
          fail(path, `unexpected property ${name}`);
        }
      }
    }
  } else if (rule.type === "array") {
    if (!Array.isArray(value)) {
      fail(path, "must be an array");
    }
    if (rule.minItems !== undefined && value.length < rule.minItems) {
      fail(path, `must contain at least ${rule.minItems} item(s)`);
    }
    if (rule.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        fail(path, "must contain unique items");
      }
    }
    if (rule.items !== undefined) {
      value.forEach((item, index) => validateAgainstSchema(item, rule.items, `${path}[${index}]`));
    }
  } else if (rule.type === "string") {
    if (typeof value !== "string") {
      fail(path, "must be a string");
    }
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      fail(path, `must contain at least ${rule.minLength} character(s)`);
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) {
      fail(path, `must match ${rule.pattern}`);
    }
  } else if (rule.type !== undefined) {
    fail(path, `unsupported schema type ${rule.type}`);
  }
}

function assertNonEmptyUniqueStrings(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, "must be a non-empty array");
  }
  if (value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(path, "must contain non-empty strings");
  }
  if (new Set(value).size !== value.length) {
    fail(path, "must contain unique strings");
  }
}

if (!isPlainObject(manifest) || manifest.schemaVersion !== "maps.engine-scenarios/v1") {
  throw new Error(`Unsupported engine scenario manifest: ${manifest?.schemaVersion}`);
}
if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
  throw new Error("Engine scenario manifest must contain scenarios");
}

assertSupportedSchema(schema);
if (schema.properties?.schemaVersion?.const !== "maps.engine-scenario/v1") {
  throw new Error("Engine scenario schema does not declare maps.engine-scenario/v1");
}

const files = (await readdir(root))
  .filter((name) => name.endsWith(".json") && name !== "manifest.json" && name !== "schema.json")
  .sort();
const manifestIds = new Set();

for (const [index, entry] of manifest.scenarios.entries()) {
  const path = `manifest.scenarios[${index}]`;
  if (!isPlainObject(entry)) {
    fail(path, "must be an object");
  }
  if (typeof entry.id !== "string" || !scenarioIdPattern.test(entry.id)) {
    fail(`${path}.id`, `invalid engine scenario id ${entry.id}`);
  }
  if (manifestIds.has(entry.id)) {
    fail(`${path}.id`, `duplicate engine scenario id ${entry.id}`);
  }
  manifestIds.add(entry.id);

  if (typeof entry.family !== "string" || entry.family.length === 0) {
    fail(`${path}.family`, "must be a non-empty string");
  }
  if (typeof entry.reference !== "string" || entry.reference.length === 0) {
    fail(`${path}.reference`, "must be a non-empty string");
  }
  assertNonEmptyUniqueStrings(entry.capabilities, `${path}.capabilities`);
  assertNonEmptyUniqueStrings(entry.runtimePhases, `${path}.runtimePhases`);

  if (!files.includes(`${entry.id}.json`)) {
    fail(path, `missing scenario fixture for ${entry.id}`);
  }
}

for (const file of files) {
  const scenario = JSON.parse(await readFile(new URL(file, root), "utf8"));
  validateAgainstSchema(scenario, schema, file);

  if (`${scenario.id}.json` !== file) {
    fail(file, "must contain matching scenario id");
  }
  if (!manifestIds.has(scenario.id)) {
    fail(file, "is not registered in manifest.json");
  }

  const manifestEntry = manifest.scenarios.find((entry) => entry.id === scenario.id);
  if (JSON.stringify(manifestEntry.runtimePhases) !== JSON.stringify(scenario.runtimePhases)) {
    fail(`${file}.runtimePhases`, "must match manifest.json exactly");
  }
}

console.log(`Verified ${files.length} canonical engine scenarios against schema.json.`);
