# ADR 0008: Version tilesets independently of paint and transport

## Status

Accepted through the owner-authored Maps #268 contract.

## Decision

A Maps Tileset is a versioned, validated data descriptor. It identifies a logical
source, immutable data revision and compatible vector schema/pyramid separately
from transport URLs, credentials, resolved paint and historical observation dates.
Version 1 accepts MVT XYZ/Web Mercator with Shortbread 1.0 source layers. PMTiles
transport is a follow-up reader boundary (#269), not a different vector encoding.

Rust remains authoritative for compatibility, canonical XYZ identity, camera,
source activation, scheduling and bounded decoded-resource retention. A source
switch preserves the camera and application Map Layers while changing only the
source-dependent namespace. Inactive source resources share the existing hard
cache budget. The browser consumes an opaque Rust namespace and its eviction
instructions; the renderer retains/drops resources without choosing policy.

The public Map View composes this source with existing retained Shortbread vector
buckets and Canvas fallback. Resolved class-paint changes reuse the data revision.
This does not introduce a general style evaluator, JS geographic scheduler,
persistent cache, archive reader or dataset authority.

## Consequences

The producer contract and field meanings are in
[`maps-tilesets.md`](../maps-tilesets.md). `asset-tooling` owns reproducible,
licensed artifact production against that contract. Maps owns live source and
map semantics. Source/network failures remain inspectable, unsupported contracts
fail explicitly, and transport/date changes cannot masquerade as data revision
changes. Evidence remains scoped to the executed runtime and named scenarios;
missing or incomparable measurements never become a performance pass.
