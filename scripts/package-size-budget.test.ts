// @vitest-environment node
import { expect, test } from "vitest";
import { evaluatePackageSize, packageSizeBudgets } from "./package-size-budget.ts";

const wasm = { path: "dist/wasm/maps_wasm_bg.wasm", size: 800_000 };
const wasmCore = { path: "dist/wasm/maps_wasm_core_bg.wasm", size: 300_000 };

function packageWith({
  nonWasmBytes,
  stylesheetBytes = 100_000,
}: {
  nonWasmBytes: number;
  stylesheetBytes?: number;
}) {
  return {
    filename: "maps.tgz",
    size: 500_000,
    unpackedSize: nonWasmBytes + wasm.size + wasmCore.size,
    files: [
      { path: "maplibre.css", size: 1_000 },
      { path: "styles.css", size: stylesheetBytes },
      { path: "styles.full.css", size: 110_000 },
      wasm,
      wasmCore,
      { path: "README.md", size: 1_000 },
      { path: "package.json", size: 1_000 },
    ],
  };
}

test("an over-ceiling non-WASM unpacked size is an advisory warning, not a failure (#173)", () => {
  const overCeiling = packageSizeBudgets.advisoryUnpackedSizeWithoutWasm + 370;
  const result = evaluatePackageSize(packageWith({ nonWasmBytes: overCeiling }));

  expect(result.errors).toEqual([]);
  expect(result.nonWasmUnpackedSize).toBe(overCeiling);
  expect(result.advisories).toEqual([
    `unpacked package size without the WASM runtimes is ${overCeiling} bytes, above advisory ceiling ${packageSizeBudgets.advisoryUnpackedSizeWithoutWasm} bytes`,
  ]);
});

test("the other package budgets still fail", () => {
  const result = evaluatePackageSize(
    packageWith({
      nonWasmBytes: packageSizeBudgets.advisoryUnpackedSizeWithoutWasm + 1,
      stylesheetBytes: packageSizeBudgets.stylesheetSize + 1,
    }),
  );

  expect(result.errors).toEqual([
    `styles.css size is ${packageSizeBudgets.stylesheetSize + 1} bytes, above budget ${packageSizeBudgets.stylesheetSize} bytes`,
  ]);
  expect(result.advisories).toHaveLength(1);
});

test("a missing WASM runtime still fails instead of hiding the non-WASM size", () => {
  const info = packageWith({ nonWasmBytes: 1_000_000 });
  info.files = info.files.filter((file) => file.path !== wasmCore.path);

  const result = evaluatePackageSize(info);

  expect(result.nonWasmUnpackedSize).toBeUndefined();
  expect(result.errors).toContain(
    "dist/wasm/maps_wasm_core_bg.wasm is missing from the dry-run package payload",
  );
  expect(result.errors).toContain(
    "unpacked package size without the WASM runtimes is missing from npm pack output",
  );
});
