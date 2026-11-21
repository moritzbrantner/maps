import { describe, expect, it } from "vitest";

import {
  STYLE_DRAW_CIRCLES,
  STYLE_DRAW_FILLS,
  STYLE_DRAW_FILL_OUTLINES,
  STYLE_DRAW_GLYPHS,
  STYLE_DRAW_ICONS,
  STYLE_DRAW_LINES,
  createStyleLayerTarget,
  rasterizeStyleLayers,
  styleLayerViewportScissor,
  type StyleLayerFrame,
  type StyleLayerTexture,
} from "./canvas-style-layers";

const W = 40;
const H = 40;

function emptyFrame(): StyleLayerFrame {
  return {
    circles: new Float32Array(),
    crossfade: new Float32Array([1, 1, 1]),
    draws: new Uint32Array(),
    fills: new Float32Array(),
    glyphs: new Float32Array(),
    lines: new Float32Array(),
    outlines: new Float32Array(),
    tileFrames: new Float32Array(),
  };
}

/** A tile frame mapping tile-normalized (u, v) onto the whole W x H surface (+v south). */
function surfaceTileFrame(size = W) {
  // clip x = 2u - 1, clip y = 1 - 2v.
  const matrix = [2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1];
  return new Float32Array([...matrix, W, H, 1, size, 1]);
}

function pixel(target: ReturnType<typeof createStyleLayerTarget>, x: number, y: number) {
  const index = (y * target.width + x) * 4;
  return Array.from(target.data.subarray(index, index + 4), (value) => Math.round(value * 1000) / 1000 + 0);
}

/** Pixel centre (x + 0.5, y + 0.5) in clip space. */
const clipX = (x: number) => (x / W) * 2 - 1;
const clipY = (y: number) => 1 - (y / H) * 2;

describe("Canvas2D tileset style layers (#346)", () => {
  it("draws circle instances with MapLibre's circle smoothstep, as application_circle.wgsl", () => {
    const frame = emptyFrame();
    // Centre (20, 20), outer radius 8 px, fill radius 4 px (stroke 4 px), blur 1/8.
    frame.circles = new Float32Array([
      clipX(20), clipY(20), 16 / W, 16 / H, 0.5, 1 / 8,
      0, 1, 0, 1,
      1, 0, 0, 1,
    ]);
    frame.draws = new Uint32Array([STYLE_DRAW_CIRCLES, 0, 0, 1, 0]);
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, {});

    // The pixel at the centre is the fill; the ring at 6 px is the stroke.
    expect(pixel(target, 20, 20)).toEqual([0, 1, 0, 1]);
    expect(pixel(target, 26, 20)).toEqual([1, 0, 0, 1]);
    // Outside the outer radius nothing is drawn.
    expect(pixel(target, 29, 20)).toEqual([0, 0, 0, 0]);
    expect(pixel(target, 20 + 6, 20 + 6)).toEqual([0, 0, 0, 0]);
    // The outer edge fades over one pixel inside the radius: the centre (27.5, 20.5).
    const edge = (1 - Math.hypot(7.5, 0.5) / 8) / (1 / 8);
    const opacity = edge * edge * (3 - 2 * edge);
    expect(pixel(target, 27, 20)[0]).toBeCloseTo(opacity, 3);
  });

  it("scissors a viewport-only render to the viewport inside the margin, as the wgpu backend", () => {
    // 1x and 2x device pixels: the wgpu `SurfaceClip::scissor` cases.
    expect(styleLayerViewportScissor({ height: 768, width: 1024 }, 128, { height: 1024, width: 1280 }))
      .toEqual({ height: 768, width: 1024, x: 128, y: 128 });
    expect(styleLayerViewportScissor({ height: 768, width: 1024 }, 128, { height: 2048, width: 2560 }))
      .toEqual({ height: 1536, width: 2048, x: 256, y: 256 });

    // A circle across the margin edge keeps only its viewport pixels.
    const frame = emptyFrame();
    frame.circles = new Float32Array([
      clipX(10), clipY(20), 16 / W, 16 / H, 1, 1 / 8, 1, 0, 0, 1, 1, 0, 0, 1,
    ]);
    frame.draws = new Uint32Array([STYLE_DRAW_CIRCLES, 0, 0, 1, 0]);
    const target = createStyleLayerTarget(W, H);
    const scissor = styleLayerViewportScissor({ height: 30, width: 30 }, 5, { height: H, width: W });
    expect(scissor).toEqual({ height: 30, width: 30, x: 5, y: 5 });
    rasterizeStyleLayers(target, frame, {}, scissor);
    expect(pixel(target, 4, 20)).toEqual([0, 0, 0, 0]);
    expect(pixel(target, 10, 20)).toEqual([1, 0, 0, 1]);
    expect(target.dirty[0]).toBeGreaterThanOrEqual(5);
  });

  it("fills triangles once per pixel, clipped to their tile, as fill_pattern.wgsl", () => {
    const frame = emptyFrame();
    // A square over (u, v) in [0, 0.5]^2 as two triangles sharing a diagonal, at 50% opacity.
    const vertex = (u: number, v: number) => [u, v, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0.5, 4];
    frame.fills = new Float32Array([
      ...vertex(0, 0), ...vertex(0.5, 0), ...vertex(0, 0.5),
      ...vertex(0, 0.5), ...vertex(0.5, 0), ...vertex(0.5, 0.5),
      // A triangle reaching past its tile (u = 1.25) in a second tile frame that maps the
      // tile onto x in [0, 20], y in [20, 40]: `CLIP_TO_TILE` cuts it at u = 1.
      ...vertex(0.75, 0.25), ...vertex(1.25, 0.25), ...vertex(0.75, 0.75),
    ]);
    const quarter = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1];
    frame.tileFrames = new Float32Array([...surfaceTileFrame(), ...quarter, W, H, 1, 20, 1]);
    frame.draws = new Uint32Array([STYLE_DRAW_FILLS, 0, 0, 6, 0, STYLE_DRAW_FILLS, 1, 6, 3, 0]);
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, {});

    let covered = 0;
    for (let y = 0; y < 20; y += 1) {
      for (let x = 0; x < 20; x += 1) {
        // Every pixel of the square blends exactly once, the shared diagonal included.
        expect(pixel(target, x, y)).toEqual([0, 0, 0.5, 0.5]);
        covered += 1;
      }
    }
    expect(covered).toBe(400);
    expect(pixel(target, 20, 10)).toEqual([0, 0, 0, 0]);
    // Inside its tile the triangle draws; past u = 1 (x = 20) it is discarded.
    expect(pixel(target, 17, 26)).toEqual([0, 0, 0.5, 0.5]);
    expect(pixel(target, 21, 26)).toEqual([0, 0, 0, 0]);
  });

  it("strokes a line strip half its width either side with a one-pixel fade, as the line program", () => {
    const frame = emptyFrame();
    // A horizontal strip at v = 0.5 from u = 0.25 to 0.75, 4 CSS px wide, red.
    const vertex = (u: number, side: number) => [
      u, 0.5, 0, side, 0, side, 4, 4, 1, 0, 0, 1, 0, 0, 0, 0, -1e30, -1e30, 1e30, 1e30,
    ];
    frame.lines = new Float32Array([
      ...vertex(0.25, -1), ...vertex(0.75, -1), ...vertex(0.25, 1),
      ...vertex(0.25, 1), ...vertex(0.75, -1), ...vertex(0.75, 1),
    ]);
    frame.tileFrames = surfaceTileFrame();
    frame.draws = new Uint32Array([STYLE_DRAW_LINES, 0, 0, 6, 0]);
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, {});

    // The line's centre is y = 20; rows 18..21 lie within 2 px of it.
    for (const y of [18, 19, 20, 21]) expect(pixel(target, 20, y)).toEqual([1, 0, 0, 1]);
    // Rows 17 and 22 lie 2.5 px out: the outset ends there, so nothing remains.
    expect(pixel(target, 20, 17)).toEqual([0, 0, 0, 0]);
    expect(pixel(target, 20, 22)).toEqual([0, 0, 0, 0]);
  });

  it("dashes a line strip through the dash atlas", () => {
    const frame = emptyFrame();
    // Dash slot: atlas u along the line, v of the centre row, half row span, period 1.
    const vertex = (u: number, side: number, along: number) => [
      u, 0.5, 0, side, 0, side, 4, 4, 1, 0, 0, 1, along, 0.5, 0, 1, -1e30, -1e30, 1e30, 1e30,
    ];
    frame.lines = new Float32Array([
      ...vertex(0, -1, 0), ...vertex(1, -1, 1), ...vertex(0, 1, 0),
      ...vertex(0, 1, 0), ...vertex(1, -1, 1), ...vertex(1, 1, 1),
    ]);
    frame.tileFrames = surfaceTileFrame();
    frame.draws = new Uint32Array([STYLE_DRAW_LINES, 0, 0, 6, 0]);
    // The first half of each period is a dash (signed distance 1), the second a gap (0).
    const dash: StyleLayerTexture = {
      channels: 1,
      data: new Uint8Array([255, 255, 0, 0]),
      height: 1,
      width: 4,
    };
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, { dash });

    expect(pixel(target, 4, 20)).toEqual([1, 0, 0, 1]);
    expect(pixel(target, 26, 20)).toEqual([0, 0, 0, 0]);
  });

  it("thresholds SDF glyphs at MapLibre's edge and draws their halo, as symbol_sdf.wgsl", () => {
    const frame = emptyFrame();
    // One quad over x, y in [10, 30] sampling a 2 x 1 atlas: left texel inside the glyph
    // (255), right texel in the halo ring (150), at text-size 24 and pixel ratio 1.
    const vertex = (x: number, y: number, u: number) => [
      clipX(x), clipY(y), 1, 1, u, 0.5,
      24, 1, 3, 0,
      1, 1, 1, 0,
      0, 0, 0, 1,
      1, 1, 1, 1,
    ];
    frame.glyphs = new Float32Array([
      ...vertex(10, 10, 0.25), ...vertex(30, 10, 0.75), ...vertex(10, 30, 0.25),
      ...vertex(10, 30, 0.25), ...vertex(30, 10, 0.75), ...vertex(30, 30, 0.75),
    ]);
    frame.draws = new Uint32Array([STYLE_DRAW_GLYPHS, 0, 0, 6, 0]);
    const glyph: StyleLayerTexture = {
      channels: 1,
      data: new Uint8Array([255, 150]),
      height: 1,
      width: 2,
    };
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, { glyph });

    // u = 0.25 samples the inside texel only: opaque black text over the halo.
    expect(pixel(target, 10, 20)).toEqual([0, 0, 0, 1]);
    // u = 0.75 samples the halo texel only: 150 / 255 lies inside the halo ring (from
    // (6 - 3) / 8 = 0.375) and outside the glyph edge (0.75): white halo.
    expect(pixel(target, 29, 20)).toEqual([1, 1, 1, 1]);
    // Outside the quad nothing is drawn.
    expect(pixel(target, 5, 20)).toEqual([0, 0, 0, 0]);
  });

  it("draws plain icons from the premultiplied image atlas, nearest or linear", () => {
    const frame = emptyFrame();
    const vertex = (x: number, y: number, u: number, v: number) => [
      clipX(x), clipY(y), 1, 1, u, v,
      1, 0.5, 0, 0,
      1, 0, 1, 2,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ];
    frame.glyphs = new Float32Array([
      ...vertex(0, 0, 0, 0), ...vertex(40, 0, 1, 0), ...vertex(0, 40, 0, 1),
      ...vertex(0, 40, 0, 1), ...vertex(40, 0, 1, 0), ...vertex(40, 40, 1, 1),
    ]);
    frame.draws = new Uint32Array([STYLE_DRAW_ICONS, 0, 0, 6, 0]);
    // 2 x 1 premultiplied texels: opaque red, half-transparent blue.
    const image: StyleLayerTexture = {
      channels: 4,
      data: new Uint8Array([255, 0, 0, 255, 0, 0, 128, 128]),
      height: 1,
      width: 2,
    };
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, { image });
    // NEAREST: each half takes its texel, times icon-opacity 0.5.
    expect(pixel(target, 19, 5)).toEqual([0.5, 0, 0, 0.5]);
    expect(pixel(target, 20, 5)[2]).toBeCloseTo(0.251, 3);

    frame.draws = new Uint32Array([STYLE_DRAW_ICONS, 0, 0, 6, 1]);
    const linear = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(linear, frame, { image });
    // LINEAR: the texel centres (u = 0.25, 0.75) blend between them.
    expect(pixel(linear, 19, 5)[0]).toBeGreaterThan(0.25);
    expect(pixel(linear, 19, 5)[0]).toBeLessThan(0.5);
  });

  it("clips triangles that reach behind the camera instead of folding them over", () => {
    const frame = emptyFrame();
    // A fill whose far vertex has w < 0: only its part in front of the camera draws.
    const vertex = (u: number, v: number) => [u, v, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0];
    frame.fills = new Float32Array([...vertex(0, 0), ...vertex(1, 0), ...vertex(0.5, 1)]);
    // w = 1 - 1.5 v: the camera plane crosses v = 2/3.
    const matrix = [2, 0, 0, 0, 0, -2, 0, -1.5, 0, 0, 1, 0, -1, 1, 0, 1];
    frame.tileFrames = new Float32Array([...matrix, W, H, 1, W, 1]);
    frame.draws = new Uint32Array([STYLE_DRAW_FILLS, 0, 0, 3, 0]);
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, {});
    for (let index = 0; index < target.data.length; index += 1) {
      expect(Number.isFinite(target.data[index])).toBe(true);
    }
    // Near the top edge (v = 0, w = 1) the fill is drawn.
    expect(pixel(target, 20, 1)).toEqual([1, 0, 0, 1]);
  });

  it("draws fill outlines as MapLibre's one-pixel lines", () => {
    const frame = emptyFrame();
    // One outline segment from (u, v) (0.25, 0.5) to (0.75, 0.5), black.
    const corner = (end: number, side: number) => [
      0.25, 0.5, 0.75, 0.5, end, side, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0,
    ];
    frame.outlines = new Float32Array([
      ...corner(0, -1), ...corner(0, 1), ...corner(1, 1),
      ...corner(0, -1), ...corner(1, 1), ...corner(1, -1),
    ]);
    frame.tileFrames = surfaceTileFrame();
    frame.draws = new Uint32Array([STYLE_DRAW_FILL_OUTLINES, 0, 0, 6, 0]);
    const target = createStyleLayerTarget(W, H);
    rasterizeStyleLayers(target, frame, {});
    // The segment lies on the pixel edge y = 20: the quad covers row 19 (centre 19.5,
    // half a pixel off) at 1 - smoothstep(0, 1, 0.5) = 0.5.
    expect(pixel(target, 20, 19)).toEqual([0, 0, 0, 0.5]);
    expect(pixel(target, 20, 18)).toEqual([0, 0, 0, 0]);
  });
});
