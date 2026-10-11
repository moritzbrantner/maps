#!/usr/bin/env bash
# Collector for the root `performance:work` capability.
#
# Runs the Cargo tests that measure the deterministic work counters for the
# operations declared in .performance/contract.json and prints one
# `coding-tooling/work-evidence/v1` document on stdout. Cargo output goes to
# stderr so stdout carries only the evidence. Each test checks its correctness
# oracle before it writes `<operation>.json` into MAPS_WORK_EVIDENCE_DIR; with
# that variable set, the tests leave the work bounds to
# `coding-tooling performance work`, and without it they assert the same
# bounds themselves.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

contract=".performance/contract.json"
suite="maps/benchmark-budgets"

evidence_dir="$(mktemp -d)"
trap 'rm -rf "$evidence_dir"' EXIT
export MAPS_WORK_EVIDENCE_DIR="$evidence_dir"

cargo test --quiet --locked -p maps-wasm --lib -- --exact \
  work_complexity::retained_points_camera_pan_does_no_per_point_work \
  work_complexity::retained_points_camera_zoom_rotate_pitch_does_no_per_point_work \
  work_complexity::retained_points_deep_pan_rebases_are_counted_and_bounded_by_travel \
  work_complexity::retained_points_update_rewrites_only_the_changed_points \
  work_complexity::retained_points_dataset_replacement_is_declared_linear_work \
  work_complexity::projected_points_camera_pan_is_the_linear_comparison_path >&2

# Contract order; a missing fragment means a test did not run or failed.
operations=(
  retained-points-camera-pan
  retained-points-camera-zoom-rotate-pitch
  retained-points-camera-deep-pan-rebase
  retained-points-update-features
  retained-points-replace-dataset
  projected-points-camera-pan
)
fragments=()
for operation in "${operations[@]}"; do
  fragment="$evidence_dir/$operation.json"
  if [[ ! -s "$fragment" ]]; then
    printf 'missing work evidence for %s\n' "$operation" >&2
    exit 1
  fi
  fragments+=("$(<"$fragment")")
done

# Hash the contract bytes as they are on disk now, after the tests ran.
if command -v sha256sum >/dev/null 2>&1; then
  contract_sha="$(sha256sum "$contract" | cut -d' ' -f1)"
else
  contract_sha="$(shasum -a 256 "$contract" | cut -d' ' -f1)"
fi

joined="$(IFS=,; printf '%s' "${fragments[*]}")"
printf '{"schemaVersion":"coding-tooling/work-evidence/v1","suite":"%s","contractSha256":"%s","operations":[%s]}\n' \
  "$suite" "$contract_sha" "$joined"
