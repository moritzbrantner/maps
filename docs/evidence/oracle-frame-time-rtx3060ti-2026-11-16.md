# Oracle frame time on a hardware GPU (2026-11-16)

First hardware-GPU review of every oracle scenario since #343's owner decision (Option A, 2026-11-02): documented WebGPU presentation-floor exceptions stay known gaps, stale gaps are removed, and new waivers need per-scenario evidence and owner approval.

## Environment

|                            |                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| GPU                        | NVIDIA GeForce RTX 3060 Ti, driver 595.99.02                                                          |
| Adapters                   | WebGL: ANGLE (NVIDIA, Vulkan 1.4.329); WebGPU: nvidia ampere                                          |
| Browser                    | Chromium 156.0.8078.4 (Playwright 1.64.1), oracle `GPU_ARGS` (Vulkan, vsync and frame-rate cap off)   |
| Host                       | Linux 7.0.0-43-generic x64, Node v24.16.0                                                             |
| Source                     | `agent/343-hardware-frame-time` @ `5c9d169` (clean), MapLibre 6.17.0 (pinned)                         |
| Build                      | `wasmSha256` `dd083f84…a952179`, `bunLockSha256` `9da4d62c…28ab1fd`                                   |
| Timing                     | 30 warm-up frames + 500 ms, 2 rounds × 5 batches × 64 frames, up to 2 retries, fastest round per side |
| Maps renderer while timing | `wgpu`                                                                                                |

Each `bun run oracle -- --only …` batch ran on an otherwise idle host. Image (FLIP) and pointer gates passed in every scenario.

## Results (Maps / MapLibre ms per frame)

### Scenarios with the #343 `FRAME_TIME_GAP`

| scenario                      | run 1                | run 2                | run 3                | verdict                     |
| ----------------------------- | -------------------- | -------------------- | -------------------- | --------------------------- |
| clusters                      | 0.822 / 0.864 (0.95) | 0.808 / 0.898 (0.90) | 0.873 / 0.806 (1.08) | **passes 3/3, gap removed** |
| symbol-overscaled-deep        | 0.827 / 0.900 (0.92) | 0.805 / 0.880 (0.91) | 0.817 / 0.900 (0.91) | **passes 3/3, gap removed** |
| source-location               | 0.773 / 0.400 (1.93) |                      |                      | floor                       |
| zoom-crossfade                | 0.834 / 0.406 (2.05) |                      |                      | floor                       |
| labels                        | 0.828 / 0.663 (1.25) |                      |                      | floor                       |
| vector-tiles                  | 0.833 / 0.369 (2.26) |                      |                      | floor                       |
| line-styles                   | 0.913 / 0.433 (2.11) |                      |                      | floor                       |
| symbols                       | 0.845 / 0.411 (2.06) |                      |                      | floor                       |
| symbol-icons                  | 0.848 / 0.413 (2.06) |                      |                      | floor                       |
| symbol-zoom                   | 0.823 / 0.406 (2.03) |                      |                      | floor                       |
| symbol-lines                  | 0.856 / 0.522 (1.64) |                      |                      | floor                       |
| symbol-lines-pitch            | 0.828 / 0.581 (1.42) |                      |                      | floor                       |
| symbol-icon-lines             | 0.898 / 0.497 (1.81) |                      |                      | floor                       |
| symbol-icon-lines-pitch       | 0.948 / 0.573 (1.65) |                      |                      | floor                       |
| symbol-variable-anchors       | 0.778 / 0.436 (1.78) |                      |                      | floor                       |
| symbol-variable-anchors-pitch | 0.813 / 0.445 (1.82) |                      |                      | floor                       |
| symbol-alignment              | 0.803 / 0.477 (1.69) |                      |                      | floor                       |
| symbol-alignment-pitch        | 0.828 / 0.592 (1.40) |                      |                      | floor                       |
| symbol-sort-key               | 0.880 / 0.594 (1.48) |                      |                      | floor                       |
| symbol-zoom-anchors           | 0.834 / 0.436 (1.91) |                      |                      | floor                       |
| symbol-overscaled             | 0.800 / 0.653 (1.22) |                      |                      | floor                       |
| tileset-lines                 | 0.822 / 0.388 (2.12) |                      |                      | floor                       |
| line-dash-caps-joins          | 0.702 / 0.523 (1.34) |                      |                      | floor                       |
| fill-pattern                  | 0.875 / 0.392 (2.23) |                      |                      | floor                       |
| line-pattern                  | 0.986 / 0.422 (2.34) |                      |                      | floor                       |
| line-pattern-pitch            | 1.009 / 0.513 (1.97) |                      |                      | floor                       |

### Scenarios without a time gap

| scenario                    | run 1                | run 2                | verdict                  |
| --------------------------- | -------------------- | -------------------- | ------------------------ |
| church-site-discovery       | 0.916 / 1.300 (0.70) |                      | ok                       |
| bearing                     | 0.944 / 1.472 (0.64) |                      | ok                       |
| pitch                       | 0.987 / 1.772 (0.56) |                      | ok                       |
| atlas-flows                 | 0.884 / 1.131 (0.78) |                      | ok                       |
| hillshade-terrain           | 0.786 / 1.330 (0.59) |                      | ok                       |
| background-only             | 0.806 / 0.317 (2.54) |                      | **fails**, floor control |
| background-only-translucent | 0.827 / 0.275 (3.01) |                      | **fails**                |
| symbol-z-order              | 1.005 / 0.670 (1.50) | 0.958 / 0.664 (1.44) | **fails**                |
| fill-pattern-pitch          | 0.858 / 0.473 (1.81) |                      | **fails**                |
| hillshade                   | 0.981 / 0.486 (2.02) |                      | **fails**                |
| steep-pitch                 | 0.834 / 0.563 (1.48) |                      | **fails**                |
| steep-pitch-sky             | 0.809 / 0.650 (1.25) |                      | **fails**                |
| steep-pitch-horizon         | 0.828 / 0.633 (1.31) |                      | **fails**                |
| steep-pitch-horizon-85      | 0.820 / 0.667 (1.23) |                      | **fails**                |

## Reading

- `background-only` draws nothing but a background, yet Maps takes 0.81 ms per frame: that is the WebGPU canvas presentation floor on this machine. Every gapped scenario sits at 0.70–1.01 ms, i.e. at or just above that floor. Maps' own work adds at most about 0.2 ms above it in any scenario.
- The nine failing ungapped scenarios show the same pattern (0.81–1.01 ms). They were added or last timed on CI's software adapter, where timing is advisory, so the hardware gate had never seen them. Under the 2026-11-02 policy they are **not** waived here; the owner decides whether `FRAME_TIME_GAP` applies to them (#343).
- `clusters` passes with the least margin (1.08 in run 3); it may flap near the 1.10 threshold.
- Earlier local-only failures of `bearing`, `steep-pitch-horizon(-85)` and `hillshade(-terrain)` were a stale `node_modules/maplibre-gl` (6.4.1); the oracle now refuses to run against an unpinned MapLibre.
