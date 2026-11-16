type PackedFile = { path: string; size: number };
type PackageInfo = { size?: number; unpackedSize?: number; files?: PackedFile[] };

// Re-measured on main 1740615 after Milestone D (#138, 486,433-byte WASM) for #187:
// 532,422-byte WASM, 403,498-byte compressed package, 1,622,346 bytes unpacked. WASM growth per
// PR (wasm-opt -O1): #151 tile prefetch +25,560; #153 instanced circles +4,293; #163 overscan
// pans -6,930; Shortbread tile-pixel retention (289765e) +7,548; camera-ahead prefetch (8e32e7f) +3,550;
// #162 WebGPU polygons +7,015; #180 tile zoom fallback +8,143; Rust 1.99/wasm-bindgen 0.2.129
// -2,683; smaller steps net -507. The package budgets grow by about the same amount.
// #191 then lands the #167 retained vector basemap (Rust Shortbread buckets, retained
// wgpu vector pipelines, shared retained-geometry module): WASM 532,422 -> 591,763
// (+59,341), compressed package 427,892, unpacked 1,696,963.
// Local measurements since: #194 retained points and nearby steps 591,763 -> 604,819 (+13,056);
// #161 stencil polygons and encoded-sRGB blending +2,746; #196 retained polygons (fan, cover and
// screen-extruded stroke pipelines) +16,264 -> 623,829 WASM, compressed package 444,281,
// unpacked 1,750,305.
// #268 (owner decision): the compressed package and WASM runtime sizes are measured and
// reported only, not blocking ceilings; reducing them is a loading-strategy concern
// ("make it work, make it right, make it fast"). Keep a small margin for the rest.
// #343 builds the WASM for speed (opt-level 3, 705,345 -> 845,540 bytes): the unpacked budget
// now covers everything but the report-only WASM runtime, with the allowance it had before
// (1,752,500 - 705,345).
// #172 phase C moves moving point track sampling to Rust (`MapsTemporalPointIndex`, the
// temporal runtime loader and its exports): +9,192 bytes unpacked without the WASM runtime
// (+4,516 generated WASM bindings, +4,676 JavaScript, declarations and changelog), so the
// budget grows by the same amount.
// #172 phase E adds the moving-track work counters (`src/temporal-work.ts`, kept by every
// prepared playback index): +1,514 bytes of JavaScript and declarations, measured against
// main; the budget grows by the same amount.
// #305 re-measures main cbe2188: 1,069,958 bytes without the WASM runtime (#415, #427 and #428
// had grown it past the budget unnoticed; package validation runs on dispatch only). The
// WebGPU-free core module then adds its wasm-bindgen glue and declarations (54,168 + 10,857 +
// 4,687 bytes) and the capability loaders and docs 1,559 bytes: 1,141,229 bytes, 4 more entries.
// Both WASM binaries stay report-only (#268) and are excluded here.
// #173 Q7 owner-approved rebaseline (2026-11-15): same-environment clean main 9da5c4a
// = 1,158,952 non-WASM unpacked bytes / 81 entries; phase-A PR #437 = 1,167,381 bytes /
// 80 entries (+8,429 bytes / -1 entry). Raise only this ceiling to 1,168,500 bytes,
// leaving every other package/consumer gate and the entry limit intact. Future feature
// PRs must continue reporting their own matched-base delta; this snapshot is not a waiver.
// #173 follow-up owner decision (2026-11-15): the non-WASM ceiling is advisory. Main was about
// 370 bytes over 1,168,500 after #466. The verifier keeps measuring and reporting the size, the
// change since the approved snapshot and this attribution, and warns above the ceiling, but no
// longer fails on it. The entry count, stylesheet budgets and required files still fail.
export const approvedSizeBaseline = { revision: "9da5c4a", nonWasmUnpackedBytes: 1_158_952 };
export const packageSizeBudgets = {
  advisoryUnpackedSizeWithoutWasm: 1_168_500,
  entryCount: 84,
  fullStylesheetSize: 125_000,
  stylesheetSize: 116_000,
};


const requiredFiles = [
  "maplibre.css",
  "styles.css",
  "styles.full.css",
  "dist/wasm/maps_wasm_bg.wasm",
  "dist/wasm/maps_wasm_core_bg.wasm",
  "README.md",
  "package.json",
];

export function evaluatePackageSize(packageInfo: PackageInfo) {
  const files = Array.isArray(packageInfo?.files) ? packageInfo.files : [];
  const find = (filePath: string) => files.find((file) => file.path === filePath);
  const stylesheet = find("styles.css");
  const fullStylesheet = find("styles.full.css");
  const mapLibreStylesheet = find("maplibre.css");
  const wasmRuntime = find("dist/wasm/maps_wasm_bg.wasm");
  const wasmCoreRuntime = find("dist/wasm/maps_wasm_core_bg.wasm");
  const errors: string[] = [];
  const advisories: string[] = [];
  const nonWasmUnpackedSize =
    typeof packageInfo?.unpackedSize === "number" &&
    typeof wasmRuntime?.size === "number" &&
    typeof wasmCoreRuntime?.size === "number"
      ? packageInfo.unpackedSize - wasmRuntime.size - wasmCoreRuntime.size
      : undefined;

  for (const filePath of requiredFiles) {
    if (!find(filePath)) {
      errors.push(`${filePath} is missing from the dry-run package payload`);
    }
  }

  const checkPresent = (label: string, actual: number | undefined): actual is number => {
    if (typeof actual !== "number") {
      errors.push(`${label} is missing from npm pack output`);
      return false;
    }
    return true;
  };
  const checkBudget = (
    label: string,
    actual: number | undefined,
    max: number,
    unit: string,
    findings = errors,
    kind = "budget",
  ) => {
    if (checkPresent(label, actual) && actual > max) {
      findings.push(`${label} is ${actual} ${unit}, above ${kind} ${max} ${unit}`);
    }
  };

  checkPresent("compressed package size", packageInfo?.size);
  checkBudget(
    "unpacked package size without the WASM runtimes",
    nonWasmUnpackedSize,
    packageSizeBudgets.advisoryUnpackedSizeWithoutWasm,
    "bytes",
    advisories,
    "advisory ceiling",
  );
  checkBudget("package entry count", files.length, packageSizeBudgets.entryCount, "entries");
  checkBudget("styles.css size", stylesheet?.size, packageSizeBudgets.stylesheetSize, "bytes");
  checkBudget(
    "styles.full.css size",
    fullStylesheet?.size,
    packageSizeBudgets.fullStylesheetSize,
    "bytes",
  );
  checkPresent("Maps WASM renderer runtime size", wasmRuntime?.size);
  checkPresent("Maps WASM core runtime size", wasmCoreRuntime?.size);

  return {
    advisories,
    errors,
    files,
    fullStylesheet,
    mapLibreStylesheet,
    nonWasmUnpackedSize,
    stylesheet,
    wasmCoreRuntime,
    wasmRuntime,
  };
}
