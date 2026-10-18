import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const installerPath = resolve(root, "scripts/install-wasm-bindgen-ci.sh");

test("verified CLI bootstrap is valid Bash", () => {
  execFileSync("bash", ["-n", installerPath], { stdio: "pipe" });
});

test("verified CLI hashes remain aligned with the pinned Nix flake", () => {
  const flake = read("flake.nix");
  const wasmAssets = flake.split("wasmBindgenAsset =")[1]?.split("wasmBindgen =")[0];
  assert.ok(wasmAssets, "wasmBindgenAsset must remain in flake.nix");

  const expectedDigests = [...wasmAssets.matchAll(/hash = "sha256-([^"]+)"/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("hex"));
  const installer = read("scripts/install-wasm-bindgen-ci.sh");
  const declaredDigests = [...installer.matchAll(/^\s+digest=([a-f0-9]{64})$/gm)]
    .map((match) => match[1]);

  assert.equal(expectedDigests.length, 2, "expected x86_64 and aarch64 pinned hashes");
  assert.deepEqual(declaredDigests, expectedDigests);
  assert.match(installer, /sha256sum --check --status/);
  assert.match(installer, /export PATH="\$install_dir:\$PATH"/);
  assert.match(installer, /printf '%s\\n' "\$install_dir" >> "\$GITHUB_PATH"/);
});

test("all WASM producer workflows use verified precompiled tooling", () => {
  for (const path of [
    ".github/workflows/pages.yml",
    ".github/workflows/ci.yml",
  ]) {
    const workflow = read(path);
    assert.match(workflow, /(?:bash|source) scripts\/install-wasm-bindgen-ci\.sh/, path);
    assert.doesNotMatch(workflow, /cargo install wasm-bindgen-cli/, path);
  }

  // The browser validation job builds WASM immediately after installing the CLI.
  assert.match(
    read(".github/workflows/ci.yml"),
    /source scripts\/install-wasm-bindgen-ci\.sh\n\s+bun run build:wasm/,
  );
});
