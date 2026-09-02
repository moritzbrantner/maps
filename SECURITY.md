# Security

## Supported Versions

While the package is pre-1.0, the latest published minor or patch line is
supported unless maintainers decide otherwise.

## Reporting A Vulnerability

Use GitHub private vulnerability reporting if it is enabled. Otherwise, open a
minimal security issue without exploit details and request maintainer contact.

## Scope

Security reports may cover package code, published artifacts, and dependency
vulnerabilities that affect consumers.

## Dependency Audit Baseline

The repository's high-severity dependency audit has an explicit temporary
baseline for 15 transitive advisories that were already present before the
repository-foundation rollout on 2026-09-01. The observed dependency paths were
through development tooling rather than the published runtime dependency path.

`scripts/verify-dependency-audit.ts` ignores only those exact GHSA identifiers.
Any additional high-severity advisory still fails the audit. Baseline entries
should be removed individually as upstream dependency updates eliminate them;
the baseline must not be broadened to make an unrelated foundation change pass.

## Consumer-Controlled Markup

`FlatDivIconOptions.html` is treated as trusted markup for compatibility with
DOM marker APIs. Do not pass unsanitized user-authored HTML into marker icons.

The package also uses reviewed dynamic imports for optional runtime packages,
including optional scalar-field and WASM kernel backends. These paths are for
module specifiers controlled by application code, not for arbitrary user input.
