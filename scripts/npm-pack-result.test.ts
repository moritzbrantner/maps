// @vitest-environment node
import { expect, test } from "vitest";
import { parseNpmPackResult } from "./npm-pack-result.ts";

const artifact = {
  filename: "maps.tgz",
  size: 10,
  unpackedSize: 20,
  files: [{ path: "package.json", size: 20 }],
};

test("reads npm 10 arrays after prepare output and npm 12 package-keyed results", () => {
  expect(parseNpmPackResult(`\n> prepare\n\n${JSON.stringify([artifact], null, 2)}`)).toEqual(
    artifact,
  );
  expect(parseNpmPackResult(JSON.stringify({ "@moritzbrantner/maps": artifact }))).toEqual(
    artifact,
  );
});

test("rejects missing, ambiguous and malformed pack metadata", () => {
  for (const output of ["no result", "[]", JSON.stringify([artifact, artifact]), '{"maps":{}}']) {
    expect(() => parseNpmPackResult(output)).toThrow();
  }
});
