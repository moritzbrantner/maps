
import type {
  MapRenderCircle,
  MapRenderDirectionMarker,
  MapRenderLine,
  MapRenderPolygon,
  MapVectorRenderFrame,
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
  /** Even-odd rings, as Canvas fills them; the renderer tessellates through its stencil. */
  rings: readonly (readonly MapsWgpuApplicationPoint[])[];
  strokeColor: MapsWgpuColor;
  strokeWidth: number;
};

export const MAPS_WGPU_APPLICATION_CIRCLE = 0;
export const MAPS_WGPU_APPLICATION_LINE = 1;
export const MAPS_WGPU_APPLICATION_DIRECTION_MARKER = 2;
export const MAPS_WGPU_APPLICATION_POLYGON = 3;
/** Painter-order run `(kind, group, 1)` drawing a GPU-retained point group (#155). */
export const MAPS_WGPU_APPLICATION_RETAINED_POINTS = 4;

/**
 * Retained point paint record shared with `maps-wasm` (`RETAINED_POINT_PAINT_LENGTH`):
 * radius, stroke width (CSS px), fill RGBA, stroke RGBA (encoded sRGB).
 */
export const MAPS_RETAINED_POINT_PAINT_STRIDE = 10;

/** Geographic application points for the GPU-retained path; projection stays in Rust. */
export type MapsRetainedApplicationPoints = {
  count: number;
  /** `[longitude, latitude]` per point, lowered once by Rust. */
  lonLat: Float64Array;
  /** `MAPS_RETAINED_POINT_PAINT_STRIDE` values per point, interaction deltas applied. */
  paint: Float32Array;
};

/**
 * Packed circle record shared with `maps-wasm` (`APPLICATION_CIRCLE_RECORD_LENGTH`): x, y,
 * radius, stroke width (viewport CSS px), fill RGBA, stroke RGBA (encoded sRGB).
 */
export const MAPS_WGPU_APPLICATION_CIRCLE_STRIDE = 12;
/** Painter-order runs: (kind, first index, count) per run of consecutive same-kind entries. */
export const MAPS_WGPU_APPLICATION_ORDER_STRIDE = 3;

export type MapsWgpuApplicationFrame = {
  /** `circleCount` packed circle records; a view into the packer's reused buffer. */
  circleData: Float32Array;
  circleCount: number;
  directionMarkers: MapsWgpuApplicationDirectionMarker[];
  height: number;
  lines: MapsWgpuApplicationLine[];
  /** Painter-order runs over all kinds; a view into the packer's reused buffer. */
  order: Uint32Array;
  polygons: MapsWgpuApplicationPolygon[];
  width: number;
};

/** Deterministic work and bridge counters of one packer, for transport evidence. */
export type MapsWgpuApplicationTransportStats = {
  /** Frames packed. */
  frames: number;
  /** Circles packed into typed records (no per-circle transport objects). */
  circles: number;
  /** CSS colors parsed; repeated paint values reuse the cached RGBA. */
  paintParses: number;
  /** Typed bytes handed to the WASM bridge for circles and painter order. */
  transportBytes: number;
  /** Typed-buffer (re)allocations; steady frames reuse the grown buffers. */
  bufferAllocations: number;
};

export type MapsWgpuApplicationFramePacker = {
  pack(
    frame: MapScreenRenderFrame<unknown>,
    interaction?: MapScreenInteractionState,
  ): MapsWgpuApplicationFrame | null;
  stats(): MapsWgpuApplicationTransportStats;
};

const PAINT_CACHE_LIMIT = 4096;

/**
 * Packs first-party application geometry for the existing Rust/wgpu backend.
 *
 * Projection has already happened through the Maps-owned runtime. This transport only resolves
 * renderer-side colors and interaction stroke widths. Circles, the dense case, cross the WASM
 * boundary as one reused `Float32Array` of fixed records rather than one object per circle, and
 * painter order as run-length `Uint32Array` runs; resolved paint is cached by CSS value, so
 * camera-only frames do not reparse colors. Lines, polygons and direction markers keep the
 * object transport until their retained representation (#155) replaces it. Maps remains
 * authoritative for geographic projection, ring semantics, identity and interaction state;
 * the renderer only fills rings even-odd, as Canvas does. Labels remain a thin
 * Canvas annotation pass above wgpu geometry.
 *
 * A packed frame's typed arrays are views into the packer's buffers: they stay valid until the
 * next `pack` call, which is when the host replaces its current frame.
 */
export function createMapsWgpuApplicationFramePacker(): MapsWgpuApplicationFramePacker {
  let circleBuffer = new Float32Array(0);
  let orderBuffer = new Uint32Array(0);
  const paintCache = new Map<string, MapsWgpuColor | null>();
  const stats: MapsWgpuApplicationTransportStats = {
    bufferAllocations: 0,
    circles: 0,
    frames: 0,
    paintParses: 0,
    transportBytes: 0,
  };

  const paint = (value: string, opacity: number) => {
    const key = `${value}\u0000${opacity}`;
    let color = paintCache.get(key);
    if (color === undefined) {
      if (paintCache.size >= PAINT_CACHE_LIMIT) paintCache.clear();
      color = parseSupportedCssColor(value, opacity);
      paintCache.set(key, color);
      stats.paintParses += 1;
    }
    return color;
  };

  return {
    pack(frame, interaction = {}) {
      if (
        !Number.isFinite(frame.width) ||
        !Number.isFinite(frame.height) ||
        frame.width <= 0 ||
        frame.height <= 0
      ) {
        return null;
      }

      const circleCapacity = frame.primitives.length * MAPS_WGPU_APPLICATION_CIRCLE_STRIDE;
      if (circleBuffer.length < circleCapacity) {
        circleBuffer = new Float32Array(Math.max(circleCapacity, circleBuffer.length * 2));
        stats.bufferAllocations += 1;
      }
      const orderCapacity = frame.primitives.length * MAPS_WGPU_APPLICATION_ORDER_STRIDE;
      if (orderBuffer.length < orderCapacity) {
        orderBuffer = new Uint32Array(Math.max(orderCapacity, orderBuffer.length * 2));
        stats.bufferAllocations += 1;
      }

      let circleCount = 0;
      let orderLength = 0;
      const directionMarkers: MapsWgpuApplicationDirectionMarker[] = [];
      const lines: MapsWgpuApplicationLine[] = [];
      const polygons: MapsWgpuApplicationPolygon[] = [];
      const pushOrder = (kind: number, index: number) => {
        if (
          orderLength > 0 &&
          orderBuffer[orderLength - 3] === kind &&
          orderBuffer[orderLength - 2]! + orderBuffer[orderLength - 1]! === index
        ) {
          orderBuffer[orderLength - 1]! += 1;
          return;
        }
        orderBuffer[orderLength] = kind;
        orderBuffer[orderLength + 1] = index;
        orderBuffer[orderLength + 2] = 1;
        orderLength += MAPS_WGPU_APPLICATION_ORDER_STRIDE;
      };

      for (const scenePrimitive of frame.primitives) {
        switch (scenePrimitive.kind) {
          case "circle": {
            const primitive = scenePrimitive.renderPrimitive as MapRenderCircle<unknown>;
            const fillColor = paint(primitive.fillColor, primitive.fillOpacity);
            const strokeColor = paint(primitive.strokeColor, primitive.strokeOpacity);
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

            pushOrder(MAPS_WGPU_APPLICATION_CIRCLE, circleCount);
            const offset = circleCount * MAPS_WGPU_APPLICATION_CIRCLE_STRIDE;
            circleBuffer[offset] = scenePrimitive.x;
            circleBuffer[offset + 1] = scenePrimitive.y;
            circleBuffer[offset + 2] = primitive.radius;
            circleBuffer[offset + 3] = strokeWidth;
            circleBuffer.set(fillColor, offset + 4);
            circleBuffer.set(strokeColor, offset + 8);
            circleCount += 1;
            break;
          }
          case "direction-marker": {
            const primitive = scenePrimitive.renderPrimitive as MapRenderDirectionMarker<unknown>;
            const color = paint(primitive.color, primitive.opacity);
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

            pushOrder(MAPS_WGPU_APPLICATION_DIRECTION_MARKER, directionMarkers.length);
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
            const color = paint(primitive.strokeColor, primitive.strokeOpacity);
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

            pushOrder(MAPS_WGPU_APPLICATION_LINE, lines.length);
            lines.push({ color, points, strokeWidth });
            break;
          }
          case "polygon": {
            const primitive = scenePrimitive.renderPrimitive as MapRenderPolygon<unknown>;
            const fillColor = paint(primitive.fillColor, primitive.fillOpacity);
            const strokeColor = paint(primitive.strokeColor, primitive.strokeOpacity);
            const strokeWidth = resolveStrokeWidth(
              primitive.strokeWidth,
              primitive.primitiveId,
              interaction,
            );
            const rings = preparePolygonRings(scenePrimitive.rings);

            if (!fillColor || !strokeColor || !Number.isFinite(strokeWidth) || !rings) {
              return null;
            }
            // Every ring collapsed to a point: Canvas draws nothing for it either.
            if (rings.length === 0) break;

            pushOrder(MAPS_WGPU_APPLICATION_POLYGON, polygons.length);
            polygons.push({
              fillColor,
              rings,
              strokeColor,
              strokeWidth,
            });
            break;
          }
        }
      }

      const circleData = circleBuffer.subarray(0, circleCount * MAPS_WGPU_APPLICATION_CIRCLE_STRIDE);
      const order = orderBuffer.subarray(0, orderLength);
      stats.frames += 1;
      stats.circles += circleCount;
      stats.transportBytes += circleData.byteLength + order.byteLength;
      return {
        circleCount,
        circleData,
        directionMarkers,
        height: frame.height,
        lines,
        order,
        polygons,
        width: frame.width,
      };
    },
    stats() {
      return { ...stats };
    },
  };
}

/** One-off packing with a fresh packer (tests and probes); hosts keep one packer. */
export function createMapsWgpuApplicationFrame(
  frame: MapScreenRenderFrame<unknown>,
  interaction: MapScreenInteractionState = {},
): MapsWgpuApplicationFrame | null {
  return createMapsWgpuApplicationFramePacker().pack(frame, interaction);
}

/** Decodes the packed circle records (tests and diagnostics). */
export function readMapsWgpuApplicationCircles(
  frame: MapsWgpuApplicationFrame,
): MapsWgpuApplicationCircle[] {
  return Array.from({ length: frame.circleCount }, (_, index) => {
    const offset = index * MAPS_WGPU_APPLICATION_CIRCLE_STRIDE;
    const data = frame.circleData;
    return {
      fillColor: [data[offset + 4]!, data[offset + 5]!, data[offset + 6]!, data[offset + 7]!],
      radius: data[offset + 2]!,
      strokeColor: [data[offset + 8]!, data[offset + 9]!, data[offset + 10]!, data[offset + 11]!],
      strokeWidth: data[offset + 3]!,
      x: data[offset]!,
      y: data[offset + 1]!,
    };
  });
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

/** Rings without repeated points; `null` (Canvas fallback) for non-finite geometry. */
function preparePolygonRings(
  sourceRings: readonly (readonly MapsWgpuApplicationPoint[])[],
): MapsWgpuApplicationPoint[][] | null {
  if (sourceRings.length === 0) return null;
  const rings: MapsWgpuApplicationPoint[][] = [];
  for (const source of sourceRings) {
    const ring = normalizePolygonRing(source);
    if (!allFinitePoints(ring)) return null;
    // Fewer than two distinct points draw nothing on Canvas either.
    if (ring.length >= 2) rings.push(ring);
  }
  return rings;
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

/**
 * Parses a hex/rgb(a) CSS color into encoded sRGB RGBA. The wgpu surface blends in encoded
 * sRGB, as Canvas does, so translucent paint composites the same on both backends.
 */
export function parseMapsWgpuCssColor(value: string, opacity = 1): MapsWgpuColor | null {
  return parseSupportedCssColor(value, opacity);
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
  return [rgba[0], rgba[1], rgba[2], rgba[3] * normalizedOpacity];
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

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

/**
 * The retained point form of a vector frame, or `null` when the frame is not made only of
 * unlabeled circles (labels and other primitives still need screen projection). Paint is
 * resolved here, with the same hover/selection stroke deltas as the screen transport.
 */
export function createMapsRetainedApplicationPoints(
  frame: MapVectorRenderFrame<unknown>,
  interaction: MapScreenInteractionState = {},
): MapsRetainedApplicationPoints | null {
  const count = frame.primitives.length;
  if (count === 0) return null;
  const lonLat = new Float64Array(count * 2);
  const paint = new Float32Array(count * MAPS_RETAINED_POINT_PAINT_STRIDE);
  const colors = new Map<string, MapsWgpuColor | null>();
  const color = (value: string, opacity: number) => {
    const key = `${value}\u0000${opacity}`;
    let resolved = colors.get(key);
    if (resolved === undefined) {
      resolved = parseSupportedCssColor(value, opacity);
      colors.set(key, resolved);
    }
    return resolved;
  };

  for (let index = 0; index < count; index += 1) {
    const primitive = frame.primitives[index]!;
    if (primitive.kind !== "circle" || primitive.label) return null;
    const fillColor = color(primitive.fillColor, primitive.fillOpacity);
    const strokeColor = color(primitive.strokeColor, primitive.strokeOpacity);
    const strokeWidth = resolveStrokeWidth(primitive.strokeWidth, primitive.primitiveId, interaction);
    const [longitude, latitude] = primitive.center;
    if (
      !fillColor ||
      !strokeColor ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(primitive.radius) ||
      primitive.radius < 0 ||
      !Number.isFinite(strokeWidth)
    ) {
      return null;
    }
    lonLat[index * 2] = longitude;
    lonLat[index * 2 + 1] = latitude;
    const offset = index * MAPS_RETAINED_POINT_PAINT_STRIDE;
    paint[offset] = primitive.radius;
    paint[offset + 1] = strokeWidth;
    paint.set(fillColor, offset + 2);
    paint.set(strokeColor, offset + 6);
  }
  return { count, lonLat, paint };
}

/** An application frame that only draws retained point `group` (no screen geometry). */
export function createMapsWgpuRetainedPointsFrame(
  group: number,
  width: number,
  height: number,
): MapsWgpuApplicationFrame {
  return {
    circleCount: 0,
    circleData: new Float32Array(0),
    directionMarkers: [],
    height,
    lines: [],
    order: Uint32Array.of(MAPS_WGPU_APPLICATION_RETAINED_POINTS, group, 1),
    polygons: [],
    width,
  };
}
