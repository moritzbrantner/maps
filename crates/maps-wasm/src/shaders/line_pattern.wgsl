// MapLibre 6.15 `line_pattern` program (#349), for `line-pattern` strips of tileset line layers
// (tile-normalized positions in a tile frame) and of retained GeoJSON lines (anchor offsets in
// a retained frame). The strip is `maps_core::LineMesh`'s, extruded on the map plane as the
// retained line shader does; its vertices reuse the stroke vertex layout with the image's
// atlas corners in the color slot and (px along the line at the camera's tile zoom, display
// width, display height, `line-opacity`) in the dash slot.
//
// The image spans the line's width, scaled so its height is `line-width`, and repeats along
// the line every `display width * scale * line-width / display height` px of the tile zoom,
// sampled at the cross-fade's `from_scale` and `to_scale` and mixed by its `fade`.
struct Frame {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px), the CSS-to-physical pixel ratio, CSS px per unit.
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

struct LineInput {
  @location(0) position: vec2<f32>,
  // The extrusion (MapLibre's `a_extrude * scale`) and `v_normal`.
  @location(1) extrude: vec2<f32>,
  @location(2) normal: vec2<f32>,
  @location(3) width: f32,
  // Atlas-normalized corners (`maps_core::symbol::LinePattern`).
  @location(5) corners: vec4<f32>,
  // (px along the line at the tile zoom, display width, display height, opacity).
  @location(6) params: vec4<f32>,
  // The tile square the strip is clipped to.
  @location(7) clip: vec4<f32>,
};

struct LineOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec2<f32>,
  // (outset in CSS px, the fade width `(blur + 1 / pixel ratio) * v_gamma_scale` in CSS px,
  // `v_linesofar` in px at the tile zoom).
  @location(1) line: vec3<f32>,
  @location(2) @interpolate(flat) corners: vec4<f32>,
  // (display width, display height, opacity, `line-width`).
  @location(3) @interpolate(flat) params: vec4<f32>,
  @location(4) plane: vec2<f32>,
  @location(5) @interpolate(flat) clip: vec4<f32>,
};

fn culled() -> LineOutput {
  var output: LineOutput;
  output.position = vec4<f32>(-2.0, -2.0, -2.0, 1.0);
  return output;
}

@vertex
fn vs_line(input: LineInput) -> LineOutput {
  let opacity = input.params.w;
  // line_pattern.vertex: a negligible opacity moves the vertex out of clip space.
  let clip_a = frame.matrix * vec4<f32>(input.position, 0.0, 1.0);
  if opacity < 0.01 || clip_a.w <= 0.0 || input.width <= 0.0 {
    return culled();
  }
  // Half a physical pixel of antialiasing past the half width, extruded on the map plane
  // (`frame.surface.w` CSS px per unit), faded over one pixel scaled by `v_gamma_scale`.
  let css_outset = input.width * 0.5 + 0.5 / frame.surface.z;
  let dist = input.extrude * css_outset;
  let plane = input.position + dist / frame.surface.w;
  let extruded = frame.matrix * vec4<f32>(plane, 0.0, 1.0);
  let css_per_clip = frame.surface.xy * 0.5 / frame.surface.z;
  let screen_dist = length((extruded.xy - clip_a.xy) / extruded.w * css_per_clip);
  let gamma_scale = select(1.0, length(dist) / screen_dist, screen_dist > 1.0e-6);

  var output: LineOutput;
  output.position = extruded;
  output.normal = input.normal;
  output.line = vec3<f32>(css_outset, gamma_scale / frame.surface.z, input.params.x);
  output.corners = input.corners;
  output.params = vec4<f32>(input.params.yz, opacity, input.width);
  output.plane = plane;
  output.clip = input.clip;
  return output;
}

@fragment
fn fs_line(input: LineOutput) -> @location(0) vec4<f32> {
  let outset = input.line.x;
  let display_size = max(input.params.xy, vec2<f32>(1.0e-6));
  let width = max(input.params.w, 1.0e-6);
  // The distance of the pixel from the line and its antialiasing fade (no gap, no blur).
  let dist = length(input.normal) * outset;
  let blur2 = input.line.y;
  let alpha = clamp(min(dist + blur2, outset - dist) / blur2, 0.0, 1.0);
  // `x = mod(v_linesofar / pattern_size.x * aspect, 1)` with `pattern_size.x` the display
  // width at the cross-fade scale (over `u_scale.x`, folded into the px) and `aspect` the
  // display height over the width.
  let along = input.line.z * display_size.y / (display_size.x * width);
  let x_a = fract(along / pattern.crossfade.x);
  let x_b = fract(along / pattern.crossfade.y);
  let y = 0.5 * input.normal.y + 0.5;
  let pos_a = mix(input.corners.xy, input.corners.zw, vec2<f32>(x_a, y));
  let pos_b = mix(input.corners.xy, input.corners.zw, vec2<f32>(x_b, y));
  let color = mix(
    textureSampleLevel(image_atlas, image_sampler, pos_a, 0.0),
    textureSampleLevel(image_atlas, image_sampler, pos_b, 0.0),
    pattern.crossfade.z,
  );
  // MapLibre clips every tile to its square (`stencilModeForClipping`).
  if any(input.plane < input.clip.xy) || any(input.plane >= input.clip.zw) || alpha <= 0.0 {
    discard;
  }
  return color * (alpha * input.params.z);
}
