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

## Consumer-Controlled Markup

`FlatDivIconOptions.html` is treated as trusted markup for compatibility with
DOM marker APIs. Do not pass unsanitized user-authored HTML into marker icons.

The package also uses reviewed dynamic imports for optional runtime packages,
including optional scalar-field and WASM kernel backends. These paths are for
module specifiers controlled by application code, not for arbitrary user input.
