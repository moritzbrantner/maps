# Contributing

## Prerequisites

- Bun `1.3.14`, matching `packageManager` in `package.json`.
- Node/npm available for `npm pack`.
- Playwright Chromium installed with
  `bunx playwright install --with-deps chromium` when running browser tests
  locally.

## Local Setup

```sh
bun install
bun run dev
```

## Fast Validation

```sh
bun run verify:fast
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

## Bundle And Package Budgets

Run:

```sh
bun run verify:package-size
bun run analyze:bundles
```

Update `bundle-baseline.json` only for intentional changes. Explain size
increases in PR descriptions.

## Release Flow

Update `CHANGELOG.md`, ensure `bun run verify:release` passes, and publish via
the existing tag or workflow process.
