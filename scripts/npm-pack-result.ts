type PackedFile = { path: string; size: number };
type PackResult = {
  filename: string;
  size: number;
  unpackedSize: number;
  files: PackedFile[];
};

export function parseNpmPackResult(stdout: string): PackResult {
  // npm 10 may print prepare output before the array; npm 12 keys the result
  // by package name instead. Both envelopes describe one packed Maps package.
  const start = stdout.search(/^[\[{]/m);
  if (start < 0) {
    throw new Error("npm pack did not return JSON");
  }
  const output: unknown = JSON.parse(stdout.slice(start));
  let results: unknown[] = [];
  if (Array.isArray(output)) {
    results = output;
  } else if (isRecord(output)) {
    results = Object.values(output);
  }
  if (results.length !== 1 || !isPackResult(results[0])) {
    throw new Error("npm pack must return exactly one package with size and file metadata");
  }
  return results[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackResult(value: unknown): value is PackResult {
  return (
    isRecord(value) &&
    typeof value.filename === "string" &&
    typeof value.size === "number" &&
    typeof value.unpackedSize === "number" &&
    Array.isArray(value.files) &&
    value.files.every(
      (file: unknown) =>
        isRecord(file) && typeof file.path === "string" && typeof file.size === "number",
    )
  );
}
