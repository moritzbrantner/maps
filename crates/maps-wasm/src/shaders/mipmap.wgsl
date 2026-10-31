// Raster tile mip chain (#314). Each level averages 2x2 texels of the level above and
// rounds half to even, which is what WebGL's `generateMipmap` produces (ANGLE): rounding
// halves up instead would brighten each level by an eighth of a step on average.
@group(0) @binding(0)
var source: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

// One triangle covering the target level.
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let uv = vec2<f32>(f32((vertex_index << 1u) & 2u), f32(vertex_index & 2u));
  var output: VertexOutput;
  output.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  return output;
}

fn texel(position: vec2<u32>) -> vec4<u32> {
  let last = textureDimensions(source) - vec2<u32>(1u);
  return vec4<u32>(round(textureLoad(source, min(position, last), 0) * 255.0));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let base = vec2<u32>(input.position.xy) * 2u;
  let sum = texel(base) + texel(base + vec2<u32>(1u, 0u)) + texel(base + vec2<u32>(0u, 1u))
    + texel(base + vec2<u32>(1u, 1u));
  let quotient = sum >> vec4<u32>(2u);
  let remainder = sum & vec4<u32>(3u);
  let round_up = (remainder > vec4<u32>(2u))
    | ((remainder == vec4<u32>(2u)) & ((quotient & vec4<u32>(1u)) == vec4<u32>(1u)));
  return vec4<f32>(quotient + select(vec4<u32>(0u), vec4<u32>(1u), round_up)) / 255.0;
}
