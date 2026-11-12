#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  printf 'usage: %s <destination-binary>\n' "$0" >&2
  exit 2
fi

# The producer's public prerelease retains immutable source-addressed assets.
# Reusable workflow setup commands have no GitHub token; never introduce one.
producer_source_sha=fd26af06b649d319fdd9c1cf14fce63f1abaa324
download_url="https://github.com/moritzbrantner/runtime-profiler/releases/download/cli-artifacts/runtime-profiler-linux-x86_64-$producer_source_sha"

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required to consume the trusted public publisher asset\n' >&2
  exit 127
fi

download="$(mktemp -d "${RUNNER_TEMP:-/tmp}/maps-profiler-download.XXXXXXXX")"
trap 'rm -rf -- "$download"' EXIT
curl --fail --location --silent --show-error --retry 3 --retry-connrefused \
  --proto '=https' --proto-redir '=https' \
  --output "$download/runtime-profiler" "$download_url"

if [[ ! -f "$download/runtime-profiler" ]]; then
  printf 'runtime-profiler release asset was unavailable or empty\n' >&2
  exit 1
fi
install -D -m 755 "$download/runtime-profiler" "$1"
"$1" --version
"$1" detect > /dev/null
