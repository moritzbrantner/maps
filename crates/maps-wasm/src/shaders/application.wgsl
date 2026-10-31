struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
  // (distance from the stroke centre over its outer extent, outer extent in physical px).
  // Fills use (0, NO_FADE).
  @location(2) edge: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) edge: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position, 0.0, 1.0);
  output.color = input.color;
  output.edge = input.edge;
  return output;
}

// MapLibre's line antialiasing (#309): strokes extend half a physical pixel past their half
// width and fade linearly over that pixel.
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let coverage = clamp((1.0 - abs(input.edge.x)) * input.edge.y, 0.0, 1.0);
  // Uncovered fragments must not mark the single-coverage stroke stencil.
  if coverage <= 0.0 {
    discard;
  }
  return vec4<f32>(input.color.rgb * input.color.a, input.color.a) * coverage;
}
