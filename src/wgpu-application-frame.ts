import type {
  MapRenderCircle,
  MapRenderDirectionMarker,
  MapRenderLine,
} from "./map-render-frame";
import type {
  MapScreenInteractionState,
  MapScreenRenderFrame,
} from "./map-screen-render-frame";

export type MapsWgpuColor = [red: number, green: number, blue: number, alpha: number];

export type MapsWgpuApplicationPoint = {
  x: number;
  y: number;
};

export type MapsWgpuApplicationCircle = {
  fillColor: MapsWgpuColor;
  radius: number;
  strokeColor: MapsWgpuColor;
  strokeWidth: number;
  x: number;
  y: number;
};

export type MapsWgpuApplicationDirectionMarker = {
  angle: number;
  color: MapsWgpuColor;
  size: number;
  x: number;
  y: number;
};

export type MapsWgpuApplicationLine = {
  color: MapsWgpuColor;
  points: MapsWgpuApplicationPoint[];
  strokeWidth: number;
};

export type MapsWgpuApplicationPrimitive =
  | { data: MapsWgpuApplicationCircle; kind: "circle" }
  | { data: MapsWgpuApplicationDirectionMarker; kind: "directionMarker" }
  | { data: MapsWgpuApplicationLine; kind: "line" };

export type MapsWgpuApplicationFrame = {
  height: number;
  primitives: MapsWgpuApplicationPrimitive[];
  width: number;
};

/**
 * Packs first-party application geometry for the existing Rust/wgpu backend.
 *
 * Projection has already happened through the Maps-owned runtime. This transport only resolves
 * renderer-side colors and interaction stroke widths. The ordered primitive stream preserves the
 * Maps render order across circles, lines, and flow direction markers. Polygon frames still fail
 * closed to Canvas because the correctness backend owns even-odd polygon/hole behavior until the
 * GPU path can preserve it explicitly. Labels remain a thin Canvas annotation pass above wgpu.
 */
export function createMapsWgpuApplicationFrame(
  frame: MapScreenRenderFrame<unknown>,
  interaction: MapScreenInteractionState = {},
): MapsWgpuApplicationFrame | null {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return null;
  }

  const primitives: MapsWgpuApplicationPrimitive[] = [];

  for (const scenePrimitive of frame.primitives) {
    switch (scenePrimitive.kind) {
      case "circle": {
        const primitive = scenePrimitive.renderPrimitive as MapRenderCircle<unknown>;
        const fillColor = parseSupportedCssColor(primitive.fillColor, primitive.fillOpacity);
        const strokeColor = parseSupportedCssColor(primitive.strokeColor, primitive.strokeOpacity);
        const strokeWidth = resolveStrokeWidth(
          primitive.strokeWidth,
          primitive.primitiveId,
          interaction,
        );

        if (
          !fillColor ||
          !strokeColor ||
          !Number.isFinite(scenePrimitive.x) ||
          !Number.isFinite(scenePrimitive.y) ||
          !Number.isFinite(primitive.radius) ||
          primitive.radius < 0 ||
          !Number.isFinite(strokeWidth)
        ) {
          return null;
        }

        primitives.push({
          data: {
            fillColor,
            radius: primitive.radius,
            strokeColor,
            strokeWidth,
            x: scenePrimitive.x,
            y: scenePrimitive.y,
          },
          kind: "circle",
        });
        break;
      }
      case "direction-marker": {
        const primitive = scenePrimitive.renderPrimitive as MapRenderDirectionMarker<unknown>;
        const color = parseSupportedCssColor(primitive.color, primitive.opacity);
        if (
          !color ||
          !Number.isFinite(scenePrimitive.x) ||
          !Number.isFinite(scenePrimitive.y) ||
          !Number.isFinite(scenePrimitive.angle) ||
          !Number.isFinite(primitive.size) ||
          primitive.size < 0
        ) {
          return null;
        }

        primitives.push({
          data: {
            angle: scenePrimitive.angle,
            color,
            size: primitive.size,
            x: scenePrimitive.x,
            y: scenePrimitive.y,
          },
          kind: "directionMarker",
        });
        break;
      }
      case "line": {
        const primitive = scenePrimitive.renderPrimitive as MapRenderLine<unknown>;
        const color = parseSupportedCssColor(primitive.strokeColor, primitive.strokeOpacity);
        const strokeWidth = resolveStrokeWidth(
          primitive.strokeWidth,
          primitive.primitiveId,
          interaction,
        );
        const points = copyFinitePoints(scenePrimitive.points);

        if (
          !color ||
          !points ||
          points.length < 2 ||
          !hasNonDegenerateSegment(points) ||
          !Number.isFinite(strokeWidth)
        ) {
          return null;
        }

        primitives.push({ data: { color, points, strokeWidth }, kind: "line" });
        break;
      }
      case "polygon":
        return null;
    }
  }

  return {
    height: frame.height,
    primitives,
    width: frame.width,
  };
}

function copyFinitePoints(points: readonly MapsWgpuApplicationPoint[]) {
  const copied: MapsWgpuApplicationPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    copied.push({ x: point.x, y: point.y });
  }
  return copied;
}

function hasNonDegenerateSegment(points: readonly MapsWgpuApplicationPoint[]) {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    if (previous.x !== point.x || previous.y !== point.y) return true;
  }
  return false;
}

function resolveStrokeWidth(
  base: number,
  primitiveId: string,
  interaction: MapScreenInteractionState,
) {
  return Math.max(
    0,
    base +
      (interaction.selectedPrimitiveIds?.has(primitiveId)
        ? 1.5
        : interaction.hoveredPrimitiveIds?.has(primitiveId)
          ? 1
          : 0),
  );
}

function parseSupportedCssColor(value: string, opacity: number): MapsWgpuColor | null {
  if (!Number.isFinite(opacity)) return null;
  const normalizedOpacity = clamp01(opacity);
  const text = value.trim().toLowerCase();
  let rgba: MapsWgpuColor | null = null;

  if (text.startsWith("#")) {
    rgba = parseHexColor(text.slice(1));
  } else {
    const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
      text,
    );
    if (match) {
      const red = Number(match[1]);
      const green = Number(match[2]);
      const blue = Number(match[3]);
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if ([red, green, blue, alpha].every(Number.isFinite)) {
        rgba = [clamp01(red / 255), clamp01(green / 255), clamp01(blue / 255), clamp01(alpha)];
      }
    }
  }

  if (!rgba) return null;
  return [
    srgbToLinear(rgba[0]),
    srgbToLinear(rgba[1]),
    srgbToLinear(rgba[2]),
    rgba[3] * normalizedOpacity,
  ];
}

function parseHexColor(hex: string): MapsWgpuColor | null {
  if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/.test(hex)) return null;
  const expanded =
    hex.length <= 4
      ? hex
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : hex;
  const withAlpha = expanded.length === 6 ? `${expanded}ff` : expanded;
  const parts = [0, 2, 4, 6].map((offset) => Number.parseInt(withAlpha.slice(offset, offset + 2), 16));
  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255, parts[3]! / 255];
}

function srgbToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
