// Retained application shapes (#196, #195): fans, covers and stroke endpoints hold f32
// offsets from an anchor near the camera; the shared retained frame uniform places that
// anchor for this camera. Strokes keep their CSS-px width by extruding in screen space here,
// and direction markers keep their CSS-px size and projected heading.
//
// Antialiasing follows MapLibre GL (#309): strokes and joins extend half a physical pixel
// past their half width and fade linearly over one pixel (its line shader); circles fade
// with a one-pixel smoothstep inside their outer radius and between fill and stroke (its
// circle shader). Fills stay aliased, as MapLibre's fill triangles are.
struct RetainedFrame {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px), the CSS-to-physical pixel ratio, and CSS px per
  // anchor-offset (world) unit.
  surface: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> frame: RetainedFrame;

struct FillInput {
  @location(0) offset: vec2<f32>,
  @location(1) color: vec4<f32>,
};

struct StrokeInput {
  @location(0) a: vec2<f32>,
  @location(1) b: vec2<f32>,
  // Segments: (along a→b, side). Joins: the quad corner around `a`. Markers: the triangle
  // corner in marker sizes, +x along the heading from `b` (previous) to `a` (anchor).
  @location(2) corner: vec2<f32>,
  // Stroke width, a marker's size, or a circle's outer diameter (CSS px).
  @location(3) width: f32,
  // 0 = segment, 1 = round join, 2 = direction marker, 3 = circle part, whose `b` holds
  // (fill radius over outer radius or 2 without a stroke, 0 = fill part / 1 = stroke part),
  // 4 = line strip vertex at `a` with extrusion `b` and MapLibre's `v_normal` in `corner`.
  @location(4) kind: f32,
  @location(5) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  // Strokes, joins and circles: position over the outer extent; zero elsewhere.
  @location(1) local: vec2<f32>,
  // Strokes and joins: outer extent in physical px; large (no fade) elsewhere.
  @location(2) extent: f32,
  // Circle parts: (fill ratio, part, one pixel over the outer radius); zero elsewhere.
  @location(3) circle: vec3<f32>,
};

const NO_FADE: f32 = 1.0e6;

fn culled() -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  output.color = vec4<f32>(0.0);
  output.local = vec2<f32>(0.0);
  output.extent = NO_FADE;
  output.circle = vec3<f32>(0.0);
  return output;
}

@vertex
fn vs_fill(input: FillInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = frame.matrix * vec4<f32>(input.offset, 0.0, 1.0);
  output.color = input.color;
  output.local = vec2<f32>(0.0);
  output.extent = NO_FADE;
  output.circle = vec3<f32>(0.0);
  return output;
}

@vertex
fn vs_stroke(input: StrokeInput) -> VertexOutput {
  let clip_a = frame.matrix * vec4<f32>(input.a, 0.0, 1.0);
  let clip_b = frame.matrix * vec4<f32>(input.b, 0.0, 1.0);
  // Discs only place `a`; `b` is a second position for segments and markers.
  let uses_b = input.kind < 0.5 || (input.kind > 1.5 && input.kind < 2.5);
  if clip_a.w <= 0.0 || (uses_b && clip_b.w <= 0.0) || input.width <= 0.0 {
    return culled();
  }
  // Physical pixels per clip unit along each axis.
  let pixels = frame.surface.xy * 0.5;
  let a = clip_a.xy / clip_a.w * pixels;
  let b = clip_b.xy / clip_b.w * pixels;
  let half_width = input.width * 0.5 * frame.surface.z;
  // MapLibre's line outset: half a physical pixel of antialiasing past the half width.
  let outset = half_width + 0.5;

  var output: VertexOutput;
  output.color = input.color;
  output.local = vec2<f32>(0.0);
  output.extent = NO_FADE;
  output.circle = vec3<f32>(0.0);
  if input.kind > 3.5 {
    // A line strip vertex (`maps_core::LineMesh`, #326): MapLibre's line shader extrudes
    // `b` by the outset in CSS px on the map plane (`frame.surface.w` CSS px per offset
    // unit) and fades over one pixel scaled by `v_gamma_scale`.
    let css_outset = input.width * 0.5 + 0.5 / frame.surface.z;
    let dist = input.b * css_outset;
    let extruded = frame.matrix * vec4<f32>(input.a + dist / frame.surface.w, 0.0, 1.0);
    let css_per_clip = pixels / frame.surface.z;
    let screen_dist = length((extruded.xy - clip_a.xy) / extruded.w * css_per_clip);
    let gamma_scale = select(1.0, length(dist) / screen_dist, screen_dist > 1.0e-6);
    output.position = extruded;
    output.local = input.corner;
    output.extent = css_outset * frame.surface.z / gamma_scale;
    return output;
  }
  var position: vec2<f32>;
  if input.kind > 2.5 {
    position = a + input.corner * half_width;
    output.local = input.corner;
    output.circle = vec3<f32>(input.b.x, input.b.y, 1.0 / half_width);
  } else if input.kind > 1.5 {
    // Canvas rotates by atan2 of the projected heading; coincident points keep +x.
    let heading = a - b;
    let length = length(heading);
    var direction = vec2<f32>(1.0, 0.0);
    if length > 1.0e-6 {
      direction = heading / length;
    }
    // The triangle is symmetric across its heading, so either normal orientation matches.
    let normal = vec2<f32>(-direction.y, direction.x);
    let size = input.width * frame.surface.z;
    position = a + (direction * input.corner.x + normal * input.corner.y) * size;
  } else if input.kind > 0.5 {
    position = a + input.corner * outset;
    output.local = input.corner;
    output.extent = outset;
  } else {
    let delta = b - a;
    let length = length(delta);
    if length <= 1.0e-6 {
      return culled();
    }
    let direction = delta / length;
    let normal = vec2<f32>(-direction.y, direction.x);
    position = mix(a, b, input.corner.x) + normal * input.corner.y * outset;
    output.local = vec2<f32>(0.0, input.corner.y);
    output.extent = outset;
  }
  output.position = vec4<f32>(position / pixels, 0.0, 1.0);
  return output;
}

fn hermite(t: f32) -> f32 {
  let x = clamp(t, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = length(input.local);
  var coverage = clamp((1.0 - distance) * input.extent, 0.0, 1.0);
  let blur = input.circle.z;
  if blur > 0.0 {
    let opacity = hermite((1.0 - distance) / blur);
    if input.circle.y > 0.5 {
      // The stroke part blends over the fill part: MapLibre mixes them by this weight.
      coverage = opacity * hermite((distance - input.circle.x + blur) / blur);
    } else {
      // Under an opaque stroke the fill only shows where the stroke weight is below 1.
      coverage = select(0.0, opacity, distance < input.circle.x);
    }
  }
  // Uncovered fragments must not mark the single-coverage stroke stencil.
  if coverage <= 0.0 {
    discard;
  }
  return vec4<f32>(input.color.rgb * input.color.a, input.color.a) * coverage;
}
