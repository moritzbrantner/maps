struct VectorTile {
  matrix: mat4x4<f32>,
  // Physical surface width/height (px) and the CSS-to-physical pixel ratio.
  surface: vec4<f32>,
};

struct VectorStyle {
  color: vec4<f32>,
  // x: line width in CSS px.
  params: vec4<f32>,
};

struct VectorStyles {
  entries: array<VectorStyle, 12>,
};

@group(0) @binding(0)
var<uniform> tile: VectorTile;

@group(1) @binding(0)
var<uniform> styles: VectorStyles;

struct FillInput {
  @location(0) position: vec2<f32>,
  @location(1) style_class: u32,
};

struct FillOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) color: vec4<f32>,
};

@vertex
fn vs_fill(input: FillInput) -> FillOutput {
  var output: FillOutput;
  output.position = tile.matrix * vec4<f32>(input.position, 0.0, 1.0);
  let color = styles.entries[input.style_class].color;
  output.color = vec4<f32>(color.rgb * color.a, color.a);
  return output;
}

@fragment
fn fs_fill(input: FillOutput) -> @location(0) vec4<f32> {
  return input.color;
}

struct LineInput {
  @location(0) segment: vec4<f32>,
  @location(1) style_class: u32,
};

struct LineOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) across: f32,
  @location(1) @interpolate(flat) half_width: f32,
  @location(2) @interpolate(flat) color: vec4<f32>,
};

// Screen-space quads per segment: widths stay in CSS px at every zoom, and square
// caps extend each segment by half its width so polyline joints stay closed. Each
// segment is four vertices; the index pattern makes `vertex_index & 3` its corner.
@vertex
fn vs_line(@builtin(vertex_index) vertex_index: u32, input: LineInput) -> LineOutput {
  let corners = array<vec2<f32>, 4>(
    vec2<f32>(0.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
  );
  let corner = corners[vertex_index & 3u];
  let style = styles.entries[input.style_class];
  let width = style.params.x * tile.surface.z;
  let half_width = max(width, 1.0) * 0.5;
  // One extra pixel of feather on each side for analytic antialiasing.
  let extent = half_width + 1.0;
  var output: LineOutput;
  let start = tile.matrix * vec4<f32>(input.segment.xy, 0.0, 1.0);
  let end = tile.matrix * vec4<f32>(input.segment.zw, 0.0, 1.0);
  if start.w <= 0.0 || end.w <= 0.0 {
    output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    output.across = 0.0;
    output.half_width = 0.0;
    output.color = vec4<f32>(0.0);
    return output;
  }
  let half_surface = tile.surface.xy * 0.5;
  let start_px = start.xy / start.w * half_surface;
  let end_px = end.xy / end.w * half_surface;
  let delta = end_px - start_px;
  let length_px = length(delta);
  var direction = vec2<f32>(1.0, 0.0);
  if length_px > 1.0e-6 {
    direction = delta / length_px;
  }
  let normal = vec2<f32>(-direction.y, direction.x);
  let pixel = mix(start_px, end_px, corner.x)
    + direction * mix(-half_width, half_width, corner.x)
    + normal * corner.y * extent;
  output.position = vec4<f32>(pixel / half_surface, 0.0, 1.0);
  output.across = corner.y * extent;
  output.half_width = half_width;
  // Sub-pixel lines keep their coverage as alpha instead of vanishing.
  let alpha = style.color.a * min(width, 1.0);
  output.color = vec4<f32>(style.color.rgb * alpha, alpha);
  return output;
}

@fragment
fn fs_line(input: LineOutput) -> @location(0) vec4<f32> {
  let coverage = clamp(input.half_width + 0.5 - abs(input.across), 0.0, 1.0);
  return input.color * coverage;
}
