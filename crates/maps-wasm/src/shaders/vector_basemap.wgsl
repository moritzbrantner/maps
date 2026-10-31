// The shared retained-geometry frame uniform (see `wgpu_retained`).
struct RetainedFrame {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px), the CSS-to-physical pixel ratio, and the tile's
  // size in CSS px at the camera zoom.
  surface: vec4<f32>,
};

struct VectorStyle {
  color: vec4<f32>,
  // x: line width in CSS px.
  params: vec4<f32>,
};

struct VectorStyles {
  entries: array<VectorStyle, 12>,
};

@group(0) @binding(0)
var<uniform> tile: RetainedFrame;

@group(1) @binding(0)
var<uniform> styles: VectorStyles;

struct FillInput {
  @location(0) position: vec2<f32>,
  @location(1) style_class: u32,
};

struct FillOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) color: vec4<f32>,
};

@vertex
fn vs_fill(input: FillInput) -> FillOutput {
  var output: FillOutput;
  output.position = tile.matrix * vec4<f32>(input.position, 0.0, 1.0);
  let color = styles.entries[input.style_class].color;
  output.color = vec4<f32>(color.rgb * color.a, color.a);
  return output;
}

@fragment
fn fs_fill(input: FillOutput) -> @location(0) vec4<f32> {
  return input.color;
}

struct LineInput {
  @location(0) position: vec2<f32>,
  // Style class in the low byte, then the round-cap (bit 8) and up (bit 9) flags.
  @location(1) style_class: u32,
  // Extrusion for a half width of one.
  @location(2) extrude: vec2<f32>,
};

struct LineOutput {
  @builtin(position) position: vec4<f32>,
  // MapLibre's `v_normal`, `v_width2.s` (outset, CSS px) and fade width `blur2` (CSS px).
  @location(0) normal: vec2<f32>,
  @location(1) outset: f32,
  @location(2) blur: f32,
  @location(3) @interpolate(flat) color: vec4<f32>,
  // Tile-normalized position: MapLibre clips every tile to its own square.
  @location(4) tile_position: vec2<f32>,
};

// MapLibre's line shader (#325): the strip from `maps_core::LineMesh` is extruded on the
// map plane by the line's outset in CSS px (half width plus half a physical pixel), so
// widths stay in CSS px at every zoom and shrink with distance under pitch.
@vertex
fn vs_line(input: LineInput) -> LineOutput {
  var output: LineOutput;
  let style = styles.entries[input.style_class & 0xffu];
  let pixel_ratio = tile.surface.z;
  let half_width = style.params.x * 0.5;
  let outset = half_width + select(0.5 / pixel_ratio, 0.0, half_width == 0.0);
  if style.color.a < 0.01 || outset == 0.0 || tile.surface.w <= 0.0 {
    output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return output;
  }
  let dist = input.extrude * outset;
  let tile_position = input.position + dist / tile.surface.w;
  let base = tile.matrix * vec4<f32>(input.position, 0.0, 1.0);
  let extruded = tile.matrix * vec4<f32>(tile_position, 0.0, 1.0);
  output.position = extruded;
  let css_per_clip = tile.surface.xy * 0.5 / pixel_ratio;
  let screen_dist = length((extruded.xy - base.xy) / extruded.w * css_per_clip);
  let gamma_scale = select(1.0, length(dist) / screen_dist, screen_dist > 1.0e-6);
  output.blur = gamma_scale / pixel_ratio;
  output.normal = vec2<f32>(
    f32((input.style_class >> 8u) & 1u),
    f32((input.style_class >> 9u) & 1u) * 2.0 - 1.0,
  );
  output.outset = outset;
  output.color = vec4<f32>(style.color.rgb * style.color.a, style.color.a);
  output.tile_position = tile_position;
  return output;
}

@fragment
fn fs_line(input: LineOutput) -> @location(0) vec4<f32> {
  if any(input.tile_position < vec2<f32>(0.0)) || any(input.tile_position >= vec2<f32>(1.0)) {
    discard;
  }
  let dist = length(input.normal) * input.outset;
  let alpha = clamp(min(dist + input.blur, input.outset - dist) / input.blur, 0.0, 1.0);
  return input.color * alpha;
}
