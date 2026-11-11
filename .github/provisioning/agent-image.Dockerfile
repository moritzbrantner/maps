# Experimental, non-required coding-agent image for the provisioning comparison
# (issue #211). It adds no version authority of its own:
# - the base is the digest-pinned Ubuntu release matching the hosted runner;
# - Rust comes from rust-toolchain.toml through rustup;
# - Bun comes from package.json `packageManager`;
# - wasm-bindgen comes from the checksum-verified CI installer;
# - Node uses the same major line (24) as the hosted CI jobs.
# Application dependencies are never baked in: bun.lock and Cargo.lock stay
# authoritative at task time.
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c

ARG NODE_MAJOR=24

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    BUN_INSTALL=/usr/local/bun \
    PATH=/usr/local/cargo/bin:/usr/local/bun/bin:/usr/local/node/bin:/opt/maps-wasm-bindgen-ci/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential ca-certificates curl git gzip jq pkg-config tar unzip xz-utils zstd \
  && rm -rf /var/lib/apt/lists/*

COPY rust-toolchain.toml /tmp/toolchain/rust-toolchain.toml
RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none \
  && cd /tmp/toolchain \
  && rustup toolchain install \
  && rustup default "$(rustup show active-toolchain | cut -d' ' -f1)" \
  && rustc --version && cargo clippy --version && cargo fmt --version \
  && chmod -R a+rwX "$CARGO_HOME" "$RUSTUP_HOME"

COPY package.json /tmp/toolchain/package.json
RUN bun_version="$(jq -er '.packageManager | capture("^bun@(?<v>.+)$").v' /tmp/toolchain/package.json)" \
  && curl --fail --silent --show-error --location https://bun.sh/install | bash -s "bun-v${bun_version}" \
  && bun --version

RUN node_version="$(curl --fail --silent --show-error "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" \
      | grep -oE "node-v[0-9.]+-linux-x64.tar.xz" | head -n1)" \
  && curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${node_version}" -o /tmp/node.tar.xz \
  && curl --fail --silent --show-error "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" \
    | grep " ${node_version}\$" | sed "s#${node_version}#/tmp/node.tar.xz#" | sha256sum --check --status \
  && mkdir -p /usr/local/node && tar -xJf /tmp/node.tar.xz -C /usr/local/node --strip-components=1 && rm /tmp/node.tar.xz \
  && node --version

COPY scripts/install-wasm-bindgen-ci.sh /tmp/toolchain/install-wasm-bindgen-ci.sh
RUN RUNNER_TEMP=/opt bash /tmp/toolchain/install-wasm-bindgen-ci.sh && rm -rf /tmp/toolchain

LABEL org.opencontainers.image.source="https://github.com/moritzbrantner/maps" \
      org.opencontainers.image.description="Experimental Maps coding-agent provisioning comparison image (issue #211); not a required CI environment."
