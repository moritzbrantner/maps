import {
  normalizeScalarFieldValue,
  type ScalarFieldGrid,
} from "./scalar-field";
import type {
  GeoJsonMultiLineStringGeometry,
  GeoJsonPosition,
  TemporalGeoJsonGeometryFeatureCollection,
} from "./temporal-geojson-types";

export type HeatFieldColorStop = readonly [valueOrNormalized: number, color: string];

export type HeatFieldImageOptions = {
  colorRamp?: readonly HeatFieldColorStop[];
  opacity?: number;
  valueDomain?: [min: number, max: number];
};

export type HeatFieldContourOptions = {
  levels?: number | readonly number[];
  lineColor?: string;
  lineWidth?: number;
  opacity?: number;
  valueFormat?: (value: number) => string;
  valueDomain?: [min: number, max: number];
};

export type HeatFieldContourFeatureProperties = {
  kind: "heat-field-contour";
  label: string;
  levelIndex: number;
  levelCount: number;
  normalizedValue: number;
  value: number;
  valueLabel: string;
};

export type HeatFieldContourFeatureCollection =
  TemporalGeoJsonGeometryFeatureCollection<HeatFieldContourFeatureProperties>;

export type HeatFieldImage = {
  bounds: [west: number, south: number, east: number, north: number];
  height: number;
  url: string;
  width: number;
};

const defaultHeatFieldColorRamp = [
  [0, "#2563eb"],
  [0.25, "#22c55e"],
  [0.5, "#fde047"],
  [0.75, "#fb923c"],
  [1, "#dc2626"],
] as const satisfies readonly HeatFieldColorStop[];

export function createHeatFieldImage(
  grid: ScalarFieldGrid,
  options: HeatFieldImageOptions = {},
): HeatFieldImage | null {
  if (grid.columns <= 0 || grid.rows <= 0 || grid.values.length === 0) {
    return null;
  }

  const colorRamp = options.colorRamp ?? defaultHeatFieldColorRamp;
  const opacity = clamp(options.opacity ?? 1, 0, 1);
  const valueDomain = options.valueDomain ?? grid.valueDomain;
  const rgba = new Uint8ClampedArray(grid.columns * grid.rows * 4);

  for (let index = 0; index < grid.values.length; index += 1) {
    const value = grid.values[index];

    if (value === null || !Number.isFinite(value)) {
      continue;
    }

    const normalizedValue = normalizeScalarFieldValue(value, valueDomain);

    if (normalizedValue === null) {
      continue;
    }

    const color = resolveHeatFieldColor(colorRamp, normalizedValue);
    const pixelOffset = index * 4;

    rgba[pixelOffset] = Math.round(clamp(color.red, 0, 255));
    rgba[pixelOffset + 1] = Math.round(clamp(color.green, 0, 255));
    rgba[pixelOffset + 2] = Math.round(clamp(color.blue, 0, 255));
    rgba[pixelOffset + 3] = Math.round(clamp(color.alpha * opacity, 0, 1) * 255);
  }

  return {
    bounds: grid.bounds,
    height: grid.rows,
    url: createRasterDataUrl(rgba, grid.columns, grid.rows, colorRamp, opacity),
    width: grid.columns,
  };
}

export function createHeatFieldContourImage(
  grid: ScalarFieldGrid,
  options: HeatFieldContourOptions = {},
): HeatFieldImage | null {
  if (grid.columns <= 1 || grid.rows <= 1 || grid.values.length === 0) {
    return null;
  }

  const valueDomain = options.valueDomain ?? grid.valueDomain;
  const levels = resolveHeatFieldContourLevels(valueDomain, options.levels);

  if (levels.length === 0) {
    return null;
  }

  const stroke = escapeSvgAttribute(options.lineColor ?? "#0f172a");
  const strokeWidth = roundSvgNumber(clamp(options.lineWidth ?? 1.35, 0.25, 12));
  const opacity = clamp(options.opacity ?? 1, 0, 1);
  const paths = levels
    .flatMap((level) => createHeatFieldContourSegments(grid, level, valueDomain))
    .map((segment) => {
      const [start, end] = segment;

      return `<path d="M ${roundSvgNumber(start.x)} ${roundSvgNumber(start.y)} L ${roundSvgNumber(
        end.x,
      )} ${roundSvgNumber(end.y)}" />`;
    })
    .join("");

  if (!paths) {
    return null;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${grid.columns}" height="${grid.rows}" viewBox="0 0 ${grid.columns} ${grid.rows}" preserveAspectRatio="none"><rect width="100%" height="100%" fill="transparent" /><g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${roundSvgNumber(
    opacity,
  )}">${paths}</g></svg>`;

  return {
    bounds: grid.bounds,
    height: grid.rows,
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    width: grid.columns,
  };
}

export function createHeatFieldContourFeatureCollection(
  grid: ScalarFieldGrid,
  options: HeatFieldContourOptions = {},
): HeatFieldContourFeatureCollection {
  if (grid.columns <= 1 || grid.rows <= 1 || grid.values.length === 0) {
    return {
      features: [],
      type: "FeatureCollection",
    };
  }

  const valueDomain = options.valueDomain ?? grid.valueDomain;
  const levels = resolveHeatFieldContourLevels(valueDomain, options.levels);
  const features = levels
    .map((level, index) => {
      const lines = createHeatFieldContourSegments(grid, level, valueDomain).map((segment) =>
        segment.map((point) => heatFieldContourPointToCoordinate(grid, point)) as [
          GeoJsonPosition,
          GeoJsonPosition,
        ],
      );

      if (lines.length === 0) {
        return null;
      }

      const valueLabel = options.valueFormat?.(level) ?? formatHeatFieldContourValue(level);
      const geometry: GeoJsonMultiLineStringGeometry = {
        coordinates: lines,
        type: "MultiLineString",
      };

      return {
        geometry,
        id: `contour-${index}`,
        properties: {
          kind: "heat-field-contour" as const,
          label: valueLabel,
          levelIndex: index,
          levelCount: levels.length,
          normalizedValue: normalizeScalarFieldValue(level, valueDomain) ?? 0.5,
          value: level,
          valueLabel,
        },
        type: "Feature" as const,
      };
    })
    .filter(isDefined);

  return {
    features,
    type: "FeatureCollection",
  };
}

export function resolveHeatFieldColor(
  colorRamp: readonly HeatFieldColorStop[],
  normalizedValue: number,
): HeatFieldParsedColor {
  if (colorRamp.length === 0) {
    return parseHeatFieldColor("#dc2626")!;
  }

  const sortedRamp = [...colorRamp].sort(([left], [right]) => left - right);
  const clampedValue = clamp(normalizedValue, 0, 1);
  const first = sortedRamp[0];

  if (!first || clampedValue <= first[0]) {
    return parseHeatFieldColor(first?.[1] ?? "#dc2626") ?? parseHeatFieldColor("#dc2626")!;
  }

  for (let index = 1; index < sortedRamp.length; index += 1) {
    const previous = sortedRamp[index - 1]!;
    const next = sortedRamp[index]!;

    if (clampedValue > next[0]) {
      continue;
    }

    const previousColor = parseHeatFieldColor(previous[1]);
    const nextColor = parseHeatFieldColor(next[1]);

    if (!previousColor || !nextColor) {
      return parseHeatFieldColor(next[1]) ?? parseHeatFieldColor("#dc2626")!;
    }

    const progress =
      next[0] <= previous[0]
        ? 1
        : clamp((clampedValue - previous[0]) / (next[0] - previous[0]), 0, 1);

    return {
      alpha: previousColor.alpha + (nextColor.alpha - previousColor.alpha) * progress,
      blue: previousColor.blue + (nextColor.blue - previousColor.blue) * progress,
      green: previousColor.green + (nextColor.green - previousColor.green) * progress,
      red: previousColor.red + (nextColor.red - previousColor.red) * progress,
    };
  }

  return (
    parseHeatFieldColor(sortedRamp[sortedRamp.length - 1]?.[1] ?? "#dc2626") ??
    parseHeatFieldColor("#dc2626")!
  );
}

export type HeatFieldParsedColor = {
  alpha: number;
  blue: number;
  green: number;
  red: number;
};

export function parseHeatFieldColor(color: string): HeatFieldParsedColor | null {
  const trimmedColor = color.trim();

  if (trimmedColor === "transparent") {
    return {
      alpha: 0,
      blue: 0,
      green: 0,
      red: 0,
    };
  }

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmedColor);

  if (hexMatch?.[1]) {
    const hex = hexMatch[1];
    const normalizedHex =
      hex.length === 3
        ? hex
            .split("")
            .map((channel) => `${channel}${channel}`)
            .join("")
        : hex;

    return {
      alpha: 1,
      blue: Number.parseInt(normalizedHex.slice(4, 6), 16),
      green: Number.parseInt(normalizedHex.slice(2, 4), 16),
      red: Number.parseInt(normalizedHex.slice(0, 2), 16),
    };
  }

  const rgbMatch =
    /^rgba?\(\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:,|\s)\s*([0-9.]+)(?:(?:,|\s*\/\s*)\s*([0-9.]+))?\s*\)$/i.exec(
      trimmedColor,
    );

  if (!rgbMatch) {
    return null;
  }

  return {
    alpha: rgbMatch[4] === undefined ? 1 : clamp(Number(rgbMatch[4]), 0, 1),
    blue: clamp(Number(rgbMatch[3]), 0, 255),
    green: clamp(Number(rgbMatch[2]), 0, 255),
    red: clamp(Number(rgbMatch[1]), 0, 255),
  };
}

function createRasterDataUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  colorRamp: readonly HeatFieldColorStop[],
  opacity: number,
) {
  if (canUseCanvas()) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (context) {
      canvas.width = width;
      canvas.height = height;
      const imageData = context.createImageData(width, height);

      imageData.data.set(rgba);
      context.putImageData(imageData, 0, 0);

      return canvas.toDataURL("image/png");
    }
  }

  return createSvgFallbackDataUrl(rgba, width, height, colorRamp, opacity);
}

function canUseCanvas() {
  return (
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    !/jsdom/i.test(navigator.userAgent) &&
    typeof ImageData !== "undefined"
  );
}

function createSvgFallbackDataUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  _colorRamp: readonly HeatFieldColorStop[],
  _opacity: number,
) {
  const rects: string[] = [];

  for (let index = 0; index < width * height; index += 1) {
    const alpha = rgba[index * 4 + 3] ?? 0;

    if (alpha <= 0) {
      continue;
    }

    const x = index % width;
    const y = Math.floor(index / width);
    const red = rgba[index * 4] ?? 0;
    const green = rgba[index * 4 + 1] ?? 0;
    const blue = rgba[index * 4 + 2] ?? 0;

    rects.push(
      `<rect x="${x}" y="${y}" width="1" height="1" fill="rgba(${red}, ${green}, ${blue}, ${roundSvgNumber(
        alpha / 255,
      )})" />`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects.join(
    "",
  )}</svg>`;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function roundSvgNumber(value: number) {
  return Number(value.toFixed(3));
}

function resolveHeatFieldContourLevels(
  valueDomain: [min: number, max: number] | null,
  levels: HeatFieldContourOptions["levels"],
) {
  if (!valueDomain) {
    return [];
  }

  const [min, max] = valueDomain;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }

  if (Array.isArray(levels)) {
    return [...new Set(levels.filter((level) => Number.isFinite(level)))]
      .filter((level) => level >= Math.min(min, max) && level <= Math.max(min, max))
      .sort((left, right) => left - right);
  }

  if (max <= min) {
    return [min];
  }

  const levelCount = Math.floor(clamp(typeof levels === "number" ? levels : 9, 1, 48));
  const resolvedLevels: number[] = [];

  for (let index = 1; index <= levelCount; index += 1) {
    resolvedLevels.push(min + ((max - min) * index) / (levelCount + 1));
  }

  return resolvedLevels;
}

type HeatFieldContourPoint = {
  x: number;
  y: number;
};

type HeatFieldContourSegment = readonly [HeatFieldContourPoint, HeatFieldContourPoint];

function createHeatFieldContourSegments(
  grid: ScalarFieldGrid,
  level: number,
  valueDomain: [min: number, max: number] | null,
) {
  const segments: HeatFieldContourSegment[] = [];

  for (let row = 0; row < grid.rows - 1; row += 1) {
    for (let column = 0; column < grid.columns - 1; column += 1) {
      const topLeft = getContourGridValue(grid, column, row);
      const topRight = getContourGridValue(grid, column + 1, row);
      const bottomRight = getContourGridValue(grid, column + 1, row + 1);
      const bottomLeft = getContourGridValue(grid, column, row + 1);

      if (
        topLeft === null ||
        topRight === null ||
        bottomRight === null ||
        bottomLeft === null ||
        !cellContainsContourLevel([topLeft, topRight, bottomRight, bottomLeft], level)
      ) {
        continue;
      }

      const crossings = [
        getContourEdgeCrossing(
          { value: topLeft, x: column + 0.5, y: row + 0.5 },
          { value: topRight, x: column + 1.5, y: row + 0.5 },
          level,
        ),
        getContourEdgeCrossing(
          { value: topRight, x: column + 1.5, y: row + 0.5 },
          { value: bottomRight, x: column + 1.5, y: row + 1.5 },
          level,
        ),
        getContourEdgeCrossing(
          { value: bottomRight, x: column + 1.5, y: row + 1.5 },
          { value: bottomLeft, x: column + 0.5, y: row + 1.5 },
          level,
        ),
        getContourEdgeCrossing(
          { value: bottomLeft, x: column + 0.5, y: row + 1.5 },
          { value: topLeft, x: column + 0.5, y: row + 0.5 },
          level,
        ),
      ].filter(isDefined);

      if (crossings.length === 2) {
        segments.push([crossings[0]!, crossings[1]!]);
      } else if (crossings.length === 4) {
        const centerValue = (topLeft + topRight + bottomRight + bottomLeft) / 4;
        const normalizedCenter = normalizeScalarFieldValue(centerValue, valueDomain) ?? 0.5;

        if (normalizedCenter >= 0.5) {
          segments.push([crossings[0]!, crossings[3]!], [crossings[1]!, crossings[2]!]);
        } else {
          segments.push([crossings[0]!, crossings[1]!], [crossings[2]!, crossings[3]!]);
        }
      }
    }
  }

  return segments;
}

function heatFieldContourPointToCoordinate(
  grid: ScalarFieldGrid,
  point: HeatFieldContourPoint,
): GeoJsonPosition {
  const [west, south, east, north] = grid.bounds;
  const longitude = west + (point.x / grid.columns) * (east - west);
  const latitude = north - (point.y / grid.rows) * (north - south);

  return [longitude, latitude];
}

function getContourGridValue(grid: ScalarFieldGrid, column: number, row: number) {
  const value = grid.values[row * grid.columns + column] ?? null;

  return value !== null && Number.isFinite(value) ? value : null;
}

function cellContainsContourLevel(values: readonly number[], level: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);

  return level >= min && level <= max && min !== max;
}

function getContourEdgeCrossing(
  start: HeatFieldContourPoint & { value: number },
  end: HeatFieldContourPoint & { value: number },
  level: number,
) {
  const startOffset = start.value - level;
  const endOffset = end.value - level;

  if (startOffset === 0 && endOffset === 0) {
    return null;
  }

  if ((startOffset < 0 && endOffset < 0) || (startOffset > 0 && endOffset > 0)) {
    return null;
  }

  const denominator = end.value - start.value;
  const progress = denominator === 0 ? 0 : clamp((level - start.value) / denominator, 0, 1);

  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  };
}

function escapeSvgAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

function formatHeatFieldContourValue(value: number) {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  const absoluteValue = Math.abs(value);

  if (absoluteValue >= 100) {
    return value.toFixed(0);
  }

  if (absoluteValue >= 10) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
