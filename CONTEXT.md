# Maps

Reusable React map components, map layers, and spatial data helpers for
application developers building interactive map views.

## Language

**Map Library**:
A reusable React package for interactive map views, map layers, and spatial data
helpers used by application developers.
_Avoid_: GeoJSON toolkit, visualization platform

**Map View**:
The interactive map surface that owns viewport state and hosts composed map
layers.
_Avoid_: canvas, viewer, scene

**Map Layer**:
A composable rendering unit placed inside a Map View.
_Avoid_: overlay when the layer is part of the main map composition

**Convenience Map**:
A precomposed component that wraps a Map View and one or more Map Layers for a
common workflow.
_Avoid_: standalone product, editor app

**Native Map Data**:
Library-native records such as points, flows, and temporal tracks used by the
common map components.
_Avoid_: internal-only data, GeoJSON-first data

**GeoJSON Source**:
A GeoJSON FeatureCollection accepted for display, conversion, editing,
operations, or map-scoped timeline workflows.
_Avoid_: canonical source model

**Map Feature**:
A selectable or hoverable rendered item on a map, such as a point, flow,
cluster, or rendered geometry.
_Avoid_: feature when specifically meaning a GeoJSON object

**GeoJSON Feature**:
A GeoJSON Feature object inside a GeoJSON Source.
_Avoid_: map feature

**Flat Map**:
The stable flat MapLibre-backed rendering and editing surface.
_Avoid_: basic map, legacy map

**Globe Map**:
A MapLibre native globe display and inspection surface with narrower editing
guarantees than Flat Maps.
_Avoid_: full editing surface

**GeoJSON Editor**:
A controlled, portable map editing module for GeoJSON geometry interactions and
edit operations.
_Avoid_: complete editor app

**Map-Scoped Timeline**:
Temporal behavior that produces map states, GeoJSON scene states, or map
playback.
_Avoid_: general timeline toolkit

**Historical Polity**:
An illustrative political entity shown in a historical Map-Scoped Timeline scene,
such as a kingdom, empire, republic, union, realm, or modern nation-state.
_Avoid_: nation when referring to pre-modern entities; country when the entity is
not a modern state

**Historical Polity Scene**:
A GeoJSON Source representing the visible Historical Polities at one labeled year
in the History demo.
_Avoid_: historical truth layer, authoritative border dataset

**Map UI**:
Map-specific controls, overlays, legends, editor handles, and interaction
affordances owned by this package.
_Avoid_: app chrome
