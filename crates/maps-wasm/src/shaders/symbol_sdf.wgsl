// MapLibre 6.15 `symbol_sdf` for viewport-aligned point labels. Vertices arrive in clip
// space (anchor projection, perspective ratio and 1/32 glyph offsets are applied on the CPU);
// the fragment stage is MapLibre's: an SDF edge at 192/256, the halo ring inside
// `(6 - halo_width / fontScale) / SDF_PX`, gamma 0.105 / devicePixelRatio over the font scale.

struct GlyphInput {
  @location(0) position: vec2<f32>,
  @location(1) tex: vec2<f32>,
  // size (text-size x perspective ratio), opacity, halo width, halo blur
  @location(2) params: vec4<f32>,
  // x: 1 draws the fill, y: 1 draws the halo, z: device pixel ratio
  @location(3) mode: vec4<f32>,
  @location(4) fill_color: vec4<f32>,
  @location(5) halo_color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) tex: vec2<f32>,
  @location(1) params: vec4<f32>,
  @location(2) mode: vec4<f32>,
  @location(3) fill_color: vec4<f32>,
  @location(4) halo_color: vec4<f32>,
};

@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var atlas_sampler: sampler;

@vertex
fn vs_main(input: GlyphInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position, 0.0, 1.0);
  output.tex = input.tex;
  output.params = input.params;
  output.mode = input.mode;
  output.fill_color = input.fill_color;
  output.halo_color = input.halo_color;
  return output;
}

const SDF_PX: f32 = 8.0;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let size = input.params.x;
  let total_opacity = input.params.y;
  let halo_width = input.params.z;
  let halo_blur = input.params.w;
  let is_plain = input.mode.x > 0.5;
  let is_halo = input.mode.y > 0.5;
  let edge_gamma = 0.105 / input.mode.z;

  let font_scale = size / 24.0;
  // u_gamma_scale and the vertex gamma scale are 1 for viewport-pitched labels.
  let gamma = edge_gamma / font_scale;
  let inner_edge = (256.0 - 64.0) / 256.0;
  let dist = textureSample(atlas, atlas_sampler, input.tex).r;

  var text = vec4<f32>(0.0);
  var halo = vec4<f32>(0.0);
  if (is_plain) {
    let alpha = smoothstep(inner_edge - gamma, inner_edge + gamma, dist);
    text = total_opacity * alpha * input.fill_color;
  }
  if (is_halo) {
    let gamma_halo = (halo_blur * 1.19 / SDF_PX + edge_gamma) / font_scale;
    let inner_edge_halo = inner_edge + gamma_halo;
    var alpha_halo = smoothstep(inner_edge_halo - gamma_halo, inner_edge_halo + gamma_halo, dist);
    let halo_edge = (6.0 - halo_width / font_scale) / SDF_PX;
    alpha_halo = min(smoothstep(halo_edge - gamma_halo, halo_edge + gamma_halo, dist), 1.0 - alpha_halo);
    halo = total_opacity * alpha_halo * input.halo_color;
  }
  if (is_plain && is_halo) {
    return text + (1.0 - text.a) * halo;
  }
  if (is_halo) {
    return halo;
  }
  return text;
}
