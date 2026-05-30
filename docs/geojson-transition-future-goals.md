# GeoJSON Transition Future Goals

This document tracks topology transition algorithms that are intentionally out of scope for the current area-overlap and Voronoi-partition implementation.

## 1. Real Boolean Topology Plan

Compute exact preserved, disappearing, and appearing areas with full polygon overlay operations:

- preserved: intersection of source union and target union
- disappearing: source union minus target union
- appearing: target union minus source union

This would provide the most cartographically accurate transition model, but it requires a robust overlay pipeline, careful invalid-geometry recovery, and clear rules for distributing residual fragments back to feature IDs.

## 2. Skeleton / Medial-Axis Split Animation

Create centerline or medial-axis structures inside source polygons, then grow target polygons outward from internal veins or seed paths.

This could produce expressive split animations, especially for organic regions, but it requires nontrivial computational geometry and may be less literal than area-based transitions.

## 3. Centroid-Attractor Morph

Animate split and merge fragments through centroid attractors:

- split fragments pull away from the source centroid toward target centroids
- merge fragments converge through a shared centroid before expanding into the target

This is visually smooth and inexpensive, but it can create overlaps and may not preserve geography during the transition.

## 4. Optimal Transport / Area Flow

Sample polygon boundaries and interiors, then solve a transport problem from source mass to target mass.

This could produce high-quality area-preserving transitions, but it is computationally expensive, more complex to tune, and likely unnecessary unless topology animation becomes a flagship visualization feature.
