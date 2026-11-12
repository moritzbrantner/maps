@group(0) @binding(0) var raster: texture_2d<f32>;
@group(0) @binding(1) var raster_sampler: sampler;
struct Vertex {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) opacity: f32,
};
@vertex fn vs_main(@location(0) position: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) opacity: f32) -> Vertex {
  return Vertex(vec4<f32>(position, 0.0, 1.0), uv, opacity);
}
@fragment fn fs_main(vertex: Vertex) -> @location(0) vec4<f32> {
  let sampled = textureSample(raster, raster_sampler, vertex.uv);
  let alpha = sampled.a * vertex.opacity;
  return vec4<f32>(sampled.rgb * alpha, alpha);
}
