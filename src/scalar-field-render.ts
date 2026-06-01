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
  valueDomain?: readonly [min: number, max: number];
};

export type HeatFieldContourOptions = {
  levels?: number | readonly number[];
  lineColor?: string;
  lineWidth?: number;
  opacity?: number;
  valueFormat?: (value: number) => string;
  valueDomain?: readonly [min: number, max: number];
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

type PreparedHeatFieldColorRamp = {
  stops: Array<{
    color: string;
    parsed: HeatFieldParsedColor | null;
    value: number;
  }>;
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
  const preparedColorRamp = prepareHeatFieldColorRamp(colorRamp);
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

    const color = resolvePreparedHeatFieldColor(preparedColorRamp, normalizedValue);
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
  const segmentsByLevel = createHeatFieldContourSegmentsByLevel(grid, levels, valueDomain);
  const paths = segmentsByLevel
    .flat()
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
  const segmentsByLevel = createHeatFieldContourSegmentsByLevel(grid, levels, valueDomain);
  const features = levels
    .map((level, index) => {
      const lines = (segmentsByLevel[index] ?? []).map((segment) =>
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
  return resolvePreparedHeatFieldColor(prepareHeatFieldColorRamp(colorRamp), normalizedValue);
}

function prepareHeatFieldColorRamp(
  colorRamp: readonly HeatFieldColorStop[],
): PreparedHeatFieldColorRamp {
  return {
    stops: [...colorRamp]
      .sort(([left], [right]) => left - right)
      .map(([value, color]) => ({
        color,
        parsed: parseHeatFieldColor(color),
        value,
      })),
  };
}

function resolvePreparedHeatFieldColor(
  colorRamp: PreparedHeatFieldColorRamp,
  normalizedValue: number,
): HeatFieldParsedColor {
  if (colorRamp.stops.length === 0) {
    return parseHeatFieldColor("#dc2626")!;
  }

  const sortedRamp = colorRamp.stops;
  const clampedValue = clamp(normalizedValue, 0, 1);
  const first = sortedRamp[0];

  if (!first || clampedValue <= first.value) {
    return first?.parsed ?? parseHeatFieldColor("#dc2626")!;
  }

  for (let index = 1; index < sortedRamp.length; index += 1) {
    const previous = sortedRamp[index - 1]!;
    const next = sortedRamp[index]!;

    if (clampedValue > next.value) {
      continue;
    }

    const previousColor = previous.parsed;
    const nextColor = next.parsed;

    if (!previousColor || !nextColor) {
      return nextColor ?? parseHeatFieldColor("#dc2626")!;
    }

    const progress =
      next.value <= previous.value
        ? 1
        : clamp((clampedValue - previous.value) / (next.value - previous.value), 0, 1);

    return {
      alpha: previousColor.alpha + (nextColor.alpha - previousColor.alpha) * progress,
      blue: previousColor.blue + (nextColor.blue - previousColor.blue) * progress,
      green: previousColor.green + (nextColor.green - previousColor.green) * progress,
      red: previousColor.red + (nextColor.red - previousColor.red) * progress,
    };
  }

  return (
    sortedRamp[sortedRamp.length - 1]?.parsed ?? parseHeatFieldColor("#dc2626")!
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
  valueDomain: readonly [min: number, max: number] | null,
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

function createHeatFieldContourSegmentsByLevel(
  grid: ScalarFieldGrid,
  levels: readonly number[],
  valueDomain: readonly [min: number, max: number] | null,
) {
  const segmentsByLevel = levels.map((): HeatFieldContourSegment[] => []);

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
        bottomLeft === null
      ) {
        continue;
      }

      const min = Math.min(topLeft, topRight, bottomRight, bottomLeft);
      const max = Math.max(topLeft, topRight, bottomRight, bottomLeft);

      if (min === max) {
        continue;
      }

      for (
        let levelIndex = findFirstContourLevelIndex(levels, min);
        levelIndex < levels.length && levels[levelIndex]! <= max;
        levelIndex += 1
      ) {
        const level = levels[levelIndex]!;
        const crossingTop = getContourEdgeCrossing(
          { value: topLeft, x: column + 0.5, y: row + 0.5 },
          { value: topRight, x: column + 1.5, y: row + 0.5 },
          level,
        );
        const crossingRight = getContourEdgeCrossing(
          { value: topRight, x: column + 1.5, y: row + 0.5 },
          { value: bottomRight, x: column + 1.5, y: row + 1.5 },
          level,
        );
        const crossingBottom = getContourEdgeCrossing(
          { value: bottomRight, x: column + 1.5, y: row + 1.5 },
          { value: bottomLeft, x: column + 0.5, y: row + 1.5 },
          level,
        );
        const crossingLeft = getContourEdgeCrossing(
          { value: bottomLeft, x: column + 0.5, y: row + 1.5 },
          { value: topLeft, x: column + 0.5, y: row + 0.5 },
          level,
        );
        const crossingCount =
          (crossingTop ? 1 : 0) +
          (crossingRight ? 1 : 0) +
          (crossingBottom ? 1 : 0) +
          (crossingLeft ? 1 : 0);
        const segments = segmentsByLevel[levelIndex]!;

        if (crossingCount === 2) {
          const firstCrossing = crossingTop ?? crossingRight ?? crossingBottom ?? crossingLeft;
          const secondCrossing =
            firstCrossing === crossingTop
              ? crossingRight ?? crossingBottom ?? crossingLeft
              : firstCrossing === crossingRight
                ? crossingBottom ?? crossingLeft
                : crossingLeft;

          if (firstCrossing && secondCrossing) {
            segments.push([firstCrossing, secondCrossing]);
          }
        } else if (crossingCount === 4) {
          const centerValue = (topLeft + topRight + bottomRight + bottomLeft) / 4;
          const normalizedCenter = normalizeScalarFieldValue(centerValue, valueDomain) ?? 0.5;

          if (
            crossingTop &&
            crossingRight &&
            crossingBottom &&
            crossingLeft &&
            normalizedCenter >= 0.5
          ) {
            segments.push([crossingTop, crossingLeft], [crossingRight, crossingBottom]);
          } else if (crossingTop && crossingRight && crossingBottom && crossingLeft) {
            segments.push([crossingTop, crossingRight], [crossingBottom, crossingLeft]);
          }
        }
      }
    }
  }

  return segmentsByLevel;
}

function findFirstContourLevelIndex(levels: readonly number[], minValue: number) {
  let low = 0;
  let high = levels.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (levels[middle]! < minValue) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
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
