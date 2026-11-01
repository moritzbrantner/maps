// MapLibre GL JS 6.15 `hillshade_prepare.{vertex,fragment}.glsl` (#324): the slope of every
// DEM pixel, from its 3 x 3 neighbourhood, into the red and green channels of a
// (dim + 2)-pixel texture. The draw covers the whole target, so the vertex stage is a
// full-screen triangle; the fragment stage reads `@builtin(position)` as GL reads
// `gl_FragCoord`, and both write row 0 of the target from DEM row 1.

struct Prepare {
  unpack: vec4<f32>,
  // dimension (DEM texture stride), zoom (the tile's overscaled zoom), log2 world width.
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> prepare: Prepare;
@group(1) @binding(0) var dem: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

fn get_elevation(texel: vec2<i32>) -> f32 {
  // Convert encoded elevation value to meters
  var data = textureLoad(dem, texel, 0) * 255.0;
  data.a = -1.0;
  return dot(data, prepare.unpack);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let pos = vec2<i32>(frag.xy) + vec2<i32>(1);
  let dimension = prepare.params.x;
  let zoom = prepare.params.y;
  let log2_world_width = prepare.params.z;
  let tile_size = dimension - 4.0;

  let a = get_elevation(pos + vec2<i32>(-1, -1));
  let b = get_elevation(pos + vec2<i32>(0, -1));
  let c = get_elevation(pos + vec2<i32>(1, -1));
  let d = get_elevation(pos + vec2<i32>(-1, 0));
  let f = get_elevation(pos + vec2<i32>(1, 0));
  let g = get_elevation(pos + vec2<i32>(-1, 1));
  let h = get_elevation(pos + vec2<i32>(0, 1));
  let i = get_elevation(pos + vec2<i32>(1, 1));

  // Slopes divided by 8 · meters per pixel, exaggerated below zoom 15 (see MapLibre).
  let exaggeration_factor = select(select(0.3, 0.35, zoom < 4.5), 0.4, zoom < 2.0);
  let exaggeration = select(0.0, (zoom - 15.0) * exaggeration_factor, zoom < 15.0);

  let deriv = vec2<f32>(
    (c + f + f + i) - (a + d + d + g),
    (g + h + h + i) - (a + b + b + c),
  ) * tile_size / pow(2.0, exaggeration + (3.0 + log2_world_width - zoom));

  // Flat ground is stored as 128/255, which 8 bits hold exactly.
  return clamp(
    vec4<f32>(deriv.x / 8.0 + 128.0 / 255.0, deriv.y / 8.0 + 128.0 / 255.0, 1.0, 1.0),
    vec4<f32>(0.0),
    vec4<f32>(1.0),
  );
}
