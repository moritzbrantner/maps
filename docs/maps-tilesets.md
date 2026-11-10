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
Liechtenstein January 1, 2026 OSM extract (full or northern variant), while the
synthetic PMTiles and XYZ fixtures remain available in the source selector.
Asset Tooling owns the Planetiler generation and reviewable source manifest:
the `maps-shortbread` release contains two digest-named archives, not a mutable
URL masquerading as a source revision. `scripts/fetch-atlas-tiles.ts` uses the checked-in reviewed release metadata, verifies each archive's
SHA-256 and byte length, and copies it into the Pages build. The browser then
requests **same-origin HTTP 206 byte ranges** via the existing Rust/PMTiles
source lifecycle, decoder and Canvas/WebGPU renderers. No OSM hosted tile
service is contacted, and there is no fallback outside the bounded area.

The regional pyramids span zoom 10–14 and may be overzoomed at higher camera
levels. Source/zoom/coverage status is explicit in the page; selection retains
the camera and application-layer features. The page provides linked ODbL
attribution, the input snapshot date and the immutable data revision. OSM data
is not CC0, and the observation timestamp is not historical validity.

## Precomputed place-search index (#281)

A manifest may carry one optional `searchIndex` reference. It is the only
search-related manifest extension and does not affect source identity:

```json
"searchIndex": {
  "schema": "maps-place-search-v1",
  "url": "/search-indexes/maps-showcase-places-r1.json",
  "sha256": "<64 lowercase hex of the exact artifact bytes>",
  "bytes": 2127,
  "languages": ["en", "de"],
  "bounds": [-180, -85.0511287798066, 180, 85.0511287798066],
  "license": "CC0-1.0",
  "provenance": "…"
}
```

The URL is static HTTP(S) or root-relative, without credentials, query or
fragment, so it never carries access secrets. The artifact (≤ 8 MiB) is UTF-8
JSON:

```json
{
  "schema": "maps-place-search-v1",
  "sourceId": "maps-showcase",
  "dataRevision": "1",
  "languages": ["en"],
  "attribution": "…", "license": "…", "provenance": "…",
  "places": [{
    "id": "stable source feature key, or null",
    "name": "Harbor Point", "language": "en", "type": "locality",
    "context": "optional producer-supplied disambiguation",
    "aliases": [{ "name": "…", "language": "en" }],
    "center": [lon, lat], "bounds": [west, south, east, north]
  }]
}
```

`west > east` denotes an antimeridian-crossing extent; `center` must lie inside
`bounds`; non-null ids are unique. Maps owns reading, normalization and ranking:
NFKD, diacritic removal, locale-independent case folding (`ß`→`ss`, `æ`→`ae`,
…) and punctuation collapsing. There is no cross-script transliteration — names
in other scripts must be supplied as aliases. Ranking is exact name, exact alias,
name prefix, alias prefix, then word-start prefix, tie-broken by normalized name
and key; results are bounded (default 8, at most 50). Identical names at
different places stay distinct results. A place without a source id gets a
positional key and `sourceFeatureId: null`.

`loadMapsPlaceSearchIndex` fetches only the pinned artifact — never tiles —
verifies byte length and SHA-256, then requires the artifact's
`sourceId`/`dataRevision` to equal the active tileset's. Any mismatch, missing
reference, unsupported schema or unreachable artifact without an exact cached
copy is reported as unavailable with a reason (`no-index`, `hash-mismatch`,
`revision-mismatch`, `offline`, `unsupported`, `invalid`) rather than returning
stale places. Verified bytes are stored content-addressed in the Cache API
(`maps-place-search-v1`) where permitted, so the exact revision is reused across
style changes and works offline; denied storage does not block an online load.
`MapPlaceSearch` / `useMapsPlaceSearchIndex` abort superseded loads when the
source, revision or index changes.

Producing indexes from canonical source features belongs to
[asset-tooling #407](https://github.com/moritzbrantner/asset-tooling/issues/407).
The two committed `public/search-indexes/*-r1.json` artifacts are hand-authored
synthetic fixtures for the Engine Page's synthetic sources; the Liechtenstein
Atlas has no index until that producer publishes one.

## Tileset integrity QA (#276, part 1)

`bun run qa:tileset` audits one PMTiles archive against its manifest before the
revision is adopted, and writes a bounded, deterministic `maps-tileset-qa-v1`
JSON artifact:

```sh
bun run qa:tileset -- --known showcase-pmtiles-v1
bun run qa:tileset -- --manifest tileset.json --archive tiles.pmtiles --mode full --output qa.json
```

A manifest file is a Maps Tileset manifest, optionally with
`archiveRef: { "sha256": "…", "bytes": … }`. `--known` names an archive from
`scripts/tileset-qa/known.ts`: the two committed fixtures and the two Atlas
archives (fetch those first with `bun scripts/fetch-atlas-tiles.ts`). The exit
status is `0` passed, `1` failed, `2` inconclusive, `3` usage or runtime error.
The command needs the built Rust/WASM module (`bun run build:wasm`); there is no
JavaScript fallback.

It is not a second archive reader or decoder. The upstream `pmtiles` reader does
archive I/O. The manifest validator and the header/metadata rules are the Map
View's own (`src/maps-tileset.ts`, `src/maps-tileset-transport.ts`). Rust
(`maps-core::tileset_qa`, through WASM) decodes sampled tiles with
`decode_mvt_layers` and derives required coverage from the same tile/bounds rule
the runtime uses to request tiles. Recipe and provenance authority stays with
Asset Tooling.

| Check | Fails when | Inconclusive when |
| --- | --- | --- |
| `manifest` | the manifest is not valid Maps Tileset metadata | — |
| `archive-identity` | the archive SHA-256 or byte length differs from `archiveRef` or a `sha256:<hex>` data revision | nothing pins the archive bytes |
| `archive-header` | the archive is unreadable, or its PMTiles v3 header conflicts with the manifest (type, compression, zoom range, bounds) | — |
| `archive-metadata` | `vector_layers`, `mapsSchema` or zoom metadata conflict with the manifest | — |
| `archive-directory` | header tile counts disagree with the directory, or an entry is zero-length or points past the end of the archive | the directory addresses more tiles than the budget |
| `upstream-verify` | pinned `go-pmtiles` 1.31.2 `verify` fails | it did not run, or another version ran |
| `tile-coverage` | a tile inside the declared bounds and zoom range is absent, or a tile lies outside the declared zoom range | the declared coverage exceeds the budget |
| `tile-content` | an inspected tile is unreadable, empty, oversized, undecodable, repeats a layer, or carries an undeclared source layer | a `full` scan could not decode every tile |

Warnings do not fail a check: tiles outside the declared bounds, featureless
tiles, properties absent from the archive's `vector_layers` fields, and declared
layers that no tile carries. The overall status is `failed` if any check failed,
otherwise `inconclusive` if any check is inconclusive, otherwise `passed`. A
check that could not run is never reported as passed. Set `PMTILES_CLI` (or
`--pmtiles-cli`) to the pinned binary; without it the result is at best
`inconclusive`.

The default `sampled` mode reads the directory and decodes 32 tiles chosen by a
seeded, per-zoom sample (`--seed`, `--sample`). `--mode full` decodes every
addressed tile up to its budget. Each finding carries an exact count and at most
16 tile references. The artifact records the source ID and revision, archive
SHA-256, check version, tool versions, coverage per zoom, observed source layers
with feature-ID and property-key counts, and the byte length and SHA-256 of each
inspected tile. It contains no timestamps or paths, so the same inputs reproduce
it byte for byte.

Missing tiles are an error because the Map View fails closed on them. Both
published Atlas archives are sparse this way: the Liechtenstein archive addresses
203 of the 244 tiles its bounds and zoom 10–14 require (41 missing, among them
`14/8623/5754`), and the northern variant 89 of 123. Their identity, header,
metadata, directory and content checks pass. The committed
`fixture-pmtiles-v1` archive is deliberately sparse (3 of 5 tiles missing) and
`showcase-pmtiles-v1` is complete.

`bun run verify:tileset-qa` is the gate. CI builds the WASM module, installs the
digest-pinned `go-pmtiles`, and requires the committed fixtures to reproduce
`scripts/tileset-qa/expected/*.json` exactly. Its other cases use tiny archives
written by a test-only PMTiles/MVT writer, so each expected result follows from
the archive's construction: schema drift, changed bytes, missing and
out-of-range tiles, antimeridian bounds, malformed and truncated archives,
undecodable tiles, budgets and cancellation.

Not delivered yet (#276 parts 2 and 3): revision A/B comparison with the
Inspector view, and tile seam QA.

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
retains them; there is no JS geographic scheduler. Without `tilePersistence`
data bytes are retained in memory only for the current bounded decoded-resource
lifetime.

## Opt-in tile persistence (#264)

`tilePersistence` on a `flatRuntime="maps"` Map View keeps downloaded **raw MVT
bytes** in browser Cache Storage, so a later visit reuses them across reloads and
browser restarts. It is off by default: a Map View without the option never writes
to origin storage. This is opportunistic reuse, not an offline-area download.

```tsx
<MapView flatRuntime="maps" tileset={tileset} tilePersistence />
<MapView flatRuntime="maps" tileset={tileset} tilePersistence={{ budgetBytes: 64 * 1024 * 1024 }} />
```

- **Boundary.** Persistence wraps the first-party transport reader
  (`createMapsTilesetTileReader`, XYZ and PMTiles). Rust still owns tile identity,
  scheduling, deduplication, cancellation and decoded retention; the store never
  plans a request. The MapLibre comparison path and the benchmark-only Shortbread
  loader stay HTTP-only.
- **Keys.** One origin-wide cache, `maps-tiles-v1`. A tile's key is the Rust source
  identity (source id, data revision and schema) plus its canonical `z/x/y`. World
  copies and overzoom resolve to the same key. The transport URL, credentials and
  the visual style are never part of a key, so a refreshed URL or a style change
  reuses the stored bytes and a new revision does not.
- **Freshness.** `Cache-Control: no-store` or `private` (and `Vary: *`) responses
  are never stored. A content-pinned `sha256:` data revision does not expire. Any
  other tile is stored only with an explicit `max-age`/`Expires` or a validator
  (`ETag`/`Last-Modified`); once expired, an XYZ tile is revalidated with a
  conditional request and reused only on HTTP 304, and a PMTiles tile is read
  again. An expired tile is never shown when its server cannot be reached. For
  PMTiles the archive's range-response headers speak for its tiles.
- **Budget.** `budgetBytes` targets about 250 MiB (`DEFAULT_MAPS_TILE_BUDGET_BYTES`)
  and is capped at half the quota the browser reports. Least recently used tiles
  are evicted first. Every opted-in Map View of a page shares the store, and the
  most recent option sets the target. The budget is a target, not a guarantee: the
  browser may evict the origin's storage at any time.
- **What is written.** Bytes are stored only after the Map View decoded them for
  its current source, so cancelled, failed, empty, undecodable or superseded
  responses leave no entry. One index entry holds sizes, recency and freshness; it
  is rewritten at most once a second after a write and once in 30 seconds for
  reads.
- **Failure.** Missing or denied storage, a refused quota and corrupt entries all
  fall back to the network reader. Stored bytes that are truncated or do not decode
  are discarded and fetched again. A tile that is neither stored nor reachable
  fails visibly as before.
- **Diagnostics and clearing.** `getMapsTilePersistenceStatus()` and
  `getRendererStats().tileset.persistence` report state, stored bytes and tiles,
  budget, hits, misses, revalidations, writes, evictions, discarded entries and
  write failures; the canvas mirrors them as `data-map-tile-persistence*`.
  `clearMapsDownloadedTiles()` deletes every stored tile of the origin. The Maps
  engine page keeps Atlas tiles and shows the status with a **Clear downloaded
  tiles** action; its synthetic fixtures always load from the network.

Limits of this phase: two tabs keep separate indexes, so the store can briefly
exceed its target until the next visit reconciles it, and tiles written in the
last second before a page closes may be dropped at the next visit. The source
manifest is the consumer's statement of identity: do not reuse one `sourceId` and
`dataRevision` for data that differs by user or credential. Measured comparison
against HTTP-only caching is the remaining #264 work; no performance benefit is
claimed here.

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
