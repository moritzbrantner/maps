# Provisioning comparison: Ubuntu, Nix and a prebuilt agent image

Issue [#211](https://github.com/moritzbrantner/maps/issues/211) asked whether
coding agents and CI should get their tools from conventional Ubuntu
provisioning, the locked `nix develop` shell or a prebuilt, digest-pinned
container image. The owner decided on 2026-10-11 to prefer precompiled,
checksum-verified tool installers and source/digest-bound artifacts, keep locked
Nix shells optional, and measure a container candidate before adopting one.
This page records that measurement and the resulting recommendation. It is
CI-timing evidence, not a Maps runtime-profiler or Moonlight verdict.

## Local fresh-checkout setup

Either path uses the same lockfiles and the same validation commands.

Conventional (any Linux/macOS host):

1. Install Rust with rustup. `rust-toolchain.toml` selects the channel,
   components and the `wasm32-unknown-unknown` target.
2. Install Bun at the `packageManager` version in `package.json` and Node 24.
3. Run `bash scripts/install-wasm-bindgen-ci.sh` for the checksum-verified
   wasm-bindgen CLI (its digests mirror `flake.nix`), or install
   wasm-bindgen-cli 0.2.129 yourself.
4. Run `bun install --frozen-lockfile`, then `bun run verify:agent` or
   `bun run verify:rust`.

Nix (Linux): run `nix develop`, then the same `bun install --frozen-lockfile`
and verification commands; see [CONTRIBUTING](../CONTRIBUTING.md#nix-development-environment).
The shell provides only tools. `rust-toolchain.toml`, `bun.lock` and
`Cargo.lock` stay authoritative.

## Rollback path

Nothing here changed a required check. Rust Validation and Git Install
Validation in `ci.yml` keep using the locked Nix shell, as before. To stop using
Nix in a job, replace its `Install Nix` and `nix develop --command` steps with the
conventional steps from `.github/workflows/provisioning-sample.yml` (Rust
toolchain action, `setup-bun`, `setup-node`, `scripts/install-wasm-bindgen-ci.sh`).
The task commands do not change. To drop the experiment, delete
`provisioning-comparison.yml`, `provisioning-sample.yml`, `.github/provisioning/`
and the summary script with its test. No package, registry entry or persistent
cache outlives a run: the image artifact expires after one day and the run's
caches are deleted by its last job.

## Method

`Maps Provisioning Comparison` (manual `workflow_dispatch`, never required) runs
three variants of one task on fresh GitHub-hosted `ubuntu-26.04` runners:

- **ubuntu**: Rust toolchain action, `setup-bun` from `package.json`,
  `setup-node` 24 and the verified wasm-bindgen installer.
- **nix**: `NixOS/nix-installer-action`, then the locked `nix develop` shell.
- **container**: an image built once per run from
  `.github/provisioning/agent-image.Dockerfile`. Its base is pinned by digest. It
  takes Rust from `rust-toolchain.toml`, Bun from `packageManager`, Node 24 and
  the verified wasm-bindgen installer, so it adds no version authority of its own.
  Samples run the task in it with `docker run` as the runner user. There is no
  privileged mode and no nested Docker.

Every sample checks out the same commit and runs the same commands:
`bun install --frozen-lockfile`, `bun run verify:rust`, `bun run build:wasm`, and
a non-empty WASM artifact check.

- **cold** samples restore no Actions caches. The container still downloads and
  loads its image on its fresh runner.
- **prime** runs once per variant and saves Cargo registry/Git, the Bun install
  cache, `target` and, for Nix, an exported file store of the dev-shell closure
  and flake inputs.
- **warm** samples are fresh runners that restore that run's caches. A cache miss
  fails the sample.

`scripts/summarize-provisioning-comparison.mjs <run-id>` derives the table below
from the hosted job and step timestamps. `scripts/provisioning-comparison.test.ts`
guards the manual-only shape, the identical task and the image's version
sources.

GHCR rejected `GITHUB_TOKEN` pushes for a new Maps package (runs
[42440205152](https://github.com/moritzbrantner/maps/actions/runs/42440205152),
[42440385717](https://github.com/moritzbrantner/maps/actions/runs/42440385717)).
The image therefore travels as a one-day run artifact, and each sample checks its
content-addressed image ID after `docker load`. Artifact download and load stand
in for a registry pull. A real registry pull was **not measured**.

## Results (2026-11-08)

Run [42441346269](https://github.com/moritzbrantner/maps/actions/runs/42441346269):
33/33 jobs succeeded, with five cold and five warm samples per variant plus one
prime per variant. Every job ran source `719b6833277eb0d7eae9a6d56a8732fbd7bb011b`
on runner image `ubuntu26-20261101.186.1`.

Lock digests (SHA-256):

- `flake.lock`: `7e9a25a5…3591861`
- `Cargo.lock`: `f6eba404…2fd3565`
- `bun.lock`: `de8d0406…c2f796a`

Agent image: `sha256:52657f2f…1901033f`. It took 88 s to build, export and
upload, and its compressed artifact is 556 MB.

Every variant ran rustc/cargo 1.99.1 and wasm-bindgen 0.2.129. Bun and Node
differed:

| Variant | Bun | Node |
| --- | --- | --- |
| ubuntu | 1.4.4 | 24.22.2 |
| container | 1.4.4 | 24.22.2 |
| nix | 1.4.3 (flake drift from `packageManager`) | 24.20.0 |

Medians use successful samples. "Start → verification" is job start until the
Rust/WASM verification step begins: the startup an agent waits before its first
executable test.

| Variant | Cache | Success | Median job (range) | Start → verification | Provisioning | Cache restore | `bun install` | Verification | Summed job time | Billed runner-min |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ubuntu | cold | 5/5 | 225 s (160–229) | **69 s** | 5 s | — | 59 s | 154 s | 1062 s | 19 |
| nix | cold | 5/5 | 246 s (182–261) | 88 s | 21 s | — | 61 s | 156 s | 1184 s | 24 |
| container | cold | 5/5 | 284 s (210–290) | 129 s | 35 s | — | 85 s | 124 s | 1334 s | 24 |
| ubuntu | warm | 5/5 | **162 s** (155–183) | **69 s** | 6 s | 15 s | 48 s | 91 s | 832 s | 16 |
| nix | warm | 5/5 | 191 s (144–215) | 93 s | 5 s | 35 s | 45 s | 88 s | 915 s | 18 |
| container | warm | 5/5 | 203 s (180–230) | 122 s | 26 s | 12 s | 67 s | 84 s | 1025 s | 19 |

The one-off prime jobs took 229 s for ubuntu, 418 s for nix and 277 s for the
container. The Nix figure includes exporting the store closure. The container's
88 s image job is an extra per-run cost that the table does not include.

Readings:

- **Startup.** Conventional Ubuntu reached the first executable test soonest in
  both cache states: 69 s, versus 88/93 s for Nix and 129/122 s for the
  container. The container's `bun install` inside `docker run` was consistently
  slower (85 s cold, 67 s warm), and loading the image cost 16–35 s per fresh
  runner.
- **Warm caches.** Persisted caches cut median job time for every variant. The
  savings came from `target` and dependency caches, in the verification step,
  not from provisioning. Nix's persisted store import (about 35 s including
  restore) was slower than downloading the same paths from cache.nixos.org on a
  cold runner (about 21 s), so caching the Nix store does not pay off here.
- **Reliability.** None of the 33 jobs failed because of the environment. That
  is too few to estimate a failure-rate difference.
- **Agreement with October.** The two cold batches in October (Ubuntu 24.04
  runner, runs [38099596528](https://github.com/moritzbrantner/maps/actions/runs/38099596528)
  and [38099772801](https://github.com/moritzbrantner/maps/actions/runs/38099772801))
  also had Nix 6–23 s slower to the first verification, with no repeatable
  winner on total job time. Those runs used a different source and runner image
  and are not pooled with this one.

## Recommendation

- Keep conventional Ubuntu provisioning with checksum-verified precompiled tools
  as the baseline for agent tasks and new CI jobs. It was fastest to the first
  test, cold and warm, and adds no authority beyond the lockfiles,
  `rust-toolchain.toml` and `packageManager`.
- Retain the locked Nix shell as an optional local environment and in the two
  existing required jobs. It costs about 20 s of startup per job and showed no
  throughput or reliability advantage. Moving those jobs to conventional
  provisioning would change required-check provisioning, so it is left to a
  separate, owner-approved change. Do not cache the Nix store in Actions.
- **Do not adopt the prebuilt agent container.** It lost on startup, total time
  and runner time in both cache states, and it adds a 556 MB artifact or
  registry package plus image maintenance. Revisit only if registry pulls are
  available and an agent platform reuses images across tasks.
- Align the flake's Bun (1.4.3) with `packageManager` (1.4.4) on its next update.
  Node patch versions also differ between `nixpkgs` and `setup-node`.

## Not measured (inconclusive)

- Agent token cost, time to first useful edit and end-to-end agent task
  completion. These need agent-run telemetry; CI step timings cannot establish
  them.
- Reused long-lived workspaces. Every sample here is a fresh ephemeral runner.
- Registry pull and storage cost for the container (see GHCR above).
- Browser, GPU and Playwright workflows. They keep their existing provisioning
  and were not forced into the container.
