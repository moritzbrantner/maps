# Engine implementation order

Implementation follows subsystem foundations rather than micro-slices.

1. Complete Milestone A engine/scenario/evidence contracts.
2. Build Milestone B as one independent camera + tile/source/cache + raster runtime.
3. Generalize the renderer in Milestone C only after independent camera/tile ownership exists, so WebGPU is not permanently shaped around MapLibre projection.
4. Build vector decode/style/bucketing as one Milestone D pipeline.
5. Build shaping/placement/collision as one Milestone E cartography foundation.
6. Enter Milestone F only after the flat-map engine is converged.

Reviewable PRs are still encouraged, but a PR should leave behind a coherent contract and end-to-end capability. A sequence of PRs that only adds unused scaffolding does not count as milestone progress.
