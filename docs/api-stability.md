# API Stability

The package keeps a checked API surface snapshot in `api-surface.json`.
Intentional public API changes should update that snapshot with:

```sh
node scripts/verify-api-surface.mjs --update
```

## Stability Tiers

| Tier | Meaning |
| --- | --- |
| Stable | Root map components, narrow entrypoints, data helpers, GeoJSON validation, measurement helpers, and documented layer components. Changes should be additive in minor releases. |
| Experimental | GeoJSON topology transitions, scalar-field WASM hooks, native MapLibre globe display, and timeline editor integration. These APIs are public but may still gain options or narrower behavior. |
| Internal but exported | Test hooks such as `resetMapsScalarFieldWasmRuntimeForTests`. Prefer higher-level APIs in application code. |
| Deprecated | `initialViewState` aliases. Use `defaultViewState` for uncontrolled initial viewport state. |

## Deprecation Policy

Deprecated exports stay available for at least one minor release after the docs
mark the replacement. Removal should be called out in `CHANGELOG.md`, update
`api-surface.json`, and include a migration note in the relevant docs page.

`initialViewState` remains a legacy alias. New examples and tests should use
`defaultViewState`; compatibility tests should keep covering the alias until it
is intentionally removed.
