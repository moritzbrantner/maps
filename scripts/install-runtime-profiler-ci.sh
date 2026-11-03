#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  printf 'usage: %s <destination-binary>\n' "$0" >&2
  exit 2
fi

# The public, GitHub-produced artifact is tied to an exact validated source
# commit and history workflow run. GitHub supplies its archive integrity digest.
producer_repo=moritzbrantner/runtime-profiler
producer_run_id=41738722345
producer_source_sha=6211c8470db3a3b616d8e107c77f7fd347ae7cb6
artifact_name="runtime-profiler-linux-x86_64-$producer_source_sha"

if [[ -z "${GH_TOKEN:-}" ]] || ! command -v gh >/dev/null 2>&1; then
  printf 'gh and GH_TOKEN are required to consume the trusted publisher artifact\n' >&2
  exit 127
fi

download="$(mktemp -d "${RUNNER_TEMP:-/tmp}/maps-profiler-download.XXXXXXXX")"
trap 'rm -rf -- "$download"' EXIT
gh run download "$producer_run_id" \
  --repo "$producer_repo" \
  --name "$artifact_name" \
  --dir "$download"

if [[ ! -f "$download/runtime-profiler" ]]; then
  printf 'runtime-profiler artifact did not contain the expected Linux CLI\n' >&2
  exit 1
fi
install -D -m 755 "$download/runtime-profiler" "$1"
"$1" --version
"$1" detect > /dev/null
