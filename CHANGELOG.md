# @moritzbrantner/maps

## 0.1.5

### Patch Changes

- Slimmed the default `styles.css` export by removing Tailwind
  preflight/global reset and added `styles.full.css` as the compatibility
  stylesheet.
- Made bundle analysis baselines hash-insensitive for emitted chunks.
- Added benchmark warning thresholds alongside hard failure budgets.
- Updated `@moritzbrantner/ui` to `1.0.0`; refreshed Chromium smoke
  screenshots for the resulting UI spacing and styling changes.

## 0.1.4

### Patch Changes

- Added controlled bee-line measurement props for flat MapLibre maps.
- Made default heat-map radius and interpolated intensity data-space based.

## 0.1.3

### Patch Changes

- Extracted the package into the standalone `moritzbrantner/maps` repository.
- Kept the public exports and runtime behavior unchanged.

## 0.1.2

### Patch Changes

- Updated dependencies:
  - @moritzbrantner/ui@0.4.0

## 0.1.1

### Patch Changes

- Release every package in the workspace.

- Updated dependencies []:
  - @moritzbrantner/data-density@0.1.1
  - @moritzbrantner/ui@0.3.1
