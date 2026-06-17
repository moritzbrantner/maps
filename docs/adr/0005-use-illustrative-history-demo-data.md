# ADR 0005: Use Illustrative History Demo Data

## Status

Accepted

## Context

The History demo needs Historical Polity Scenes across several labeled years to
show Map-Scoped Timeline topology transitions. External historical boundary
datasets carry licensing and interpretation constraints, and many historical
boundaries are disputed or require domain-specific verification.

## Decision

Use hand-authored, simplified, caveated demo polygons for the History tab instead
of bundling an external historical boundary dataset.

## Consequences

This prioritizes maintainability, licensing clarity, and a strong
topology-transition example over historical completeness.

The demo must describe the borders as illustrative and simplified, and should
not present the Historical Polity Scenes as an authoritative border dataset.
