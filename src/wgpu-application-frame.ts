import earcut from "earcut";

import type {
  MapRenderCircle,
  MapRenderDirectionMarker,
  MapRenderLine,
  MapRenderPolygon,
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

export type MapsWgpuApplicationPolygon = {
  fillColor: MapsWgpuColor;
  fillPoints: readonly MapsWgpuApplicationPoint[];
  rings: readonly (readonly MapsWgpuApplicationPoint[])[];
  strokeColor: MapsWgpuColor;
  strokeWidth: number;
};

export const MAPS_WGPU_APPLICATION_CIRCLE = 0;
export const MAPS_WGPU_APPLICATION_LINE = 1;
export const MAPS_WGPU_APPLICATION_DIRECTION_MARKER = 2;
export const MAPS_WGPU_APPLICATION_POLYGON = 3;

export type MapsWgpuApplicationOrderEntry = [
  kind:
    | typeof MAPS_WGPU_APPLICATION_CIRCLE
    | typeof MAPS_WGPU_APPLICATION_LINE
    | typeof MAPS_WGPU_APPLICATION_DIRECTION_MARKER
    | typeof MAPS_WGPU_APPLICATION_POLYGON,
  index: number,
];

export type MapsWgpuApplicationFrame = {
  circles: MapsWgpuApplicationCircle[];
  directionMarkers: MapsWgpuApplicationDirectionMarker[];
  height: number;
  lines: MapsWgpuApplicationLine[];
  order: MapsWgpuApplicationOrderEntry[];
  polygons: MapsWgpuApplicationPolygon[];
  width: number;
};

/**
 * Packs first-party application geometry for the existing Rust/wgpu backend.
 *
 * Projection has already happened through the Maps-owned runtime. This transport only resolves
 * renderer-side colors and interaction stroke widths. Per-kind arrays keep WASM deserialization
 * simple and compact; `order` preserves the exact Maps render order across circles, lines, polygons,
 * and flow direction markers. Projected line and polygon points are reused directly until the
 * unavoidable WASM boundary. Polygon fills use Earcut only as renderer-side screen-space
 * tessellation; Maps remains authoritative for geographic projection, ring semantics, identity and
 * interaction state. Labels remain a thin Canvas annotation pass above wgpu geometry.
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
  const directionMarkers: MapsWgpuApplicationDirectionMarker[] = [];
  const lines: MapsWgpuApplicationLine[] = [];
  const order: MapsWgpuApplicationOrderEntry[] = [];
  const polygons: MapsWgpuApplicationPolygon[] = [];

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
        const color = parseSupportedCssColor(primitive.strokeColor, primitive.strokeOpacity);
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
      case "polygon": {
        const primitive = scenePrimitive.renderPrimitive as MapRenderPolygon<unknown>;
        const fillColor = parseSupportedCssColor(primitive.fillColor, primitive.fillOpacity);
        const strokeColor = parseSupportedCssColor(primitive.strokeColor, primitive.strokeOpacity);
        const strokeWidth = resolveStrokeWidth(
          primitive.strokeWidth,
          primitive.primitiveId,
          interaction,
        );
        const geometry = preparePolygonGeometry(scenePrimitive.rings);

        if (!fillColor || !strokeColor || !Number.isFinite(strokeWidth) || !geometry) {
          return null;
        }

        order.push([MAPS_WGPU_APPLICATION_POLYGON, polygons.length]);
        polygons.push({
          fillColor,
          fillPoints: geometry.fillPoints,
          rings: geometry.rings,
          strokeColor,
          strokeWidth,
        });
        break;
      }
    }
  }

  return {
    circles,
    directionMarkers,
    height: frame.height,
    lines,
    order,
    polygons,
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

function preparePolygonGeometry(
  sourceRings: readonly (readonly MapsWgpuApplicationPoint[])[],
): { fillPoints: MapsWgpuApplicationPoint[]; rings: MapsWgpuApplicationPoint[][] } | null {
  if (sourceRings.length === 0) return null;

  const rings: MapsWgpuApplicationPoint[][] = [];
  const vertices: number[] = [];
  const holeIndices: number[] = [];

  for (let ringIndex = 0; ringIndex < sourceRings.length; ringIndex += 1) {
    const ring = normalizePolygonRing(sourceRings[ringIndex]!);
    if (ring.length < 3 || !allFinitePoints(ring)) return null;

    if (ringIndex > 0) holeIndices.push(vertices.length / 2);
    rings.push(ring);
    for (const point of ring) vertices.push(point.x, point.y);
  }

  let indices: number[];
  try {
    indices = earcut(vertices, holeIndices, 2);
  } catch {
    return null;
  }
  if (indices.length === 0 || indices.length % 3 !== 0) return null;

  const fillPoints: MapsWgpuApplicationPoint[] = [];
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index * 2 + 1 >= vertices.length) return null;
    fillPoints.push({ x: vertices[index * 2]!, y: vertices[index * 2 + 1]! });
  }
  return { fillPoints, rings };
}

function normalizePolygonRing(
  source: readonly MapsWgpuApplicationPoint[],
): MapsWgpuApplicationPoint[] {
  const ring: MapsWgpuApplicationPoint[] = [];
  for (const point of source) {
    const previous = ring.at(-1);
    if (previous?.x === point.x && previous.y === point.y) continue;
    ring.push(point);
  }

  const first = ring[0];
  const last = ring.at(-1);
  if (ring.length > 1 && first && last && first.x === last.x && first.y === last.y) {
    ring.pop();
  }
  return ring;
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
