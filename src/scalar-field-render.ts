import {
  normalizeScalarFieldValue,
  type ScalarFieldGrid,
} from "./scalar-field";

export type HeatFieldColorStop = readonly [valueOrNormalized: number, color: string];

export type HeatFieldImageOptions = {
  colorRamp?: readonly HeatFieldColorStop[];
  opacity?: number;
  valueDomain?: [min: number, max: number];
};

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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
