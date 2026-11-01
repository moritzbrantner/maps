// MapLibre 6.15 fill programs (#323): `fill`, `fill_pattern`, `fill_outline` and
// `fill_outline_pattern`, for tileset fill layers (tile-normalized positions in a tile frame)
// and the pattern covers of retained GeoJSON polygons (anchor offsets in a retained frame).
//
// A pattern vertex carries its position in pattern pixels at the camera's tile zoom (what
// `get_pattern_pos` builds from `u_pixel_coord_*`, `u_scale.x` and `a_pos`, less whole
// periods), the image's atlas corners and display size. Patterns of the two nearest integer
// zooms draw at `from_scale` and `to_scale` of their size, mixed by MapLibre's cross-fade.
struct Frame {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px), the CSS-to-physical pixel ratio, frame size.
  surface: vec4<f32>,
};

// (from scale, to scale, fade, 0).
struct Pattern {
  crossfade: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> frame: Frame;

@group(1) @binding(0)
var image_atlas: texture_2d<f32>;
@group(1) @binding(1)
var image_sampler: sampler;
@group(1) @binding(2)
var<uniform> pattern: Pattern;

const PATTERN: u32 = 1u;
const SDF: u32 = 2u;
const CLIP_TO_TILE: u32 = 4u;

struct FillInput {
  @location(0) position: vec2<f32>,
  @location(1) pixel: vec2<f32>,
  @location(2) uv_tl: vec2<f32>,
  @location(3) uv_br: vec2<f32>,
  @location(4) display_size: vec2<f32>,
  // Straight-alpha fill color (outline color on outline vertices).
  @location(5) color: vec4<f32>,
  // (opacity, flags).
  @location(6) params: vec2<f32>,
};

struct OutlineInput {
  // The segment's endpoints.
  @location(0) a: vec2<f32>,
  @location(1) b: vec2<f32>,
  // (end: 0 at `a`, 1 at `b`; side: -1 or 1 along the minor axis).
  @location(2) corner: vec2<f32>,
  @location(3) pixel: vec2<f32>,
  @location(4) uv_tl: vec2<f32>,
  @location(5) uv_br: vec2<f32>,
  @location(6) display_size: vec2<f32>,
  @location(7) color: vec4<f32>,
  @location(8) params: vec2<f32>,
};

struct FillOutput {
  @builtin(position) position: vec4<f32>,
  // MapLibre's `v_pos_a` and `v_pos_b`.
  @location(0) pos_a: vec2<f32>,
  @location(1) pos_b: vec2<f32>,
  @location(2) @interpolate(flat) uv: vec4<f32>,
  @location(3) @interpolate(flat) color: vec4<f32>,
  @location(4) @interpolate(flat) params: vec2<f32>,
  // Tile-normalized position: tile fills are clipped to their tile square.
  @location(5) tile_position: vec2<f32>,
  // Outlines: MapLibre's `v_pos`, the endpoint's window position (physical px).
  @location(6) window: vec2<f32>,
};

fn culled() -> FillOutput {
  var output: FillOutput;
  output.position = vec4<f32>(-2.0, -2.0, -2.0, 1.0);
  return output;
}

fn pattern_positions(output: ptr<function, FillOutput>, pixel: vec2<f32>, display_size: vec2<f32>) {
  let size = max(display_size, vec2<f32>(1.0e-6));
  (*output).pos_a = pixel / (pattern.crossfade.x * size);
  (*output).pos_b = pixel / (pattern.crossfade.y * size);
}

@vertex
fn vs_fill(input: FillInput) -> FillOutput {
  let flags = u32(input.params.y);
  // fill_pattern.vertex: a negligible opacity moves the vertex out of clip space.
  if (flags & PATTERN) != 0u && input.params.x < 0.01 {
    return culled();
  }
  var output: FillOutput;
  output.position = frame.matrix * vec4<f32>(input.position, 0.0, 1.0);
  pattern_positions(&output, input.pixel, input.display_size);
  output.uv = vec4<f32>(input.uv_tl, input.uv_br);
  output.color = input.color;
  output.params = input.params;
  output.tile_position = input.position;
  output.window = vec2<f32>(0.0);
  return output;
}

// MapLibre's `gl.LINES` outline as a quad half a physical pixel to either side along its
// minor axis, with `v_pos` the endpoints' window positions interpolated along it (#331).
@vertex
fn vs_outline(input: OutlineInput) -> FillOutput {
  let flags = u32(input.params.y);
  if (flags & PATTERN) != 0u && input.params.x < 0.01 {
    return culled();
  }
  let clip_a = frame.matrix * vec4<f32>(input.a, 0.0, 1.0);
  let clip_b = frame.matrix * vec4<f32>(input.b, 0.0, 1.0);
  if clip_a.w <= 0.0 || clip_b.w <= 0.0 {
    return culled();
  }
  let size = frame.surface.xy;
  let window_a = (clip_a.xy / clip_a.w * vec2<f32>(0.5, -0.5) + 0.5) * size;
  let window_b = (clip_b.xy / clip_b.w * vec2<f32>(0.5, -0.5) + 0.5) * size;
  let delta = window_b - window_a;
  if dot(delta, delta) <= 1.0e-12 {
    return culled();
  }
  let minor = select(vec2<f32>(0.5, 0.0), vec2<f32>(0.0, 0.5), abs(delta.x) >= abs(delta.y));
  let at_b = input.corner.x > 0.5;
  let clip = select(clip_a, clip_b, at_b);
  let window = select(window_a, window_b, at_b);
  let corner = (window + minor * input.corner.y) / size * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0);
  var output: FillOutput;
  output.position = vec4<f32>(corner * clip.w, clip.z, clip.w);
  pattern_positions(&output, input.pixel, input.display_size);
  output.uv = vec4<f32>(input.uv_tl, input.uv_br);
  output.color = input.color;
  output.params = input.params;
  output.tile_position = select(input.a, input.b, at_b);
  output.window = window;
  return output;
}

// The fill's premultiplied color before `fill-opacity`: the solid color, or the cross-faded
// pattern (an SDF pattern tinted by the fill color).
fn paint(input: FillOutput) -> vec4<f32> {
  let flags = u32(input.params.y);
  let pos_a = mix(input.uv.xy, input.uv.zw, fract(input.pos_a));
  let pos_b = mix(input.uv.xy, input.uv.zw, fract(input.pos_b));
  let color1 = textureSampleLevel(image_atlas, image_sampler, pos_a, 0.0);
  let color2 = textureSampleLevel(image_atlas, image_sampler, pos_b, 0.0);
  let solid = vec4<f32>(input.color.rgb * input.color.a, input.color.a);
  let sdf_edge = (256.0 - 64.0) / 256.0;
  let gamma_a = max(fwidth(color1.a) * 0.5, 1.0 / 255.0 / 16.0);
  let gamma_b = max(fwidth(color2.a) * 0.5, 1.0 / 255.0 / 16.0);
  let sdf_a = smoothstep(sdf_edge - gamma_a, sdf_edge + gamma_a, color1.a);
  let sdf_b = smoothstep(sdf_edge - gamma_b, sdf_edge + gamma_b, color2.a);
  let fade = pattern.crossfade.z;
  let sampled = select(
    mix(color1, color2, fade),
    mix(solid * sdf_a, solid * sdf_b, fade),
    (flags & SDF) != 0u,
  );
  return select(solid, sampled, (flags & PATTERN) != 0u);
}

fn outside_tile(input: FillOutput) -> bool {
  let flags = u32(input.params.y);
  return (flags & CLIP_TO_TILE) != 0u
    && (any(input.tile_position < vec2<f32>(0.0)) || any(input.tile_position >= vec2<f32>(1.0)));
}

@fragment
fn fs_fill(input: FillOutput) -> @location(0) vec4<f32> {
  let color = paint(input) * input.params.x;
  if outside_tile(input) {
    discard;
  }
  return color;
}

@fragment
fn fs_outline(input: FillOutput) -> @location(0) vec4<f32> {
  let color = paint(input);
  let alpha = 1.0 - smoothstep(0.0, 1.0, length(input.window - input.position.xy));
  if outside_tile(input) || alpha <= 0.0 {
    discard;
  }
  return color * (alpha * input.params.x);
}
