# Engine scenarios

This directory contains machine-readable fixtures for the canonical Maps engine scenarios described in `docs/engine-scenarios.md`.

The registry is `manifest.json`. Individual scenario files use `maps.engine-scenario/v1` and are checked by `scripts/verify-engine-scenarios.mjs`.

These files define workload identity and expected observation categories. They do not embed implementation-specific benchmark thresholds or evaluator policy. `runtime-profiler` owns captured runtime facts; Moonlight owns baseline/candidate policy and verdicts.

Do not create a new scenario for every optimization or internal type. Add one only when it represents a materially different workload family or acceptance boundary.
