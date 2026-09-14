import type { MapRenderCircle } from "./map-render-frame";
import {
  resolveMapScreenStrokeWidth,
  type MapScreenInteractionState,
  type MapScreenRenderFrame,
} from "./map-screen-render-frame";

export type MapsWgpuColor = [red: number, green: number, blue: number, alpha: number];

export type MapsWgpuApplicationCircle = {
  fillColor: MapsWgpuColor;
  radius: number;
  strokeColor: MapsWgpuColor;
  strokeWidth: number;
  x: number;
  y: number;
};

export type MapsWgpuApplicationFrame = {
  circles: MapsWgpuApplicationCircle[];
  height: number;
  width: number;
};

/**
 * Packs the currently supported first-party application geometry for the Rust/wgpu backend.
 *
 * This first production consumer deliberately accepts only complete circle-only frames. Mixed
 * frames, unsupported primitive kinds, unsupported CSS colors, or non-finite values fail closed
 * to the Canvas renderer instead of producing a visually weaker partial GPU result.
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

  const circles: MapsWgpuApplicationCircle[] = [];

  for (const scenePrimitive of frame.primitives) {
    if (scenePrimitive.kind !== "circle") return null;

    const primitive = scenePrimitive.renderPrimitive as MapRenderCircle<unknown>;
    const fillColor = parseSupportedCssColor(primitive.fillColor, primitive.fillOpacity);
    const strokeColor = parseSupportedCssColor(primitive.strokeColor, primitive.strokeOpacity);
    const strokeWidth = resolveMapScreenStrokeWidth(
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

    circles.push({
      fillColor,
      radius: primitive.radius,
      strokeColor,
      strokeWidth,
      x: scenePrimitive.x,
      y: scenePrimitive.y,
    });
  }

  return {
    circles,
    height: frame.height,
    width: frame.width,
  };
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
