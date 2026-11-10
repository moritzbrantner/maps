#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  printf 'usage: %s <destination-binary>\n' "$0" >&2
  exit 2
fi

# Upstream PMTiles validator for Tileset QA (#276). The version matches
# TILESET_QA_UPSTREAM in scripts/tileset-qa/core.ts; the digest is the release asset's.
version=1.31.2
sha256=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f
download_url="https://github.com/protomaps/go-pmtiles/releases/download/v${version}/go-pmtiles_${version}_Linux_x86_64.tar.gz"

download="$(mktemp -d "${RUNNER_TEMP:-/tmp}/maps-go-pmtiles.XXXXXXXX")"
trap 'rm -rf -- "$download"' EXIT
curl --fail --location --silent --show-error --retry 3 --retry-connrefused \
  --proto '=https' --proto-redir '=https' \
  --output "$download/go-pmtiles.tar.gz" "$download_url"
printf '%s  %s\n' "$sha256" "$download/go-pmtiles.tar.gz" | sha256sum --check --strict -
tar -xzf "$download/go-pmtiles.tar.gz" -C "$download" pmtiles
install -D -m 755 "$download/pmtiles" "$1"
"$1" version
