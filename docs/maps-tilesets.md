# Versioned Maps Tilesets

`MapView flatRuntime="maps"` accepts one active `tileset` descriptor. It renders
MVT XYZ with the existing Shortbread 1.0 decoder, resolved class palette, retained
WebGPU buckets and Canvas fallback. This is not a general MapLibre style parser.
`tilesetStyle` accepts overrides for the existing Shortbread paint classes;
application Map Layers remain independent children of the Map View.

```tsx
const tileset = validateMapsTileset(manifest);
<MapView flatRuntime="maps" tileset={tileset} fitToData={false} />
```

`MapsTileset` and `validateMapsTileset` are available from the root, `flat` and
server-safe `core` exports. Validation copies the input into a data-only manifest
before browser effects. Rust validates the authoritative source contract again
when activating it. Unsupported format/schema/transport and malformed metadata
fail explicitly; they do not start a MapLibre instance or silently change sources.

## Manifest version 1

A complete local example lives in
[`fixtures/maps-tileset-v1.json`](fixtures/maps-tileset-v1.json).

| Field | Meaning |
| --- | --- |
| `version` | Manifest protocol version, currently `1`. |
| `sourceId` | Stable logical source identifier, independent of host, URL and credentials. |
| `dataRevision` | Immutable identity of the produced data. Producers should use an artifact/content digest or an immutable revision with equivalent guarantees; moving `latest` aliases are unsuitable. A rebuild that changes data needs a new revision. |
| `format` | `mvt`; archive/container format belongs to transport, not vector encoding. |
| `schema.id`, `schema.version` | Currently `shortbread`, `1.0`. Incompatible schemas are rejected before activation. |
| `schema.sourceLayers` | Nonempty declared subset of `ocean`, `water_polygons`, `land`, `sites`, `buildings`, `water_lines`, `streets`, `boundaries`. These are MVT source-layer names, not display/style layer IDs. |
| `transport` | Currently `{ "kind": "xyz", "urlTemplate": "…{z}…{x}…{y}…" }`, with HTTP(S) or a root-relative URL. The browser adapter in `maps-tileset-transport.ts` is the reader extension boundary for #269; PMTiles is explicitly unsupported here. |
| `scheme`, `projection` | `xyz`, `web-mercator`. World copies are placements of the same canonical tile, never separate data requests. |
| `bounds` | `[west, south, east, north]` in geographic degrees within Web Mercator latitude limits. `west > east` means antimeridian coverage. Bounds filter tile coverage; they do not clamp the camera. |
| `minZoom`, `maxZoom` | Inclusive integral source pyramid range, `0…31`. Overzoom retains the canonical ancestor tile at the source maximum. |
| `tileSize` | Nominal CSS tile size, `256` or `512`, used by Rust to select the pyramid level. **Not the MVT geometry extent**: e.g. a 4096-unit MVT layer may have nominal tile size 512. Extent comes from the MVT payload. |
| `attribution` | Required human-readable attribution, displayed by the Map View. |
| `license` | Required license identifier/description for the produced data, independent of Maps' package license. |
| `provenance` | Required source/generation provenance; artifact-tooling owns reproducible artifact production and licensing inputs. |
| `observation` | Optional `{ "snapshot": "…", "effectiveDate": "…" }`. Descriptive metadata only; it does not turn Maps into historical-data authority or select a different source revision. |

The producer supplies accurate schema, coverage, zoom, attribution and provenance.
Maps does not derive immutable identity from a transport URL, token, historical
date or visual style. Source-layer membership, coverage and pyramid metadata
participate in the validated compatibility namespace so incompatible resources
cannot collide. The opaque namespace is produced by Rust; browser code does not
reconstruct it. A URL/token refresh for the same revision preserves resources.

## Runtime lifetime

Rust retains the existing canonical `TileId(z,x,y)`, scheduler, load concurrency,
failure suppression and cache policy. Source switches clear pending/failed and
source-dependent visible state while preserving `MapCamera`. Loaded resources
move into a source namespace under the **same** decoded-tile capacity. Inactive
source resources are evicted first when the global budget is exceeded; evictions
release their Canvas images, decoded data, bytes and GPU buckets. The renderer
stores resources under the Rust-supplied namespace and does not choose retention.

The browser aborts outgoing requests and checks their exact load handle before
accepting any result, including non-cooperative transports that resolve after
abort or after A → B → A. A cache hit restores decoded Canvas data and GPU buckets
without a request, decode or bucket build. Resolved-paint changes update the GPU
palette and repaint the retained Canvas representation without fetching or
re-decoding tiles. Rust's source-aware completion boundary rejects a different
source namespace as well.

`tileLimits` exposes the existing Rust `maxVisibleTiles`, `cacheCapacity` and
`loadConcurrency` budgets. Capacity must be at least the visible-placement limit;
undersized covers fail explicitly. The browser keeps resources only while Rust
retains them; there is no JS geographic scheduler or persistent byte cache.
Persistent caching remains #264. Data bytes are retained in memory only for the
current bounded decoded-resource lifetime.

Switching sources preserves the valid camera and application-layer selection;
basemap geometry does not acquire application feature identity. Canvas uses the
existing tile painting representation; this scoped foundation does not establish
general cartographic, symbol, line-width or MapLibre style parity.

## Inspect and reproduce

The existing Engine Inspector (`engine/?view=inspector`) offers Fixture A,
Fixture B and Fixture A revision 2 through the public Map View. It displays active
source/revision, compatibility metadata, provenance/license, source failures and
bounded resource observations. The live Shortbread comparison remains an explicit
comparison path; a mutable upstream URL is not mislabeled an immutable tileset.
The committed fixture MVTs are CC0 illustrative geometry generated from
`e2e/fixtures/shortbread-tile.mjs`, without historical or geographic data claims.

`e2e/maps-tileset-sources.spec.ts` exercises the public WebGPU/Canvas path, pixel
changes and warm reuse, non-cooperative reversed responses, camera/selection,
revision invalidation, bounded eviction and Inspector failures. Rust contract
coverage is in `crates/maps-core/tests/tileset_sources.rs`.

`bench:engine:interaction` extends the existing `vector-city-style-v1` journey
with dense-fixture public source A/B revisits, class-paint changes and a revision
bump. Its `sourceLifecycle` observations record actual routed network requests,
Rust decode calls (including the separate GPU bucket decode), bucket builds,
cache reuses, switch-to-ready latency and Chromium JS heap. Tile churn correctness
continues to use the existing `raster-tile-churn-v1` lifecycle tests. These metrics
are descriptive: JS heap is GC-dependent; decoded-image/MVT memory is a lower
bound, not total browser/GPU memory. Missing parent source-switch capability is
recorded as an unavailable comparison, never a green comparative performance
verdict. No new scenario, profiler, evaluation policy or style language is added.
