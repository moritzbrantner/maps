struct BaseCamera {
  view_projection: mat4x4<f32>,
};

@group(0) @binding(0)
var<uniform> camera: BaseCamera;

@group(1) @binding(0)
var raster_tile: texture_2d<f32>;

@group(1) @binding(1)
var raster_sampler: sampler;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) opacity: f32,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) opacity: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = camera.view_projection * vec4<f32>(input.position, 0.0, 1.0);
  output.uv = input.uv;
  output.opacity = input.opacity;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return tile_color(textureSample(raster_tile, raster_sampler, input.uv), input.opacity);
}

fn tile_color(sampled: vec4<f32>, opacity: f32) -> vec4<f32> {
  let alpha = sampled.a * opacity;
  return vec4<f32>(sampled.rgb * alpha, alpha);
}

const MAX_ANISOTROPY: f32 = 16.0;

// MapLibre samples raster tiles of a camera pitched past 20 degrees `LINEAR_MIPMAP_NEAREST`
// with maximum anisotropy (#314). WebGPU samplers offer anisotropy only with linear mip
// filtering, so this averages bilinear samples of the nearest level along the footprint's
// major axis, the way anisotropic texture units (SwiftShader's among them) do: the sample
// count is the major over the minor axis (at most 16), and the level is chosen for the
// major axis divided by that ratio.
@fragment
fn fs_anisotropic(input: VertexOutput) -> @location(0) vec4<f32> {
  let size = vec2<f32>(textureDimensions(raster_tile, 0));
  let levels = f32(textureNumLevels(raster_tile));
  let du = dpdxCoarse(input.uv);
  let dv = dpdyCoarse(input.uv);
  let du_texels = du * size;
  let dv_texels = dv * size;
  let du_length = dot(du_texels, du_texels);
  let dv_length = dot(dv_texels, dv_texels);
  let major = max(du_length, dv_length);
  let area = abs(du_texels.x * dv_texels.y - du_texels.y * dv_texels.x);
  let anisotropy = clamp(major / max(area, 1.0e-12), 1.0, MAX_ANISOTROPY);
  let lod = 0.5 * log2(max(major / (anisotropy * anisotropy), 1.0e-12));
  let level = clamp(round(lod), 0.0, levels - 1.0);
  let axis = select(dv, du, du_length >= dv_length);
  let count = i32(round(anisotropy));
  let step = 1.0 / f32(count);
  var sum = vec4<f32>(0.0);
  for (var index = 0; index < count; index++) {
    let offset = -0.5 + (f32(index) + 0.5) * step;
    sum += textureSampleLevel(raster_tile, raster_sampler, input.uv + axis * offset, level);
  }
  return tile_color(sum * step, input.opacity);
}
