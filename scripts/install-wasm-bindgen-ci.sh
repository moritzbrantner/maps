#!/usr/bin/env bash
set -euo pipefail

# The release identity and SHA-256 digests mirror the existing pinned flake.nix.
version=0.2.129
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    target=x86_64-unknown-linux-musl
    digest=82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e
    ;;
  Linux-aarch64)
    target=aarch64-unknown-linux-musl
    digest=2ed4351c35dd9440308bbb02767d47ea278efe851a52465300f3c94f5b6c2a87
    ;;
  *)
    echo "Unsupported wasm-bindgen CI host: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

working_dir="$(mktemp -d)"
trap 'rm -rf "$working_dir"' EXIT
archive="$working_dir/wasm-bindgen.tar.gz"
url="https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/wasm-bindgen-${version}-${target}.tar.gz"
curl --fail --location --silent --show-error --retry 3 "$url" --output "$archive"
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status || {
  echo "wasm-bindgen release checksum did not match the pinned flake.nix digest" >&2
  exit 1
}
tar -xzf "$archive" -C "$working_dir"
install_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/maps-wasm-bindgen-ci/bin"
mkdir -p "$install_dir"
install -m 0755 "$working_dir/wasm-bindgen-${version}-${target}/wasm-bindgen" "$install_dir/wasm-bindgen"
"$install_dir/wasm-bindgen" --version
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
else
  printf 'Add %s to PATH to use wasm-bindgen in subsequent commands.\n' "$install_dir"
fi
