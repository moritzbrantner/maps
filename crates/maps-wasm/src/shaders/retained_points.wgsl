// Retained application points (#155): instances hold f32 offsets from an anchor near the
// camera; the shared retained frame uniform places that anchor for this camera. Radii and
// strokes stay in CSS px, like the screen-projected application circles.
struct RetainedFrame {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px) and the CSS-to-physical pixel ratio.
  surface: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> frame: RetainedFrame;

struct PointInput {
  @location(0) offset: vec2<f32>,
  @location(1) radius: f32,
  @location(2) stroke_width: f32,
  @location(3) fill_color: vec4<f32>,
  @location(4) stroke_color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) fill_ratio: f32,
  @location(2) stroke_inner_ratio: f32,
  @location(3) fill_color: vec4<f32>,
  @location(4) stroke_color: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32, input: PointInput) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0),
  );
  let local = corners[vertex_index];
  var output: VertexOutput;
  let center = frame.matrix * vec4<f32>(input.offset, 0.0, 1.0);
  let outer = input.radius + input.stroke_width * 0.5;
  if center.w <= 0.0 || outer <= 0.0 {
    output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    output.local = local;
    output.fill_ratio = 0.0;
    output.stroke_inner_ratio = 2.0;
    output.fill_color = vec4<f32>(0.0);
    output.stroke_color = vec4<f32>(0.0);
    return output;
  }
  let outer_clip = vec2<f32>(outer * frame.surface.z * 2.0) / frame.surface.xy;
  output.position = vec4<f32>(center.xy / center.w + local * outer_clip, 0.0, 1.0);
  output.local = local;
  output.fill_ratio = input.radius / outer;
  output.stroke_inner_ratio = 2.0;
  if input.stroke_width > 0.0 {
    output.stroke_inner_ratio = max(input.radius - input.stroke_width * 0.5, 0.0) / outer;
  }
  output.fill_color = input.fill_color;
  output.stroke_color = input.stroke_color;
  return output;
}

fn premultiplied(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(color.rgb * color.a, color.a);
}

fn over(foreground: vec4<f32>, background: vec4<f32>) -> vec4<f32> {
  return foreground + background * (1.0 - foreground.a);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = length(input.local);
  if distance > 1.0 {
    discard;
  }

  let fill = premultiplied(input.fill_color);
  if distance < input.stroke_inner_ratio {
    return fill;
  }

  if input.stroke_inner_ratio <= 1.0 {
    let stroke = premultiplied(input.stroke_color);
    if input.fill_ratio > 0.0 && distance <= input.fill_ratio {
      return over(stroke, fill);
    }
    return stroke;
  }

  // Browsers (Tint) reject a function ending in `discard`: end with a return.
  if distance > input.fill_ratio {
    discard;
  }
  return fill;
}
