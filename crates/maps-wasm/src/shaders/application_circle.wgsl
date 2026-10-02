struct CircleInput {
  @location(0) center_clip: vec2<f32>,
  @location(1) outer_clip: vec2<f32>,
  @location(2) fill_ratio: f32,
  @location(3) stroke_inner_ratio: f32,
  @location(4) fill_color: vec4<f32>,
  @location(5) stroke_color: vec4<f32>,
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
fn vs_main(@builtin(vertex_index) vertex_index: u32, input: CircleInput) -> VertexOutput {
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
  output.position = vec4<f32>(input.center_clip + local * input.outer_clip, 0.0, 1.0);
  output.local = local;
  output.fill_ratio = input.fill_ratio;
  output.stroke_inner_ratio = input.stroke_inner_ratio;
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
