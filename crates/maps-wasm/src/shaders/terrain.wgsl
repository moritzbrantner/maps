// MapLibre GL JS 6.15 `terrain.{vertex,fragment}.glsl` and the prelude's `get_elevation`
// (#324): a terrain tile mesh lifted by its DEM tile and textured with the tile's render
// target. Fog (`u_fog_ground_blend_opacity`) is zero below 60° pitch and not drawn.
//
// MapLibre renders terrain targets upside down (GL framebuffers start at the bottom row) and
// samples them at `1 - y`; WebGPU targets start at the top row, so this samples at `y`.

struct TerrainTile {
  matrix: mat4x4<f32>,
  // uv = position · x + (y, z): the DEM tile position of a tile-local position; w: DEM dim.
  dem: vec4<f32>,
  unpack: vec4<f32>,
  // exaggeration, skirt length (m), DEM present (1/0).
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> tile: TerrainTile;
@group(1) @binding(0) var dem: texture_2d<f32>;
@group(2) @binding(0) var surface: texture_2d<f32>;
@group(2) @binding(1) var surface_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// grab an elevation value from a raster-dem texture
fn ele(pos: vec2<i32>) -> f32 {
  let rgb = (textureLoad(dem, pos, 0) * 255.0) * tile.unpack;
  return rgb.r + rgb.g + rgb.b - tile.unpack.a;
}

// DEM pixel i is centred at (i + 0.5) / dim and sits at texel i + 2 behind the border.
fn get_elevation(pos: vec2<f32>) -> f32 {
  if (tile.params.z == 0.0) {
    return 0.0;
  }
  let coord = (pos * tile.dem.x + tile.dem.yz) * tile.dem.w + 1.5;
  let f = fract(coord);
  let c = vec2<i32>(floor(coord));
  let hi = vec2<i32>(textureDimensions(dem, 0)) - 1;
  let tl = ele(clamp(c, vec2<i32>(0), hi));
  let tr = ele(clamp(c + vec2<i32>(1, 0), vec2<i32>(0), hi));
  let bl = ele(clamp(c + vec2<i32>(0, 1), vec2<i32>(0), hi));
  let br = ele(clamp(c + vec2<i32>(1, 1), vec2<i32>(0), hi));
  let elevation = mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
  return elevation * tile.params.x;
}

@vertex
fn vs_main(@location(0) pos3d: vec3<f32>) -> VertexOutput {
  let elevation = get_elevation(pos3d.xy);
  let ele_delta = select(0.0, tile.params.y, pos3d.z == 1.0);
  var output: VertexOutput;
  output.uv = pos3d.xy / 8192.0;
  output.position = tile.matrix * vec4<f32>(pos3d.xy, elevation - ele_delta, 1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(surface, surface_sampler, input.uv);
}

// MapLibre's raster program drawing a raster tile into a terrain tile's target.
struct RasterTile {
  matrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> raster: RasterTile;
@group(1) @binding(0) var raster_texture: texture_2d<f32>;
@group(1) @binding(1) var raster_sampler: sampler;

@vertex
fn vs_raster(@builtin(vertex_index) index: u32) -> VertexOutput {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(8192.0, 0.0), vec2<f32>(0.0, 8192.0),
    vec2<f32>(8192.0, 0.0), vec2<f32>(8192.0, 8192.0), vec2<f32>(0.0, 8192.0),
  );
  let a_pos = corners[index];
  var output: VertexOutput;
  output.position = raster.matrix * vec4<f32>(a_pos, 0.0, 1.0);
  output.uv = a_pos / 8192.0;
  return output;
}

@fragment
fn fs_raster(input: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(raster_texture, raster_sampler, input.uv);
  return vec4<f32>(color.rgb * color.a, color.a);
}
