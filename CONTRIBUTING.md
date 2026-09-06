# Contributing

## Prerequisites

- Bun `1.3.14`, matching `packageManager` in `package.json`.
- Node/npm available for `npm pack`.
- Rust `1.98.1` with `clippy`, `rustfmt`, and the `wasm32-unknown-unknown`
  target when changing Maps-owned Rust computation. `rust-toolchain.toml` pins
  this repository toolchain.
- `wasm-bindgen-cli` `0.2.128` when building or verifying the distributable
  Maps WASM artifact:
  `cargo install wasm-bindgen-cli --version 0.2.128 --locked`.
- Playwright Chromium installed with
  `bunx playwright install --with-deps chromium` when running browser or packed
  WASM package tests locally.

## Local Setup

```sh
bun install
bun run dev
```

## Fast Validation

```sh
bun run verify:fast
```

`verify:fast` deliberately remains TypeScript/package focused and does not
silently install Rust tooling.

## Rust Validation

Changes under `crates/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, or
the direct Maps WASM boundary must also run:

```sh
bun run verify:rust
```

The committed `Cargo.lock` is part of the deterministic repository contract.
Rust validation uses `--locked` and must fail rather than silently changing the
dependency graph. Maps may reuse lower-level geo/Moenarch crates when they
remove duplicate primitive correctness logic, but map-domain behavior remains
owned by this repository and must not be routed through `viz-engine` or a new
generic visualization layer.

## Distributable WASM Validation

The installed npm package owns its browser WASM artifact. Build and test the
actual packed artifact with:

```sh
bun run verify:wasm-package
```

This runs the normal package build, compiles `maps-wasm` from the locked Rust
graph, generates version-matched browser glue with the pinned wasm-bindgen CLI,
then installs the tarball into a temporary Vite consumer and initializes the
persistent Rust point index in Chromium. Normal `bun run build` stays JS-only;
`bun run build:package` is the package/release build that also emits
`dist/wasm/`.

## Agent TDD Harness

Agents should follow `AGENTS.md`: one behavior test, one minimal implementation,
then the same test back to green before continuing.

Useful red/green commands:

```sh
bun run test:tdd:run -- src/example.test.ts
bun run test:tdd:related -- src/example.ts
bun run test:tdd -- src/example.test.ts
bun run verify:agent
```

Run browser smoke tests for Map View, Map UI, MapLibre, interaction, or demo
changes:

```sh
bun run test:browser:smoke
```

## Release Validation

```sh
bun run verify:release
```

## API Changes

Public export changes must be intentional. Update the API snapshot with:

```sh
node scripts/verify-api-surface.mjs --update
```

Document stable API removals or replacements in `CHANGELOG.md` and the
relevant docs.

## Browser Snapshots

Run:

```sh
bun run test:browser
```

Update snapshots only when visual changes are intentional:

```sh
bun run test:browser:update
```

Review screenshot diffs before committing.

## Benchmark Baselines

Run:

```sh
bun run verify:benchmarks
```

Update baselines only when the regression or improvement is understood:

```sh
bun run ./scripts/verify-benchmark-budgets.mjs --update-baseline
```

Benchmark verification has warning thresholds and hard failure budgets. Warnings
do not fail by default; set `MAPS_BENCHMARK_WARN_AS_ERROR=1` when you want a
stricter local or scheduled run.

## Bundle And Package Budgets

Run:

```sh
bun run verify:package-size
bun run analyze:bundles
```

Update `bundle-baseline.json` only for intentional changes. Explain size
increases in PR descriptions. Bundle analysis keys hashed chunks by entrypoint
owner group and rank, so deltas should remain useful when emitted chunk
filenames change.

## Stylesheets

`bun run build:styles` generates both `styles.css` and `styles.full.css`.
`styles.css` is the slim default without Tailwind preflight/global reset;
`styles.full.css` is the compatibility export that preserves the legacy reset.

## Release Flow

Update `CHANGELOG.md`, ensure `bun run verify:release` passes, and publish via
the existing tag or workflow process.
