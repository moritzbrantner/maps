# ADR 0005: Use CShapes-Europe History Demo Data

## Status

Accepted

## Context

The History demo needs Historical Polity Scenes that use recognizable real
boundary outlines. The previous hand-authored polygons were intentionally rough,
used fade/morph transitions between epochs, and could visually overlap in ways
that made the scene look historically inaccurate.

CShapes 2.0 covers global country borders from 1886 onward, while
CShapes-Europe provides European coverage for the 1816+ demo range. The
CShapes project distributes these datasets under Creative Commons
Attribution-NonCommercial-ShareAlike 4.0 terms and asks users to cite the
dataset publications.

## Decision

Use CShapes-Europe derived demo snapshots for the History tab. The demo keeps
only independent polity records active at each selected milestone year:

- 1816
- 1886
- 1914
- 1939
- 1945
- 1989
- 2019

The demo renders exact snapshot scenes only. Intermediate years snap to the
previous milestone; there is no fade, opacity-based entrance/exit, or shape
morphing between years.

CShapes-derived files stay under `demo/` and are not included in the published
`@moritzbrantner/maps` package file list. The demo includes source attribution
and a notice that the snapshots are not an authoritative historical boundary
source.

## Consequences

The History demo now prioritizes real source boundary outlines and clean visual
snapshots over demonstrating topology morph transitions.

The 800, 1000, 1200, 1450, 1648, 1815, and 2000 epochs were removed because
they were not supported by the chosen CShapes-Europe snapshot policy. In
particular, the pre-1816 scenes would require a different historical boundary
source and separate licensing/interpretation decisions.

The data remains demo-only because the CShapes-Europe license is not the same
as the package's MIT license.
