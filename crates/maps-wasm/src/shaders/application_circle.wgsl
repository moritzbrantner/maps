struct CircleInput {
  @location(0) center_clip: vec2<f32>,
  @location(1) outer_clip: vec2<f32>,
  // Fill radius over outer radius, or 2 without a stroke.
  @location(2) fill_ratio: f32,
  // One physical pixel over the outer radius: MapLibre's antialiasing blur.
  @location(3) blur: f32,
  @location(4) fill_color: vec4<f32>,
  @location(5) stroke_color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) fill_ratio: f32,
  @location(2) blur: f32,
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
  output.blur = input.blur;
  output.fill_color = input.fill_color;
  output.stroke_color = input.stroke_color;
  return output;
}

fn premultiplied(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(color.rgb * color.a, color.a);
}

fn hermite(t: f32) -> f32 {
  let x = clamp(t, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

// MapLibre's circle fragment: a one-pixel smoothstep at the outer edge and between fill
// and stroke, both inside their radii.
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = length(input.local);
  let opacity = hermite((1.0 - distance) / input.blur);
  let stroke = hermite((distance - input.fill_ratio + input.blur) / input.blur);
  let color = mix(premultiplied(input.fill_color), premultiplied(input.stroke_color), stroke);
  return color * opacity;
}
