from __future__ import annotations

import json
from pathlib import Path


def replace_in_section(
    path: str,
    start_marker: str,
    end_marker: str,
    old: str,
    new: str,
) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    section = text[start:end]
    if new in section:
        return
    if old not in section:
        raise RuntimeError(f"expected repair target not found in {path}: {start_marker}")
    section = section.replace(old, new, 1)
    file_path.write_text(text[:start] + section + text[end:])


replace_in_section(
    "src/temporal-geojson-geometry.ts",
    "function decomposeGeometryPart(",
    "function normalizePointGeometry(",
    '    default:\n      return [{ geometry, partPath }];',
    '    case "Point":\n    case "LineString":\n    case "Polygon":\n      return [{ geometry, partPath }];',
)

replace_in_section(
    "src/geojson-source.ts",
    "export function createMapPointsFromGeoJson",
    "export function createMapFlowsFromGeoJson",
    '      default:\n        return [];',
    '      case "LineString":\n      case "MultiLineString":\n      case "Polygon":\n      case "MultiPolygon":\n        return [];',
)
replace_in_section(
    "src/geojson-source.ts",
    "export function createMapFlowsFromGeoJson",
    "export function createGeoJsonOverlayFeatureCollection",
    '      default:\n        return [];',
    '      case "Point":\n      case "MultiPoint":\n      case "Polygon":\n      case "MultiPolygon":\n        return [];',
)
replace_in_section(
    "src/geojson-source.ts",
    "function shouldOverlayGeometry(",
    "function createSourceId<",
    '    default:\n      return true;',
    '    case "Point":\n    case "MultiPoint":\n    case "Polygon":\n    case "MultiPolygon":\n      return true;',
)

map_engine = Path("src/map-engine.tsx")
text = map_engine.read_text()
start = text.index("function renderFlatEngineLayer(")
next_function = text.find("\nfunction ", start + 1)
section_end = next_function if next_function != -1 else len(text)
section = text[start:section_end]
explicit_noop = (
    '    case "binned-series":\n'
    '    case "finance-candles":\n'
    '    case "finance-line":\n'
    '    case "finance-returns":\n'
    '    case "geo-scalar-field":\n'
    '    case "heatmap":\n'
    '    case "histogram":\n'
    '    case "rolling-series":\n'
    '    case "table":\n'
    "      break;"
)
if explicit_noop not in section:
    marker = "      break;\n  }\n}"
    position = section.rfind(marker)
    if position == -1:
        raise RuntimeError("expected renderFlatEngineLayer switch tail not found")
    section = (
        section[:position]
        + "      break;\n"
        + explicit_noop
        + "\n  }\n}"
        + section[position + len(marker) :]
    )
    map_engine.write_text(text[:start] + section + text[section_end:])

replace_in_section(
    "src/geojson-editor.tsx",
    "function getCommandEditMode(",
    "function isBooleanEditMode(",
    '    default:\n      return null;',
    '    case "cancel-draft":\n'
    '    case "clear-selection":\n'
    '    case "delete-selection":\n'
    '    case "duplicate-selection":\n'
    '    case "finish-draft":\n'
    '    case "group-selection":\n'
    '    case "remove-selected-vertex":\n'
    '    case "select-all":\n'
    '    case "ungroup-selection":\n'
    "      return null;",
)

package_path = Path("package.json")
package = json.loads(package_path.read_text())
package["devDependencies"]["@moritzbrantner/ui"] = "^1.1.0"
overrides = package.setdefault("overrides", {})
overrides.update(
    {
        "brace-expansion": "5.0.9",
        "browserslist": "4.28.7",
        "fast-uri": "3.1.5",
        "ip-address": "10.3.1",
        "js-yaml": "4.3.1",
        "nanoid": "3.3.18",
        "postcss": "8.5.18",
        "undici": "7.29.0",
    }
)
package_path.write_text(json.dumps(package, indent=2) + "\n")
