// MapLibre GL JS 6.15 `hillshade.{vertex,fragment}.glsl` (#324): shades a tile from the
// slopes `hillshade_prepare.wgsl` stored, by one of MapLibre's five methods.

const MAX_LIGHTS: u32 = 8u;
const PI: f32 = 3.141592653589793;

const STANDARD: i32 = 0;
const COMBINED: i32 = 1;
const IGOR: i32 = 2;
const MULTIDIRECTIONAL: i32 = 3;
const BASIC: i32 = 4;

struct Hillshade {
  matrix: mat4x4<f32>,
  // latrange (north, south), exaggeration, method.
  params: vec4<f32>,
  accent: vec4<f32>,
  // light count.
  counts: vec4<f32>,
  // altitude, azimuth (radians) per light.
  lights: array<vec4<f32>, MAX_LIGHTS>,
  shadows: array<vec4<f32>, MAX_LIGHTS>,
  highlights: array<vec4<f32>, MAX_LIGHTS>,
};

@group(0) @binding(0) var<uniform> u: Hillshade;
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var image_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) pos: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  // The tile quad, 0..EXTENT on both axes, as two triangles.
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(8192.0, 0.0), vec2<f32>(0.0, 8192.0),
    vec2<f32>(8192.0, 0.0), vec2<f32>(8192.0, 8192.0), vec2<f32>(0.0, 8192.0),
  );
  let a_pos = corners[index];
  var output: VertexOutput;
  output.position = u.matrix * vec4<f32>(a_pos, 0.0, 1.0);
  output.pos = a_pos / 8192.0;
  return output;
}

// GLSL `mod`: x - y·floor(x / y).
fn glsl_mod(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

fn get_aspect(deriv: vec2<f32>) -> f32 {
  if (deriv.x != 0.0) {
    return atan2(deriv.y, -deriv.x);
  }
  return PI / 2.0 * select(-1.0, 1.0, deriv.y > 0.0);
}

fn igor_hillshade(deriv_in: vec2<f32>) -> vec4<f32> {
  let deriv = deriv_in * u.params.z * 2.0;
  let aspect = get_aspect(deriv);
  let azimuth = u.lights[0].y + PI;
  let slope_strength = atan(length(deriv)) * 2.0 / PI;
  let aspect_strength = 1.0 - abs(glsl_mod((aspect + azimuth) / PI + 0.5, 2.0) - 1.0);
  let shadow_strength = slope_strength * aspect_strength;
  let highlight_strength = slope_strength * (1.0 - aspect_strength);
  return u.shadows[0] * shadow_strength + u.highlights[0] * highlight_strength;
}

// MapLibre's legacy hillshade algorithm.
fn standard_hillshade(deriv: vec2<f32>) -> vec4<f32> {
  let azimuth = u.lights[0].y + PI;
  let slope = atan(0.625 * length(deriv));
  let aspect = get_aspect(deriv);
  let intensity = u.params.z;
  let base = 1.875 - intensity * 1.75;
  let max_value = 0.5 * PI;
  var scaled_slope = slope;
  if (intensity != 0.5) {
    scaled_slope = ((pow(base, slope) - 1.0) / (pow(base, max_value) - 1.0)) * max_value;
  }
  let accent = cos(scaled_slope);
  let accent_color = (1.0 - accent) * u.accent * clamp(intensity * 2.0, 0.0, 1.0);
  let shade = abs(glsl_mod((aspect + azimuth) / PI + 0.5, 2.0) - 1.0);
  let shade_color = mix(u.shadows[0], u.highlights[0], shade) * sin(scaled_slope)
    * clamp(intensity * 2.0, 0.0, 1.0);
  return accent_color * (1.0 - shade_color.a) + shade_color;
}

fn basic_hillshade(deriv_in: vec2<f32>) -> vec4<f32> {
  let deriv = deriv_in * u.params.z * 2.0;
  let azimuth = u.lights[0].y + PI;
  let cos_az = cos(azimuth);
  let sin_az = sin(azimuth);
  let cos_alt = cos(u.lights[0].x);
  let sin_alt = sin(u.lights[0].x);
  let cang = (sin_alt - (deriv.y * cos_az * cos_alt - deriv.x * sin_az * cos_alt))
    / sqrt(1.0 + dot(deriv, deriv));
  let shade = clamp(cang, 0.0, 1.0);
  if (shade > 0.5) {
    return u.highlights[0] * (2.0 * shade - 1.0);
  }
  return u.shadows[0] * (1.0 - 2.0 * shade);
}

fn multidirectional_hillshade(deriv_in: vec2<f32>) -> vec4<f32> {
  let deriv = deriv_in * u.params.z * 2.0;
  let count = u32(u.counts.x);
  var color = vec4<f32>(0.0);
  for (var i = 0u; i < count; i++) {
    let cos_alt = cos(u.lights[i].x);
    let sin_alt = sin(u.lights[i].x);
    let cos_az = -cos(u.lights[i].y);
    let sin_az = -sin(u.lights[i].y);
    let cang = (sin_alt - (deriv.y * cos_az * cos_alt - deriv.x * sin_az * cos_alt))
      / sqrt(1.0 + dot(deriv, deriv));
    let shade = clamp(cang, 0.0, 1.0);
    if (shade > 0.5) {
      color += u.highlights[i] * (2.0 * shade - 1.0) / f32(count);
    } else {
      color += u.shadows[i] * (1.0 - 2.0 * shade) / f32(count);
    }
  }
  return color;
}

fn combined_hillshade(deriv_in: vec2<f32>) -> vec4<f32> {
  let deriv = deriv_in * u.params.z * 2.0;
  let azimuth = u.lights[0].y + PI;
  let cos_az = cos(azimuth);
  let sin_az = sin(azimuth);
  let cos_alt = cos(u.lights[0].x);
  let sin_alt = sin(u.lights[0].x);
  var cang = acos((sin_alt - (deriv.y * cos_az * cos_alt - deriv.x * sin_az * cos_alt))
    / sqrt(1.0 + dot(deriv, deriv)));
  cang = clamp(cang, 0.0, PI / 2.0);
  let shade = cang * atan(length(deriv)) * 4.0 / PI / PI;
  let highlight = (PI / 2.0 - cang) * atan(length(deriv)) * 4.0 / PI / PI;
  return u.shadows[0] * shade + u.highlights[0] * highlight;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let size = vec2<f32>(textureDimensions(image, 0));
  let texture_pos = (input.pos * (size - 2.0) + 1.0) / size;
  let pixel = textureSample(image, image_sampler, texture_pos);

  // Slopes are divided by cos(latitude) of the pixel against Mercator distortion.
  let latrange = u.params.xy;
  let scale_factor = cos(radians((latrange.x - latrange.y) * (1.0 - input.pos.y) + latrange.y));
  let deriv = (pixel.rg - 128.0 / 255.0) * 8.0 / scale_factor;

  let method = i32(u.params.w);
  if (method == BASIC) {
    return basic_hillshade(deriv);
  } else if (method == COMBINED) {
    return combined_hillshade(deriv);
  } else if (method == IGOR) {
    return igor_hillshade(deriv);
  } else if (method == MULTIDIRECTIONAL) {
    return multidirectional_hillshade(deriv);
  }
  return standard_hillshade(deriv);
}
