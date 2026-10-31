struct VertexInput {
  // Homogeneous clip position (x, y, w): w is 1 on the screen, the eye depth on the ground
  // plane of a pitched camera (#328), where interpolation is perspective-correct.
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
  // (MapLibre's `v_normal`: the offset from the stroke centre over its outer extent, then
  // the outer extent in physical px). Fills use (0, 0, NO_FADE). A stroke on the ground
  // plane carries -1 / extent instead, which varies over the stroke like `v_gamma_scale`.
  @location(2) edge: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) edge: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position.xy, 0.0, input.position.z);
  output.color = input.color;
  output.edge = input.edge;
  return output;
}

// MapLibre's line antialiasing (#309): strokes extend half a physical pixel past their half
// width and fade linearly over that pixel.
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let extent = select(input.edge.z, -1.0 / min(input.edge.z, -1.0e-6), input.edge.z < 0.0);
  let coverage = clamp((1.0 - length(input.edge.xy)) * extent, 0.0, 1.0);
  // Uncovered fragments must not mark the single-coverage stroke stencil.
  if coverage <= 0.0 {
    discard;
  }
  return vec4<f32>(input.color.rgb * input.color.a, input.color.a) * coverage;
}
