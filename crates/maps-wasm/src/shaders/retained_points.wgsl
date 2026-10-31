// Retained application points (#155): instances hold f32 offsets from an anchor near the
// camera; the shared retained frame uniform places that anchor for this camera. Radii and
// strokes stay in CSS px, like the screen-projected application circles.
struct RetainedFrame {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px), the CSS-to-physical pixel ratio, and the clip w of
  // the map center under a pitched camera (0 when unpitched).
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
  // Fill radius over outer radius, or 2 without a stroke (MapLibre `circle-stroke-width` < 0.01).
  @location(1) fill_ratio: f32,
  // One physical pixel over the outer radius: MapLibre's antialiasing blur.
  @location(2) blur: f32,
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
  // MapLibre circles: the stroke lies outside the radius.
  let outer = input.radius + input.stroke_width;
  if center.w <= 0.0 || outer <= 0.0 {
    output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    output.local = local;
    output.fill_ratio = 2.0;
    output.blur = 1.0;
    output.fill_color = vec4<f32>(0.0);
    output.stroke_color = vec4<f32>(0.0);
    return output;
  }
  // MapLibre `circle-pitch-scale: map` (#328): a pitched camera passes its center depth in
  // `surface.w` and circles scale with `center depth / w`; the antialiasing blur does not.
  let depth_scale = select(1.0, frame.surface.w / center.w, frame.surface.w > 0.0);
  let outer_clip = vec2<f32>(outer * depth_scale * frame.surface.z * 2.0) / frame.surface.xy;
  output.position = vec4<f32>(center.xy / center.w + local * outer_clip, 0.0, 1.0);
  output.local = local;
  output.fill_ratio = 2.0;
  if input.stroke_width >= 0.01 {
    output.fill_ratio = input.radius / outer;
  }
  output.blur = 1.0 / (frame.surface.z * outer);
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
