# Rust/WASM engine performance and Pages

The standalone map is at `/maps/engine/`. It mounts the Maps-owned runtime directly,
without the library showcase, reference-engine selector, or reference map instance.
The existing Canvas fallback remains available when WebGPU is unavailable or a
geometry type requires it. Shortbread tiles still use the existing Maps decoder
and renderer; this change does not complete the retained vector-basemap work in #167.

`/maps/stats/` consumes `evidence/engine-benchmark.json` through the shared
GitHub Pages template's `project-evidence-v1` boundary. Every Pages build produces
new measurements from its built WASM artifact. The JSON contains source revision,
artifact and scenario hashes, environment, raw samples, and workload details.
Dirty local builds have no authoritative evidence revision. Missing evidence stays
unavailable; measurements have no pass/fail performance verdict.

## Projection workload

Run `bun run bench:engine` after building WASM and preparing the browser assets:

```sh
bun run build:wasm
mkdir -p public/wasm
cp dist/wasm/maps_wasm.js dist/wasm/maps_wasm_bg.wasm public/wasm/
bun run bench:engine
```

The harness uses the seed, point count, viewport, and camera journey from
`engine-scenarios/dense-points-100k-v1.json`. It measures the render-preparation
projection phase in Chromium using the actual `MapsFlatRasterRuntime.projectPacked`
WASM export: 100,000 coordinates, five camera positions, three warmup journeys,
and fifteen measured journeys. Each sample is the mean batch time across that
journey. The reported p95 is the p95 of those journey means.

Flat cameras and cameras with 35° bearing / 40° pitch are reported separately.
Measurements include the packed JS/WASM input and output transfer. They exclude
startup, tile requests, GPU uploads, drawing, and picking, so they do not establish
FPS or overall interaction latency. The harness serves only local inputs and fails
if the WASM module or meaningful projection output is unavailable.

For a Pages build, use `--output public/evidence/engine-benchmark.json` before
Vite builds the site. The checked-in Pages workflow performs these steps and uses
the existing shared template for `/stats/` and `/evidence/`.

## Batch preparation optimization

Tracked in #169. Previously each packed coordinate called the scalar runtime
projection method, which revalidated the camera and reconstructed its local
projection state. Oriented validation also intersected four viewport rays with
the map plane for every coordinate.

The Rust runtime now validates once per batch and reuses a prepared local frame.
`MapLocalRenderFrame` retains the view/projection matrix produced by the existing
3d-lab foundation. The batch iterator streams results into the existing packed
output; it adds no intermediate result vector or JS geographic implementation.
Invalid coordinates still produce individual NaN pairs. Odd packed lengths are
rejected, and subsequent camera changes create fresh preparation.

Local before/after measurements on the same machine and harness:

| Projection, 100k coordinates | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Flat | 12.12 ms | 11.34 ms | 12.96 ms | 12.36 ms |
| Bearing/pitch | 372.04 ms | 23.46 ms | 394.96 ms | 23.96 ms |

The oriented projection median was approximately 15.9× faster in this run. This
is descriptive evidence for this phase, not a Moonlight acceptance decision or a
claim that the map as a whole is 15.9× faster. Runtime-profiler and Moonlight retain
ownership of capture/comparability and architectural performance acceptance.

The starting source revision was `c93ada2de836e0d2a92b52f665b2281549575f93`.
The local run used Chromium 151.0.7922.34 on Linux x64, AMD Ryzen 7 5700X,
Node 24.16.0, and Rust 1.98.1. Baseline WASM SHA-256:
`e7f1a3ad07ba55a308cbc8b299a847953f46be5214915425017e005b146dfcc1`;
candidate WASM SHA-256:
`2e6dcb1bc6176ba1dfa981e438608c86ce27a7bb276a16847eba924cac27430f`.
Shared convention sourceRevision:
`e6acb5310afaf15c0cba24f87108f5f4ad1bedc3`.
Rust tests cover scalar/batch equality across wrapping, invalid inputs, resize,
and camera changes; browser coverage checks the packed transport and both Pages
routes. Canonical camera parity, Rust verification, and the agent gate also apply.

The local Rust and camera-parity checks passed, as did the 497-test agent gate
and all four built-Pages checks. The full browser smoke run passed 31 of 32 tests:
the reference showcase's Globe interaction test stayed on Clusters after its
initial tab click. Its retained trace showed a completed click without a view
change; three isolated diagnostic runs passed without code changes. The full
smoke result remains failed, and this intermittent failure is not resolved by
those diagnostic passes. Both new engine smoke tests passed in the full run.
