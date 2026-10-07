// Retained application polygons (#196): fans, covers and stroke endpoints hold f32 offsets
// from an anchor near the camera; the shared retained frame uniform places that anchor for
// this camera. Strokes keep their CSS-px width by extruding in screen space here.
struct RetainedFrame {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px) and the CSS-to-physical pixel ratio.
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
  // Segments: (along a→b, side). Joins: the quad corner around `a`.
  @location(2) corner: vec2<f32>,
  @location(3) width: f32,
  // 0 = segment, 1 = round join.
  @location(4) kind: f32,
  @location(5) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  // Join discs: position inside the unit disc; zero elsewhere.
  @location(1) local: vec2<f32>,
};

fn culled() -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  output.color = vec4<f32>(0.0);
  output.local = vec2<f32>(0.0);
  return output;
}

@vertex
fn vs_fill(input: FillInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = frame.matrix * vec4<f32>(input.offset, 0.0, 1.0);
  output.color = input.color;
  output.local = vec2<f32>(0.0);
  return output;
}

@vertex
fn vs_stroke(input: StrokeInput) -> VertexOutput {
  let clip_a = frame.matrix * vec4<f32>(input.a, 0.0, 1.0);
  let clip_b = frame.matrix * vec4<f32>(input.b, 0.0, 1.0);
  if clip_a.w <= 0.0 || clip_b.w <= 0.0 || input.width <= 0.0 {
    return culled();
  }
  // Physical pixels per clip unit along each axis.
  let pixels = frame.surface.xy * 0.5;
  let a = clip_a.xy / clip_a.w * pixels;
  let b = clip_b.xy / clip_b.w * pixels;
  let half_width = input.width * 0.5 * frame.surface.z;

  var output: VertexOutput;
  output.color = input.color;
  output.local = vec2<f32>(0.0);
  var position: vec2<f32>;
  if input.kind > 0.5 {
    position = a + input.corner * half_width;
    output.local = input.corner;
  } else {
    let delta = b - a;
    let length = length(delta);
    if length <= 1.0e-6 {
      return culled();
    }
    let direction = delta / length;
    let normal = vec2<f32>(-direction.y, direction.x);
    position = mix(a, b, input.corner.x) + normal * input.corner.y * half_width;
  }
  output.position = vec4<f32>(position / pixels, 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if dot(input.local, input.local) > 1.0 {
    discard;
  }
  return vec4<f32>(input.color.rgb * input.color.a, input.color.a);
}
