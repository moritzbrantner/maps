# Versioned Maps Tilesets

`MapView flatRuntime="maps"` accepts one active `tileset` descriptor. It renders
MVT XYZ or PMTiles v3 MVT with the existing Shortbread 1.0 decoder, resolved class palette, retained
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

## Producer metadata without transport

`MapsTilesetMetadata` and `validateMapsTilesetMetadata` expose the same data
fields and validation body without a transport requirement, through `core`,
`flat` and root exports. A Maps-specific artifact recipe can verify those common
fields before a reader exists, keeping its archive reference in asset-owned
output. **Metadata-valid is not activatable**: it proves neither PMTiles support
nor an archive-to-source binding. `validateMapsTileset` composes the common
metadata validator with the supported XYZ or PMTiles v3 transport. Producers
must publish an archive separately from an immutable versioned source manifest;
validating producer metadata alone never verifies the archive's compatibility.

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
| `transport` | `{ "kind": "xyz", "urlTemplate": "…{z}…{x}…{y}…" }` or `{ "kind": "pmtiles", "url": "/tilesets/<immutable-revision>.pmtiles" }`, with HTTP(S) or a root-relative URL. No transport URL participates in source identity. |
| `scheme`, `projection` | `xyz`, `web-mercator`. World copies are placements of the same canonical tile, never separate data requests. |
| `bounds` | `[west, south, east, north]` in geographic degrees within Web Mercator latitude limits. `west > east` means antimeridian coverage. Bounds filter tile coverage; they do not clamp the camera. |
| `minZoom`, `maxZoom` | Inclusive integral source pyramid range, `0…31` for XYZ and `0…26` for PMTiles v3 (upstream archive index limit). Overzoom retains the canonical ancestor tile at the source maximum. |
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

## PMTiles v3 archive requirements

The Map View can consume an immutable PMTiles archive through the same Shortbread
MVT decoder and Canvas/WebGPU renderers as XYZ:

```tsx
const archive = validateMapsTileset({
  ...myTilesetMetadata,
  transport: { kind: "pmtiles", url: "/tilesets/sha256-my-revision.pmtiles" },
});
<MapView flatRuntime="maps" tileset={archive} fitToData={false} />;
```

The `pmtiles` 4.5 upstream reader performs directory lookup and gzip
decompression in the browser. Maps supplies a strict HTTP **Range** adapter:

- Every request must return `206 Partial Content` and an exposed, internally
  consistent `Content-Range: bytes <start>-<end>/<total>`. A host replying `200`
  to `Range` is rejected **without downloading the response body**. Malformed,
  missing or inconsistent ranges, HTTP errors and archive changes during a read
  become visible source errors, never blank successful tiles.
- Cross-origin archive hosts must allow `Range` and `If-Range` request headers
  and expose `Content-Range` and `ETag` response headers through CORS; the
  archive must be served byte-for-byte (no transparent HTTP content encoding).
  Prefer immutable, digest/revision-addressed URLs with a stable ETag.
- Before requesting a tile, the browser checks the v3 header's vector tile
  type, none/gzip compression, zoom limits and E7-rounded coverage bounds
  against the manifest, then verifies metadata `vector_layers` against declared
  Shortbread source layers. Incompatible or corrupt headers, directory data,
  compression and missing tiles fail explicitly. A custom `mapsSchema` metadata
  object, if present, must match the declared schema. Producers remain
  responsible for accurate schema semantics, data revision and attribution;
  a header alone cannot prove them.
- Header/directory lookups have a bounded **32-entry per-reader in-memory
  cache**, and validated metadata is fetched once per reader. No PMTiles tile
  byte cache, browser persistence, new scheduler or service worker is added.
  Tile bytes continue into the Rust-owned decoded-resource budget. Source and
  transport switches and disposal abort outstanding archive requests.

The committed `public/tilesets/fixture-pmtiles-v1.pmtiles` archive is generated
by `scripts/create-pmtiles-fixture.mjs` with go-pmtiles 1.31.2. It contains
synthetic CC0 Shortbread polygons with an island hole, varied street lines and
one of four z1 quadrants; its canonical z0 tile is also committed as an XYZ
`.mvt` for rendered-pixel comparison. The archive exceeds the initial 16 KiB
header request, so browser tests exercise genuine partial reads, failures from
range-ignoring hosts and missing tiles. No real-world coverage, revision
integrity or network-host performance is claimed by this fixture.
Regeneration reproduced the committed archive SHA-256
`26ac9ae8e322ba7e81ef1304d69e56ab55e9488348dfead315ca17d81712cf37`.

## Published geographic Atlas region (#270)

The Pages root uses `demo/atlas-source.ts` to select the reviewed Geofabrik
Liechtenstein October 25, 2026 OSM extract (full or northern variant), while the
synthetic PMTiles and XYZ fixtures remain available in the source selector.
Asset Tooling owns the Planetiler generation and reviewable source manifest:
the `maps-shortbread` release contains two digest-named archives, not a mutable
URL masquerading as a source revision. `scripts/fetch-atlas-tiles.ts` validates
its complete metadata against the checked-in consumer pin, verifies each archive's
SHA-256 and byte length, and copies it into the Pages build. The browser then
requests **same-origin HTTP 206 byte ranges** via the existing Rust/PMTiles
source lifecycle, decoder and Canvas/WebGPU renderers. No OSM hosted tile
service is contacted, and there is no fallback outside the bounded area.

The regional pyramids span zoom 10–14 and may be overzoomed at higher camera
levels. Source/zoom/coverage status is explicit in the page; selection retains
the camera and application-layer features. The page provides linked ODbL
attribution, the input snapshot date and the immutable data revision. OSM data
is not CC0, and the observation timestamp is not historical validity.

## Runtime lifetime

Rust retains the existing canonical `TileId(z,x,y)`, scheduler, load concurrency,
failure suppression and cache policy. Source switches clear pending/failed and
source-dependent visible state while preserving `MapCamera`. Loaded resources
move into a source namespace under the **same** decoded-tile capacity. Inactive
source resources are evicted first when the global budget is exceeded; evictions
release their Canvas images, decoded data, bytes and GPU buckets. The renderer
stores resources under the Rust-supplied namespace and does not choose retention.

Refreshing an XYZ or PMTiles URL or credentials for the same data identity clears Rust's
pending/failed request state and aborts outgoing browser loads, then requests the
missing tiles through the new transport. Already loaded decoded data and GPU
buckets remain retained under the same namespace. A metadata/date-only change
preserves pending work and failure suppression; a style-only change also leaves
network lifetime unchanged.

The browser aborts outgoing requests and checks their exact load handle before
accepting any result, including non-cooperative transports that resolve after
abort or after A → B → A. A cache hit restores decoded Canvas data and GPU buckets
without a request, decode or bucket build. Resolved-paint changes update the GPU
palette and repaint the retained Canvas representation without fetching or
re-decoding tiles. Canvas and WebGPU both honor the resolved building-outline
opacity, including hidden and partially transparent outlines. Rust's source-aware
completion boundary rejects a different
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
revision invalidation, bounded eviction, PMTiles byte ranges and Inspector failures. Rust contract
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
