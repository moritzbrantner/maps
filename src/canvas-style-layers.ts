/**
 * Canvas2D pixels of tileset style layers (#346): the fallback draws the very frames the wgpu
 * backend draws. Rust (`MapsStyleLayerFrames`, `crates/maps-wasm/src/style_layer_frames.rs`)
 * lays out and places the style layers and hands over the wgpu programs' vertex buffers,
 * draw runs, tile frame uniforms and atlases; this module only runs those programs' vertex
 * and fragment math (`application_circle.wgsl`, `symbol_sdf.wgsl`, the line strips of
 * `retained_polygons.wgsl`, `line_pattern.wgsl` and `fill_pattern.wgsl`) on the CPU and
 * composites the result over the Canvas frame. No layout, placement or paint is evaluated
 * here.
 *
 * Rasterization follows the GPU's rules: one sample at each pixel centre, the top-left fill
 * rule, perspective-correct interpolation, clipping to `0 ≤ z ≤ w`, premultiplied
 * source-over blending, and texture sampling at texel centres (`LINEAR` or `NEAREST`, clamped
 * or repeating as each wgpu sampler is). The only intended differences are float precision
 * and 8-bit rounding: the GPU rounds after every draw, the Canvas once after all of them.
 */

export const STYLE_DRAW_STRIDE = 5;
export const STYLE_DRAW_CIRCLES = 0;
export const STYLE_DRAW_GLYPHS = 1;
export const STYLE_DRAW_ICONS = 2;
export const STYLE_DRAW_LINES = 3;
export const STYLE_DRAW_FILLS = 4;
export const STYLE_DRAW_FILL_OUTLINES = 5;
/** Mirrors `TILE_FRAME_FLOATS`: matrix (16), surface uniform (4), representable flag. */
export const STYLE_TILE_FRAME_FLOATS = 21;

const CIRCLE_FLOATS = 14;
const GLYPH_FLOATS = 22;
const LINE_FLOATS = 20;
const FILL_FLOATS = 16;
const OUTLINE_FLOATS = 20;
const FILL_PATTERN = 1;
const FILL_SDF = 2;
const FILL_CLIP_TO_TILE = 4;
const SDF_PX = 8;

/** One frame of `MapsStyleLayerFrames`. */
export type StyleLayerFrame = {
  circles: Float32Array;
  /** MapLibre's pattern cross-fade: (from scale, to scale, fade). */
  crossfade: Float32Array;
  /** Draw runs: kind, tile frame, first, count, flag. */
  draws: Uint32Array;
  fills: Float32Array;
  glyphs: Float32Array;
  lines: Float32Array;
  outlines: Float32Array;
  tileFrames: Float32Array;
};

/** A texture as its wgpu program samples it: R8 (`channels: 1`) or premultiplied RGBA8. */
export type StyleLayerTexture = {
  channels: 1 | 4;
  data: Uint8Array;
  height: number;
  width: number;
};

export type StyleLayerTextures = {
  /** The dash atlas (R8, `Repeat`), for dashed lines. */
  dash?: StyleLayerTexture | null;
  /** The SDF glyph atlas (R8). */
  glyph?: StyleLayerTexture | null;
  /** The style images' atlas (premultiplied RGBA), for icons and patterns. */
  image?: StyleLayerTexture | null;
};

/** A premultiplied RGBA float surface of `width` x `height` physical px. */
export type StyleLayerTarget = {
  data: Float32Array;
  /** The pixels drawn since the last clear: [x0, y0, x1, y1), empty when x0 ≥ x1. */
  dirty: [number, number, number, number];
  height: number;
  width: number;
};

export type StyleLayerScissor = { height: number; width: number; x: number; y: number };

/**
 * The physical-pixel viewport inside a `surface` (the viewport grown by `margin` CSS px per
 * side), rounded outward: the wgpu backend's viewport-only scissor (`SurfaceClip::scissor`).
 */
export function styleLayerViewportScissor(
  viewport: { height: number; width: number },
  margin: number,
  surface: { height: number; width: number },
): StyleLayerScissor {
  const axis = (css: number, physical: number) => {
    const scale = physical / (css + 2 * margin);
    const start = Math.min(Math.max(Math.floor(margin * scale), 0), physical);
    const end = Math.min(Math.max(Math.ceil((margin + css) * scale), start), physical);
    return [start, end - start] as const;
  };
  const [x, width] = axis(viewport.width, surface.width);
  const [y, height] = axis(viewport.height, surface.height);
  return { height, width, x, y };
}

export function createStyleLayerTarget(width: number, height: number): StyleLayerTarget {
  return {
    data: new Float32Array(width * height * 4),
    dirty: [width, height, 0, 0],
    height,
    width,
  };
}

/** Clears what the last frame drew. */
export function clearStyleLayerTarget(target: StyleLayerTarget) {
  const [x0, y0, x1, y1] = target.dirty;
  for (let y = y0; y < y1; y += 1) {
    target.data.fill(0, (y * target.width + x0) * 4, (y * target.width + x1) * 4);
  }
  target.dirty = [target.width, target.height, 0, 0];
}

// ---------------------------------------------------------------------------------------
// Rasterizer

type ClipVertex = {
  /** Barycentric weights of this vertex over the original triangle. */
  l: [number, number, number];
  w: number;
  x: number;
  y: number;
  z: number;
};

/**
 * Called per covered pixel with the perspective-correct barycentric weights over the draw's
 * original triangle and the pixel's framebuffer position.
 */
type Fragment = (l0: number, l1: number, l2: number, px: number, py: number) => void;

/** The current triangle's barycentrics at any framebuffer point, for derivatives. */
const derivatives = {
  ax: 0,
  ay: 0,
  area: 0,
  bx: 0,
  by: 0,
  cx: 0,
  cy: 0,
  la: [1, 0, 0] as [number, number, number],
  lb: [0, 1, 0] as [number, number, number],
  lc: [0, 0, 1] as [number, number, number],
  qa: 1,
  qb: 1,
  qc: 1,
  at(x: number, y: number, out: [number, number, number]) {
    const wa = ((this.cx - this.bx) * (y - this.by) - (this.cy - this.by) * (x - this.bx)) / this.area;
    const wb = ((this.ax - this.cx) * (y - this.cy) - (this.ay - this.cy) * (x - this.cx)) / this.area;
    const wc = 1 - wa - wb;
    const pa = wa * this.qa;
    const pb = wb * this.qb;
    const pc = wc * this.qc;
    const sum = pa + pb + pc || 1;
    for (let index = 0; index < 3; index += 1) {
      out[index] = (pa * this.la[index]! + pb * this.lb[index]! + pc * this.lc[index]!) / sum;
    }
    return out;
  },
};

function insideAll(vertex: ClipVertex) {
  return vertex.w > 0 && vertex.z >= 0 && vertex.z <= vertex.w;
}

function lerpVertex(a: ClipVertex, b: ClipVertex, t: number): ClipVertex {
  return {
    l: [
      a.l[0] + (b.l[0] - a.l[0]) * t,
      a.l[1] + (b.l[1] - a.l[1]) * t,
      a.l[2] + (b.l[2] - a.l[2]) * t,
    ],
    w: a.w + (b.w - a.w) * t,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

const CLIP_PLANES: ReadonlyArray<(vertex: ClipVertex) => number> = [
  (vertex) => vertex.z,
  (vertex) => vertex.w - vertex.z,
  // Points on the camera plane have no position; the depth planes leave only w = 0 there.
  (vertex) => vertex.w - 1e-9,
];

function clipPolygon(polygon: ClipVertex[]) {
  let current = polygon;
  for (const plane of CLIP_PLANES) {
    const next: ClipVertex[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const a = current[index]!;
      const b = current[(index + 1) % current.length]!;
      const da = plane(a);
      const db = plane(b);
      if (da >= 0) next.push(a);
      if (da >= 0 !== db >= 0) next.push(lerpVertex(a, b, da / (da - db)));
    }
    current = next;
    if (current.length < 3) return current;
  }
  return current;
}

/** Edges whose pixel centres they pass through belong to their triangle: top and left. */
function topLeft(dx: number, dy: number) {
  return dy < 0 || (dy === 0 && dx > 0);
}

const corner: [number, number, number] = [0, 0, 0];

function rasterizeClipped(
  target: StyleLayerTarget,
  scissor: StyleLayerScissor,
  a: ClipVertex,
  b: ClipVertex,
  c: ClipVertex,
  fragment: Fragment,
) {
  const { width, height } = target;
  const screen = (vertex: ClipVertex) => [
    ((vertex.x / vertex.w + 1) / 2) * width,
    ((1 - vertex.y / vertex.w) / 2) * height,
  ];
  let [ax, ay] = screen(a) as [number, number];
  let [bx, by] = screen(b) as [number, number];
  let [cx, cy] = screen(c) as [number, number];
  let area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-12) return;
  if (area < 0) {
    [b, c] = [c, b];
    [bx, by, cx, cy] = [cx, cy, bx, by];
    area = -area;
  }
  const x0 = Math.max(scissor.x, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(scissor.x + scissor.width, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(scissor.y, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(scissor.y + scissor.height, Math.ceil(Math.max(ay, by, cy)));
  if (x0 >= x1 || y0 >= y1) return;
  Object.assign(derivatives, {
    ax,
    ay,
    area,
    bx,
    by,
    cx,
    cy,
    la: a.l,
    lb: b.l,
    lc: c.l,
    qa: 1 / a.w,
    qb: 1 / b.w,
    qc: 1 / c.w,
  });
  const qa = 1 / a.w;
  const qb = 1 / b.w;
  const qc = 1 / c.w;
  // Weight of A is the edge B→C, of B the edge C→A, of C the edge A→B.
  const tieA = topLeft(cx - bx, cy - by);
  const tieB = topLeft(ax - cx, ay - cy);
  const tieC = topLeft(bx - ax, by - ay);
  let drew = false;
  for (let py = y0; py < y1; py += 1) {
    const y = py + 0.5;
    for (let px = x0; px < x1; px += 1) {
      const x = px + 0.5;
      const ea = (cx - bx) * (y - by) - (cy - by) * (x - bx);
      if (ea < 0 || (ea === 0 && !tieA)) continue;
      const eb = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
      if (eb < 0 || (eb === 0 && !tieB)) continue;
      const ec = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (ec < 0 || (ec === 0 && !tieC)) continue;
      const pa = (ea / area) * qa;
      const pb = (eb / area) * qb;
      const pc = (ec / area) * qc;
      const sum = pa + pb + pc;
      for (let index = 0; index < 3; index += 1) {
        corner[index] = (pa * a.l[index]! + pb * b.l[index]! + pc * c.l[index]!) / sum;
      }
      fragment(corner[0], corner[1], corner[2], px, py);
      drew = true;
    }
  }
  if (drew) {
    const dirty = target.dirty;
    dirty[0] = Math.min(dirty[0], x0);
    dirty[1] = Math.min(dirty[1], y0);
    dirty[2] = Math.max(dirty[2], x1);
    dirty[3] = Math.max(dirty[3], y1);
  }
}

/** Rasterizes one triangle given its clip-space positions (x, y, z, w). */
function rasterizeTriangle(
  target: StyleLayerTarget,
  scissor: StyleLayerScissor,
  p0: ArrayLike<number>,
  p1: ArrayLike<number>,
  p2: ArrayLike<number>,
  fragment: Fragment,
) {
  const vertex = (p: ArrayLike<number>, l: [number, number, number]): ClipVertex => ({
    l,
    w: p[3]!,
    x: p[0]!,
    y: p[1]!,
    z: p[2]!,
  });
  const a = vertex(p0, [1, 0, 0]);
  const b = vertex(p1, [0, 1, 0]);
  const c = vertex(p2, [0, 0, 1]);
  if (![a, b, c].every((v) => Number.isFinite(v.x + v.y + v.z + v.w))) return;
  if (insideAll(a) && insideAll(b) && insideAll(c)) {
    rasterizeClipped(target, scissor, a, b, c, fragment);
    return;
  }
  const polygon = clipPolygon([a, b, c]);
  for (let index = 1; index + 1 < polygon.length; index += 1) {
    rasterizeClipped(target, scissor, polygon[0]!, polygon[index]!, polygon[index + 1]!, fragment);
  }
}

// ---------------------------------------------------------------------------------------
// Shader helpers

function blend(target: StyleLayerTarget, px: number, py: number, r: number, g: number, b: number, a: number) {
  if (a <= 0 && r <= 0 && g <= 0 && b <= 0) return;
  const data = target.data;
  const index = (py * target.width + px) * 4;
  const keep = 1 - a;
  data[index] = r + data[index]! * keep;
  data[index + 1] = g + data[index + 1]! * keep;
  data[index + 2] = b + data[index + 2]! * keep;
  data[index + 3] = a + data[index + 3]! * keep;
}

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hermite(t: number) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function fract(value: number) {
  return value - Math.floor(value);
}

function wrapIndex(index: number, size: number, repeat: boolean) {
  if (repeat) return ((index % size) + size) % size;
  return index < 0 ? 0 : index >= size ? size - 1 : index;
}

const texel: [number, number, number, number] = [0, 0, 0, 0];

/** `textureSample`: R8 reads (r, 0, 0, 1); RGBA reads its four channels in [0, 1]. */
function sample(
  texture: StyleLayerTexture,
  u: number,
  v: number,
  linear: boolean,
  repeat: boolean,
  out: [number, number, number, number] = texel,
) {
  const { width, height, channels, data } = texture;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  const read = (x: number, y: number, weight: number) => {
    const offset = (wrapIndex(y, height, repeat) * width + wrapIndex(x, width, repeat)) * channels;
    if (channels === 1) {
      out[0] += (data[offset]! / 255) * weight;
      out[3] += weight;
    } else {
      out[0] += (data[offset]! / 255) * weight;
      out[1] += (data[offset + 1]! / 255) * weight;
      out[2] += (data[offset + 2]! / 255) * weight;
      out[3] += (data[offset + 3]! / 255) * weight;
    }
  };
  if (!linear) {
    read(Math.floor(u * width), Math.floor(v * height), 1);
    return out;
  }
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  read(x0, y0, (1 - fx) * (1 - fy));
  read(x0 + 1, y0, fx * (1 - fy));
  read(x0, y0 + 1, (1 - fx) * fy);
  read(x0 + 1, y0 + 1, fx * fy);
  return out;
}

function interpolate(values: ArrayLike<number>, stride: number, offset: number, l0: number, l1: number, l2: number) {
  return values[offset]! * l0 + values[offset + stride]! * l1 + values[offset + 2 * stride]! * l2;
}

/** Column-major 4x4 matrix times (x, y, 0, 1). */
function transform(matrix: ArrayLike<number>, base: number, x: number, y: number) {
  return [
    matrix[base]! * x + matrix[base + 4]! * y + matrix[base + 12]!,
    matrix[base + 1]! * x + matrix[base + 5]! * y + matrix[base + 13]!,
    matrix[base + 2]! * x + matrix[base + 6]! * y + matrix[base + 14]!,
    matrix[base + 3]! * x + matrix[base + 7]! * y + matrix[base + 15]!,
  ];
}

// ---------------------------------------------------------------------------------------
// Programs

type DrawContext = {
  frame: StyleLayerFrame;
  scissor: StyleLayerScissor;
  target: StyleLayerTarget;
  textures: StyleLayerTextures;
};

const CIRCLE_CORNERS = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];

/** `application_circle.wgsl` over `count` instances. */
function drawCircles({ frame, scissor, target }: DrawContext, first: number, count: number) {
  const data = frame.circles;
  for (let instance = first; instance < first + count; instance += 1) {
    const base = instance * CIRCLE_FLOATS;
    if (base + CIRCLE_FLOATS > data.length) break;
    const [cx, cy, ox, oy, fillRatio, blur] = [0, 1, 2, 3, 4, 5].map((index) => data[base + index]!) as [
      number, number, number, number, number, number,
    ];
    const fill = [6, 7, 8, 9].map((index) => data[base + index]!);
    const stroke = [10, 11, 12, 13].map((index) => data[base + index]!);
    const fillPremultiplied = [fill[0]! * fill[3]!, fill[1]! * fill[3]!, fill[2]! * fill[3]!, fill[3]!];
    const strokePremultiplied = [
      stroke[0]! * stroke[3]!,
      stroke[1]! * stroke[3]!,
      stroke[2]! * stroke[3]!,
      stroke[3]!,
    ];
    const position = (corner: number) => [
      cx + CIRCLE_CORNERS[corner * 2]! * ox,
      cy + CIRCLE_CORNERS[corner * 2 + 1]! * oy,
      0,
      1,
    ];
    for (let triangle = 0; triangle < 2; triangle += 1) {
      const corners = [triangle * 3, triangle * 3 + 1, triangle * 3 + 2];
      const local = corners.flatMap((corner) => [
        CIRCLE_CORNERS[corner * 2]!,
        CIRCLE_CORNERS[corner * 2 + 1]!,
      ]);
      rasterizeTriangle(
        target,
        scissor,
        position(corners[0]!),
        position(corners[1]!),
        position(corners[2]!),
        (l0, l1, l2, px, py) => {
          const lx = interpolate(local, 2, 0, l0, l1, l2);
          const ly = interpolate(local, 2, 1, l0, l1, l2);
          const distance = Math.hypot(lx, ly);
          const opacity = hermite((1 - distance) / blur);
          const weight = hermite((distance - fillRatio + blur) / blur);
          const mix = (index: number) =>
            (fillPremultiplied[index]! * (1 - weight) + strokePremultiplied[index]! * weight) * opacity;
          blend(target, px, py, mix(0), mix(1), mix(2), mix(3));
        },
      );
    }
  }
}

/** `symbol_sdf.wgsl` (glyphs, SDF icons and plain icons) over `count` vertices. */
function drawGlyphs(
  { frame, scissor, target }: DrawContext,
  first: number,
  count: number,
  atlas: StyleLayerTexture | null | undefined,
  linear: boolean,
) {
  if (!atlas) return;
  const data = frame.glyphs;
  for (let vertex = first; vertex + 2 < first + count; vertex += 3) {
    const base = vertex * GLYPH_FLOATS;
    if (base + 3 * GLYPH_FLOATS > data.length) break;
    const position = (offset: number) => [data[offset]!, data[offset + 1]!, 0, data[offset + 3]!];
    const size = data[base + 6]!;
    const totalOpacity = data[base + 7]!;
    const haloWidth = data[base + 8]!;
    const haloBlur = data[base + 9]!;
    const isPlain = data[base + 10]! > 0.5;
    const isHalo = data[base + 11]! > 0.5;
    const edgeGamma = 0.105 / data[base + 12]!;
    const kind = data[base + 13]!;
    const fill = [14, 15, 16, 17].map((index) => data[base + index]!);
    const halo = [18, 19, 20, 21].map((index) => data[base + index]!);
    rasterizeTriangle(
      target,
      scissor,
      position(base),
      position(base + GLYPH_FLOATS),
      position(base + 2 * GLYPH_FLOATS),
      (l0, l1, l2, px, py) => {
        const u = interpolate(data, GLYPH_FLOATS, base + 4, l0, l1, l2);
        const v = interpolate(data, GLYPH_FLOATS, base + 5, l0, l1, l2);
        const gammaScale = interpolate(data, GLYPH_FLOATS, base + 2, l0, l1, l2);
        const color = sample(atlas, u, v, linear, false);
        if (kind > 1.5) {
          blend(
            target,
            px,
            py,
            color[0] * totalOpacity,
            color[1] * totalOpacity,
            color[2] * totalOpacity,
            color[3] * totalOpacity,
          );
          return;
        }
        const fontScale = kind > 0.5 ? size : size / 24;
        const gamma = edgeGamma / fontScale;
        const innerEdge = (256 - 64) / 256;
        const distance = kind > 0.5 ? color[3] : color[0];
        let text = [0, 0, 0, 0];
        let haloColor = [0, 0, 0, 0];
        if (isPlain) {
          const scaled = gamma * gammaScale;
          const alpha = smoothstep(innerEdge - scaled, innerEdge + scaled, distance);
          text = fill.map((channel) => totalOpacity * alpha * channel);
        }
        if (isHalo) {
          const gammaHalo = ((haloBlur * 1.19) / SDF_PX + edgeGamma) / fontScale;
          const scaled = gammaHalo * gammaScale;
          const innerEdgeHalo = innerEdge + scaled;
          let alphaHalo = smoothstep(innerEdgeHalo - scaled, innerEdgeHalo + scaled, distance);
          const haloEdge = (6 - haloWidth / fontScale) / SDF_PX;
          alphaHalo = Math.min(smoothstep(haloEdge - scaled, haloEdge + scaled, distance), 1 - alphaHalo);
          haloColor = halo.map((channel) => totalOpacity * alphaHalo * channel);
        }
        const out =
          isPlain && isHalo
            ? text.map((channel, index) => channel + (1 - text[3]!) * haloColor[index]!)
            : isHalo
              ? haloColor
              : text;
        blend(target, px, py, out[0]!, out[1]!, out[2]!, out[3]!);
      },
    );
  }
}

function tileFrame(frame: StyleLayerFrame, index: number) {
  const base = index * STYLE_TILE_FRAME_FLOATS;
  if (base + STYLE_TILE_FRAME_FLOATS > frame.tileFrames.length) return null;
  if (frame.tileFrames[base + 20] !== 1) return null;
  return {
    base,
    matrix: frame.tileFrames,
    surface: [16, 17, 18, 19].map((offset) => frame.tileFrames[base + offset]!) as [
      number, number, number, number,
    ],
  };
}

type LineVertexOutput = {
  culled: boolean;
  extent: number;
  normal: [number, number];
  plane: [number, number];
  position: number[];
  tex: [number, number];
  /** Pattern strips: (outset, fade width, px along). */
  line: [number, number, number];
};

const CULLED_POSITION = [2, 2, 2, 1];

/** The line strip vertex stage of `retained_polygons.wgsl` (kind 4) and `line_pattern.wgsl`. */
function lineVertex(
  data: Float32Array,
  offset: number,
  matrix: ArrayLike<number>,
  matrixBase: number,
  [width, height, ratio, size]: [number, number, number, number],
  pattern: boolean,
): LineVertexOutput {
  const ax = data[offset]!;
  const ay = data[offset + 1]!;
  const lineWidth = data[offset + 6]!;
  const clipA = transform(matrix, matrixBase, ax, ay);
  const culled =
    clipA[3]! <= 0 || lineWidth <= 0 || (pattern && data[offset + 15]! < 0.01);
  const output: LineVertexOutput = {
    culled,
    extent: 1e6,
    line: [0, 0, 0],
    normal: culled ? [0, 0] : [data[offset + 4]!, data[offset + 5]!],
    plane: [0, 0],
    position: pattern ? [-2, -2, -2, 1] : CULLED_POSITION,
    tex: [0, 0],
  };
  if (culled) return output;
  const cssOutset = lineWidth * 0.5 + 0.5 / ratio;
  const dist = [data[offset + 2]! * cssOutset, data[offset + 3]! * cssOutset];
  const plane: [number, number] = [ax + dist[0]! / size, ay + dist[1]! / size];
  const extruded = transform(matrix, matrixBase, plane[0], plane[1]);
  const cssPerClip = [(width * 0.5) / ratio, (height * 0.5) / ratio];
  const screenDistance = Math.hypot(
    ((extruded[0]! - clipA[0]!) / extruded[3]!) * cssPerClip[0]!,
    ((extruded[1]! - clipA[1]!) / extruded[3]!) * cssPerClip[1]!,
  );
  const gammaScale = screenDistance > 1e-6 ? Math.hypot(dist[0]!, dist[1]!) / screenDistance : 1;
  output.position = extruded;
  output.plane = plane;
  if (pattern) {
    output.line = [cssOutset, gammaScale / ratio, data[offset + 12]!];
  } else {
    output.extent = (cssOutset * ratio) / gammaScale;
    if (data[offset + 15]! > 0) {
      output.tex = [data[offset + 12]!, data[offset + 13]! - output.normal[1] * data[offset + 14]!];
    }
  }
  return output;
}

/** Line strips (`retained_polygons.wgsl` kind 4, or `line_pattern.wgsl`) over `count` vertices. */
function drawLines(
  { frame, scissor, target, textures }: DrawContext,
  frameIndex: number,
  first: number,
  count: number,
  pattern: boolean,
) {
  const uniform = tileFrame(frame, frameIndex);
  if (!uniform) return;
  const atlas = pattern ? textures.image : textures.dash;
  if (pattern && !atlas) return;
  const [fromScale, toScale, fade] = frame.crossfade;
  const data = frame.lines;
  for (let vertex = first; vertex + 2 < first + count; vertex += 3) {
    const base = vertex * LINE_FLOATS;
    if (base + 3 * LINE_FLOATS > data.length) break;
    const outputs = [0, 1, 2].map((index) =>
      lineVertex(data, base + index * LINE_FLOATS, uniform.matrix, uniform.base, uniform.surface, pattern),
    );
    // Flat attributes come from the triangle's first (provoking) vertex.
    const color = [8, 9, 10, 11].map((index) => data[base + index]!);
    const clip = [16, 17, 18, 19].map((index) => data[base + index]!);
    const dashed = !pattern && data[base + 15]! > 0;
    const dashEdge = dashed ? 1 / uniform.surface[2] / data[base + 15]! / data[base + 6]! : 0;
    const params = [data[base + 13]!, data[base + 14]!, data[base + 15]!, data[base + 6]!];
    const get = (pick: (output: LineVertexOutput) => number, l0: number, l1: number, l2: number) =>
      pick(outputs[0]!) * l0 + pick(outputs[1]!) * l1 + pick(outputs[2]!) * l2;
    rasterizeTriangle(
      target,
      scissor,
      outputs[0]!.position,
      outputs[1]!.position,
      outputs[2]!.position,
      (l0, l1, l2, px, py) => {
        const planeX = get((output) => output.plane[0], l0, l1, l2);
        const planeY = get((output) => output.plane[1], l0, l1, l2);
        // MapLibre clips every tile to its square (`stencilModeForClipping`).
        if (planeX < clip[0]! || planeY < clip[1]! || planeX >= clip[2]! || planeY >= clip[3]!) return;
        const normalX = get((output) => output.normal[0], l0, l1, l2);
        const normalY = get((output) => output.normal[1], l0, l1, l2);
        if (pattern) {
          const outset = get((output) => output.line[0], l0, l1, l2);
          const blur2 = get((output) => output.line[1], l0, l1, l2);
          const along = get((output) => output.line[2], l0, l1, l2);
          const displayWidth = Math.max(params[0]!, 1e-6);
          const displayHeight = Math.max(params[1]!, 1e-6);
          const lineWidth = Math.max(params[3]!, 1e-6);
          const distance = Math.hypot(normalX, normalY) * outset;
          const alpha = clamp01(Math.min(distance + blur2, outset - distance) / blur2);
          if (alpha <= 0) return;
          const x = (along * displayHeight) / (displayWidth * lineWidth);
          const xa = fract(x / fromScale!);
          const xb = fract(x / toScale!);
          const yy = 0.5 * normalY + 0.5;
          const [u0, v0, u1, v1] = color as [number, number, number, number];
          const a = [...sample(atlas!, u0 + (u1 - u0) * xa, v0 + (v1 - v0) * yy, true, false)];
          const b = sample(atlas!, u0 + (u1 - u0) * xb, v0 + (v1 - v0) * yy, true, false);
          const scale = alpha * params[2]!;
          const mix = (index: number) => (a[index]! * (1 - fade!) + b[index]! * fade!) * scale;
          blend(target, px, py, mix(0), mix(1), mix(2), mix(3));
          return;
        }
        const extent = get((output) => output.extent, l0, l1, l2);
        let coverage = clamp01((1 - Math.hypot(normalX, normalY)) * extent);
        if (dashed) {
          if (!atlas) return;
          const u = get((output) => output.tex[0], l0, l1, l2);
          const v = get((output) => output.tex[1], l0, l1, l2);
          const sdf = sample(atlas, u, v, true, true)[0];
          coverage *= smoothstep(0.5 - dashEdge, 0.5 + dashEdge, sdf);
        }
        if (coverage <= 0) return;
        const alpha = color[3]!;
        blend(
          target,
          px,
          py,
          color[0]! * alpha * coverage,
          color[1]! * alpha * coverage,
          color[2]! * alpha * coverage,
          alpha * coverage,
        );
      },
    );
  }
}

type FillVertexOutput = {
  /** Pattern pixel at the from and to scales (MapLibre's `v_pos_a`, `v_pos_b`). */
  pos: [number, number, number, number];
  position: number[];
  tile: [number, number];
  /** Outlines: the endpoint's window position (physical px). */
  window: [number, number];
};

function patternPositions(
  data: Float32Array,
  offset: number,
  fromScale: number,
  toScale: number,
): [number, number, number, number] {
  const width = Math.max(data[offset + 6]!, 1e-6);
  const height = Math.max(data[offset + 7]!, 1e-6);
  const pixelX = data[offset]!;
  const pixelY = data[offset + 1]!;
  return [
    pixelX / (fromScale * width),
    pixelY / (fromScale * height),
    pixelX / (toScale * width),
    pixelY / (toScale * height),
  ];
}

const patternA: [number, number, number, number] = [0, 0, 0, 0];
const patternB: [number, number, number, number] = [0, 0, 0, 0];
const neighbour: [number, number, number] = [0, 0, 0];

/**
 * `fill_pattern.wgsl` `vs_fill`/`fs_fill` (or `vs_outline`/`fs_outline`) over `count` vertices.
 * Paint attributes are flat: they come from each triangle's first vertex.
 */
function drawFills(
  { frame, scissor, target, textures }: DrawContext,
  frameIndex: number,
  first: number,
  count: number,
  outline: boolean,
) {
  const uniform = tileFrame(frame, frameIndex);
  if (!uniform) return;
  const [fromScale, toScale, fade] = frame.crossfade as unknown as [number, number, number];
  const data = outline ? frame.outlines : frame.fills;
  const stride = outline ? OUTLINE_FLOATS : FILL_FLOATS;
  // Where the shared fill attributes start in a vertex: pixel, uv corners, size, color, params.
  const paintOffset = outline ? 6 : 2;
  const [surfaceWidth, surfaceHeight] = uniform.surface;
  const fillVertex = (offset: number): FillVertexOutput => {
    const params = offset + paintOffset + 12;
    const patterned = (data[params + 1]! & FILL_PATTERN) !== 0;
    const culled = patterned && data[params]! < 0.01;
    const pos = patternPositions(data, offset + paintOffset, fromScale, toScale);
    if (!outline) {
      const x = data[offset]!;
      const y = data[offset + 1]!;
      return {
        pos,
        position: culled ? [-2, -2, -2, 1] : transform(uniform.matrix, uniform.base, x, y),
        tile: [x, y],
        window: [0, 0],
      };
    }
    const culledOutput: FillVertexOutput = {
      pos,
      position: [-2, -2, -2, 1],
      tile: [0, 0],
      window: [0, 0],
    };
    if (culled) return culledOutput;
    const a = [data[offset]!, data[offset + 1]!];
    const b = [data[offset + 2]!, data[offset + 3]!];
    const clipA = transform(uniform.matrix, uniform.base, a[0]!, a[1]!);
    const clipB = transform(uniform.matrix, uniform.base, b[0]!, b[1]!);
    if (clipA[3]! <= 0 || clipB[3]! <= 0) return culledOutput;
    const window = (clip: number[]) => [
      ((clip[0]! / clip[3]!) * 0.5 + 0.5) * surfaceWidth,
      ((clip[1]! / clip[3]!) * -0.5 + 0.5) * surfaceHeight,
    ];
    const windowA = window(clipA);
    const windowB = window(clipB);
    const dx = windowB[0]! - windowA[0]!;
    const dy = windowB[1]! - windowA[1]!;
    if (dx * dx + dy * dy <= 1e-12) return culledOutput;
    const minor = Math.abs(dx) >= Math.abs(dy) ? [0, 0.5] : [0.5, 0];
    const atB = data[offset + 4]! > 0.5;
    const side = data[offset + 5]!;
    const clip = atB ? clipB : clipA;
    const end = atB ? windowB : windowA;
    const cornerX = ((end[0]! + minor[0]! * side) / surfaceWidth) * 2 - 1;
    const cornerY = ((end[1]! + minor[1]! * side) / surfaceHeight) * -2 + 1;
    return {
      pos,
      position: [cornerX * clip[3]!, cornerY * clip[3]!, clip[2]!, clip[3]!],
      tile: (atB ? b : a) as [number, number],
      window: end as [number, number],
    };
  };
  for (let vertex = first; vertex + 2 < first + count; vertex += 3) {
    const base = vertex * stride;
    if (base + 3 * stride > data.length) break;
    const outputs = [0, 1, 2].map((index) => fillVertex(base + index * stride));
    const paint = base + paintOffset;
    const uv = [2, 3, 4, 5].map((index) => data[paint + index]!) as [number, number, number, number];
    const color = [8, 9, 10, 11].map((index) => data[paint + index]!);
    const opacity = data[paint + 12]!;
    const flags = data[paint + 13]!;
    const patterned = (flags & FILL_PATTERN) !== 0;
    const sdf = (flags & FILL_SDF) !== 0;
    const clipToTile = (flags & FILL_CLIP_TO_TILE) !== 0;
    if (patterned && !textures.image) continue;
    const solid = [color[0]! * color[3]!, color[1]! * color[3]!, color[2]! * color[3]!, color[3]!];
    const get = (pick: (output: FillVertexOutput) => number, l0: number, l1: number, l2: number) =>
      pick(outputs[0]!) * l0 + pick(outputs[1]!) * l1 + pick(outputs[2]!) * l2;
    const atlasAlpha = (l: [number, number, number], index: 0 | 2) => {
      const x = get((output) => output.pos[index], ...l);
      const y = get((output) => output.pos[index + 1]!, ...l);
      return sample(
        textures.image!,
        uv[0] + (uv[2] - uv[0]) * fract(x),
        uv[1] + (uv[3] - uv[1]) * fract(y),
        true,
        false,
      )[3];
    };
    rasterizeTriangle(
      target,
      scissor,
      outputs[0]!.position,
      outputs[1]!.position,
      outputs[2]!.position,
      (l0, l1, l2, px, py) => {
        if (clipToTile) {
          const tileX = get((output) => output.tile[0], l0, l1, l2);
          const tileY = get((output) => output.tile[1], l0, l1, l2);
          if (tileX < 0 || tileY < 0 || tileX >= 1 || tileY >= 1) return;
        }
        let scale = opacity;
        if (outline) {
          const windowX = get((output) => output.window[0], l0, l1, l2);
          const windowY = get((output) => output.window[1], l0, l1, l2);
          const alpha = 1 - smoothstep(0, 1, Math.hypot(windowX - (px + 0.5), windowY - (py + 0.5)));
          if (alpha <= 0) return;
          scale *= alpha;
        }
        if (!patterned) {
          blend(target, px, py, solid[0]! * scale, solid[1]! * scale, solid[2]! * scale, solid[3]! * scale);
          return;
        }
        const image = textures.image!;
        const posA = [get((o) => o.pos[0], l0, l1, l2), get((o) => o.pos[1], l0, l1, l2)];
        const posB = [get((o) => o.pos[2], l0, l1, l2), get((o) => o.pos[3], l0, l1, l2)];
        const a = sample(
          image,
          uv[0] + (uv[2] - uv[0]) * fract(posA[0]!),
          uv[1] + (uv[3] - uv[1]) * fract(posA[1]!),
          true,
          false,
          patternA,
        );
        const b = sample(
          image,
          uv[0] + (uv[2] - uv[0]) * fract(posB[0]!),
          uv[1] + (uv[3] - uv[1]) * fract(posB[1]!),
          true,
          false,
          patternB,
        );
        let out: number[];
        if (sdf) {
          // `fwidth` of each sample's alpha, from its neighbours one pixel right and down.
          const width = (index: 0 | 2, alpha: number) => {
            const right = atlasAlpha(derivatives.at(px + 1.5, py + 0.5, neighbour), index);
            const down = atlasAlpha(derivatives.at(px + 0.5, py + 1.5, neighbour), index);
            return Math.max((Math.abs(right - alpha) + Math.abs(down - alpha)) * 0.5, 1 / 255 / 16);
          };
          const alphaA = a[3];
          const alphaB = b[3];
          const edge = (256 - 64) / 256;
          const gammaA = width(0, alphaA);
          const gammaB = width(2, alphaB);
          const sdfA = smoothstep(edge - gammaA, edge + gammaA, alphaA);
          const sdfB = smoothstep(edge - gammaB, edge + gammaB, alphaB);
          const mix = sdfA * (1 - fade) + sdfB * fade;
          out = solid.map((channel) => channel * mix);
        } else {
          out = [0, 1, 2, 3].map((index) => a[index]! * (1 - fade) + b[index]! * fade);
        }
        blend(target, px, py, out[0]! * scale, out[1]! * scale, out[2]! * scale, out[3]! * scale);
      },
    );
  }
}

/**
 * Runs every draw of `frame` in painter order into `target` (premultiplied), inside
 * `scissor` (physical px; the whole target by default).
 */
export function rasterizeStyleLayers(
  target: StyleLayerTarget,
  frame: StyleLayerFrame,
  textures: StyleLayerTextures,
  scissor: StyleLayerScissor = { height: target.height, width: target.width, x: 0, y: 0 },
) {
  const context: DrawContext = { frame, scissor, target, textures };
  for (let index = 0; index + STYLE_DRAW_STRIDE <= frame.draws.length; index += STYLE_DRAW_STRIDE) {
    const kind = frame.draws[index]!;
    const tile = frame.draws[index + 1]!;
    const first = frame.draws[index + 2]!;
    const count = frame.draws[index + 3]!;
    const flag = frame.draws[index + 4]! !== 0;
    switch (kind) {
      case STYLE_DRAW_CIRCLES:
        drawCircles(context, first, count);
        break;
      case STYLE_DRAW_GLYPHS:
        drawGlyphs(context, first, count, textures.glyph, true);
        break;
      case STYLE_DRAW_ICONS:
        drawGlyphs(context, first, count, textures.image, flag);
        break;
      case STYLE_DRAW_LINES:
        drawLines(context, tile, first, count, flag);
        break;
      case STYLE_DRAW_FILLS:
        drawFills(context, tile, first, count, false);
        break;
      case STYLE_DRAW_FILL_OUTLINES:
        drawFills(context, tile, first, count, true);
        break;
      default:
        throw new Error(`unknown tileset style layer draw kind ${kind}`);
    }
  }
}

/**
 * Composites what `target` holds over `context` (source-over, at the target's physical
 * pixels) through `scratch`, a canvas of at least the target's size.
 */
export function compositeStyleLayers(
  context: CanvasRenderingContext2D,
  target: StyleLayerTarget,
  scratch: HTMLCanvasElement | OffscreenCanvas,
) {
  const [x0, y0, x1, y1] = target.dirty;
  if (x0 >= x1 || y0 >= y1) return;
  const width = x1 - x0;
  const height = y1 - y0;
  if (scratch.width < target.width || scratch.height < target.height) {
    scratch.width = target.width;
    scratch.height = target.height;
  }
  const scratchContext = scratch.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!scratchContext) return;
  const image = scratchContext.createImageData(width, height);
  const pixels = image.data;
  for (let y = 0; y < height; y += 1) {
    let source = ((y + y0) * target.width + x0) * 4;
    let destination = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const alpha = target.data[source + 3]!;
      if (alpha > 0) {
        // ImageData is straight alpha; the target is premultiplied.
        pixels[destination] = (target.data[source]! / alpha) * 255;
        pixels[destination + 1] = (target.data[source + 1]! / alpha) * 255;
        pixels[destination + 2] = (target.data[source + 2]! / alpha) * 255;
        pixels[destination + 3] = alpha * 255;
      }
      source += 4;
      destination += 4;
    }
  }
  scratchContext.putImageData(image, 0, 0);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.drawImage(scratch, 0, 0, width, height, x0, y0, width, height);
  context.restore();
}
