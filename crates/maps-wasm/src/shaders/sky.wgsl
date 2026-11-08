// MapLibre's `sky.fragment.glsl` without the globe: the band above the Mercator horizon line
// fades from the horizon color to the sky color. Colors are premultiplied and replace the
// surface, so a transparent sky shows the page behind the map as MapLibre's transparent clear
// does. Fragment coordinates run down from the top of the surface.
struct Sky {
  sky_color: vec4<f32>,
  horizon_color: vec4<f32>,
  // The horizon line and the blend height, in physical pixels of the surface.
  horizon_y: f32,
  blend: f32,
}

@group(0) @binding(0) var<uniform> sky: Sky;

@vertex
fn vs_sky(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(corners[index], 0.0, 1.0);
}

@fragment
fn fs_sky(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let above = sky.horizon_y - position.y;
  if (above <= 0.0) {
    discard;
  }
  if (above < sky.blend) {
    let fade = 1.0 - above / sky.blend;
    return mix(sky.sky_color, sky.horizon_color, fade * fade);
  }
  return sky.sky_color;
}
