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
  points: readonly MapsWgpuApplicationPoint[];
  strokeWidth: number;
};

export const MAPS_WGPU_APPLICATION_CIRCLE = 0;
export const MAPS_WGPU_APPLICATION_LINE = 1;
export const MAPS_WGPU_APPLICATION_DIRECTION_MARKER = 2;

export type MapsWgpuApplicationOrderEntry = [
  kind:
    | typeof MAPS_WGPU_APPLICATION_CIRCLE
    | typeof MAPS_WGPU_APPLICATION_LINE
    | typeof MAPS_WGPU_APPLICATION_DIRECTION_MARKER,
  index: number,
];

export type MapsWgpuApplicationFrame = {
  circles: MapsWgpuApplicationCircle[];
  directionMarkers: MapsWgpuApplicationDirectionMarker[];
  height: number;
  lines: MapsWgpuApplicationLine[];
  order: MapsWgpuApplicationOrderEntry[];
  width: number;
};

/**
 * Packs first-party application geometry for the existing Rust/wgpu backend.
 *
 * Projection has already happened through the Maps-owned runtime. This transport only resolves
 * renderer-side colors and interaction stroke widths. Per-kind arrays keep WASM deserialization
 * simple and compact; `order` preserves the exact Maps render order across circles, lines, and flow
 * direction markers. Projected line points are reused directly until the unavoidable WASM boundary.
 * Polygon frames still fail closed to Canvas because the correctness backend owns even-odd
 * polygon/hole behavior until the GPU path can preserve it explicitly. Labels remain a thin Canvas
 * annotation pass above wgpu geometry.
 */
type CachedPaint = {
  fill?: { color: string; opacity: number; value: MapsWgpuColor | null };
  stroke?: { color: string; opacity: number; value: MapsWgpuColor | null };
  marker?: { color: string; opacity: number; value: MapsWgpuColor | null };
};

export function createMapsWgpuApplicationFramePacker() {
  const paintCache = new WeakMap<object, CachedPaint>();

  return (
    frame: MapScreenRenderFrame<unknown>,
    interaction: MapScreenInteractionState = {},
  ): MapsWgpuApplicationFrame | null =>
    packMapsWgpuApplicationFrame(frame, interaction, paintCache);
}

export function createMapsWgpuApplicationFrame(
  frame: MapScreenRenderFrame<unknown>,
  interaction: MapScreenInteractionState = {},
): MapsWgpuApplicationFrame | null {
  return packMapsWgpuApplicationFrame(frame, interaction, new WeakMap());
}

function packMapsWgpuApplicationFrame(
  frame: MapScreenRenderFrame<unknown>,
  interaction: MapScreenInteractionState,
  paintCache: WeakMap<object, CachedPaint>,
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
  const directionMarkers: MapsWgpuApplicationDirectionMarker[] = [];
  const lines: MapsWgpuApplicationLine[] = [];
  const order: MapsWgpuApplicationOrderEntry[] = [];

  for (const scenePrimitive of frame.primitives) {
    switch (scenePrimitive.kind) {
      case "circle": {
        const primitive = scenePrimitive.renderPrimitive as MapRenderCircle<unknown>;
        const fillColor = resolveCachedColor(
          paintCache,
          primitive,
          "fill",
          primitive.fillColor,
          primitive.fillOpacity,
        );
        const strokeColor = resolveCachedColor(
          paintCache,
          primitive,
          "stroke",
          primitive.strokeColor,
          primitive.strokeOpacity,
        );
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

        order.push([MAPS_WGPU_APPLICATION_CIRCLE, circles.length]);
        circles.push({
          fillColor,
          radius: primitive.radius,
          strokeColor,
          strokeWidth,
          x: scenePrimitive.x,
          y: scenePrimitive.y,
        });
        break;
      }
      case "direction-marker": {
        const primitive = scenePrimitive.renderPrimitive as MapRenderDirectionMarker<unknown>;
        const color = resolveCachedColor(
          paintCache,
          primitive,
          "marker",
          primitive.color,
          primitive.opacity,
        );
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

        order.push([MAPS_WGPU_APPLICATION_DIRECTION_MARKER, directionMarkers.length]);
        directionMarkers.push({
          angle: scenePrimitive.angle,
          color,
          size: primitive.size,
          x: scenePrimitive.x,
          y: scenePrimitive.y,
        });
        break;
      }
      case "line": {
        const primitive = scenePrimitive.renderPrimitive as MapRenderLine<unknown>;
        const color = resolveCachedColor(
          paintCache,
          primitive,
          "stroke",
          primitive.strokeColor,
          primitive.strokeOpacity,
        );
        const strokeWidth = resolveStrokeWidth(
          primitive.strokeWidth,
          primitive.primitiveId,
          interaction,
        );
        const points = scenePrimitive.points;

        if (
          !color ||
          points.length < 2 ||
          !allFinitePoints(points) ||
          !hasNonDegenerateSegment(points) ||
          !Number.isFinite(strokeWidth)
        ) {
          return null;
        }

        order.push([MAPS_WGPU_APPLICATION_LINE, lines.length]);
        lines.push({ color, points, strokeWidth });
        break;
      }
      case "polygon":
        return null;
    }
  }

  return {
    circles,
    directionMarkers,
    height: frame.height,
    lines,
    order,
    width: frame.width,
  };
}

function allFinitePoints(points: readonly MapsWgpuApplicationPoint[]) {
  return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
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

function resolveCachedColor(
  cache: WeakMap<object, CachedPaint>,
  primitive: object,
  slot: keyof CachedPaint,
  color: string,
  opacity: number,
): MapsWgpuColor | null {
  let cached = cache.get(primitive);
  if (!cached) {
    cached = {};
    cache.set(primitive, cached);
  }

  const current = cached[slot];
  if (current && current.color === color && Object.is(current.opacity, opacity)) {
    return current.value;
  }

  const value = parseSupportedCssColor(color, opacity);
  cached[slot] = { color, opacity, value };
  return value;
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
