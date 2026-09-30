use super::wgpu_geometry::{
    APPLICATION_CIRCLE_INSTANCE_SIZE, APPLICATION_VERTEX_SIZE, ApplicationDraw, RasterTileKey,
    SurfaceClip, WgpuApplicationFrame, WgpuRasterTilePlacement, append_tile_vertices,
    camera_uniform_bytes, prepare_application_geometry, unpack_tile_draws,
};

use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, ImageBitmap};

const INITIAL_VERTEX_BUFFER_SIZE: u64 = 4 * 1024;
const CAMERA_UNIFORM_SIZE: u64 = 64;
const VERTEX_SIZE: u64 = 16;
const APPLICATION_CIRCLE_VERTEX_COUNT: u32 = 6;
const VERTICES_PER_TILE: u32 = 4;
const MAP_BACKGROUND_RED: f64 = 249.0 / 255.0;
const MAP_BACKGROUND_GREEN: f64 = 244.0 / 255.0;
const MAP_BACKGROUND_BLUE: f64 = 238.0 / 255.0;

const BASE_MAP_SHADER: &str = r#"
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
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = camera.view_projection * vec4<f32>(input.position, 0.0, 1.0);
  output.uv = input.uv;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let sampled = textureSample(raster_tile, raster_sampler, input.uv);
  return vec4<f32>(sampled.rgb * sampled.a, sampled.a);
}
"#;

const APPLICATION_SHADER: &str = r#"
struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position, 0.0, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color.rgb * input.color.a, input.color.a);
}
"#;

const APPLICATION_CIRCLE_SHADER: &str = r#"
struct CircleInput {
  @location(0) center_clip: vec2<f32>,
  @location(1) outer_clip: vec2<f32>,
  @location(2) fill_ratio: f32,
  @location(3) stroke_inner_ratio: f32,
  @location(4) fill_color: vec4<f32>,
  @location(5) stroke_color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) fill_ratio: f32,
  @location(2) stroke_inner_ratio: f32,
  @location(3) fill_color: vec4<f32>,
  @location(4) stroke_color: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32, input: CircleInput) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0),
  );
  let local = corners[vertex_index];
  var output: VertexOutput;
  output.position = vec4<f32>(input.center_clip + local * input.outer_clip, 0.0, 1.0);
  output.local = local;
  output.fill_ratio = input.fill_ratio;
  output.stroke_inner_ratio = input.stroke_inner_ratio;
  output.fill_color = input.fill_color;
  output.stroke_color = input.stroke_color;
  return output;
}

fn premultiplied(color: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(color.rgb * color.a, color.a);
}

fn over(foreground: vec4<f32>, background: vec4<f32>) -> vec4<f32> {
  return foreground + background * (1.0 - foreground.a);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let distance = length(input.local);
  if distance > 1.0 {
    discard;
  }

  let fill = premultiplied(input.fill_color);
  if distance < input.stroke_inner_ratio {
    return fill;
  }

  if input.stroke_inner_ratio <= 1.0 {
    let stroke = premultiplied(input.stroke_color);
    if input.fill_ratio > 0.0 && distance <= input.fill_ratio {
      return over(stroke, fill);
    }
    return stroke;
  }

  // Browsers (Tint) reject a function ending in `discard`: end with a return.
  if distance > input.fill_ratio {
    discard;
  }
  return fill;
}
"#;

struct TileTexture {
    _texture: wgpu::Texture,
    _view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
}

#[wasm_bindgen]
pub struct MapsWgpuBaseMapRenderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    surface_view_format: wgpu::TextureFormat,
    surface_clear_alpha: f64,
    device_lost: Arc<AtomicBool>,
    camera_buffer: wgpu::Buffer,
    camera_bind_group: wgpu::BindGroup,
    texture_bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pipeline: wgpu::RenderPipeline,
    vertex_buffer: wgpu::Buffer,
    vertex_capacity: u64,
    application_pipeline: wgpu::RenderPipeline,
    application_vertex_buffer: wgpu::Buffer,
    application_vertex_capacity: u64,
    application_circle_pipeline: wgpu::RenderPipeline,
    application_circle_instance_buffer: wgpu::Buffer,
    application_circle_instance_capacity: u64,
    tiles: HashMap<RasterTileKey, TileTexture>,
    /// Reused per-frame scratch space; avoids allocating on the render path.
    frame_vertices: Vec<u8>,
    frame_placements: Vec<WgpuRasterTilePlacement>,
}

#[wasm_bindgen(js_name = createWgpuBaseMapRenderer)]
pub async fn create_wgpu_base_map_renderer(
    canvas: HtmlCanvasElement,
) -> Result<MapsWgpuBaseMapRenderer, JsValue> {
    MapsWgpuBaseMapRenderer::new(canvas).await
}

#[wasm_bindgen]
impl MapsWgpuBaseMapRenderer {
    async fn new(canvas: HtmlCanvasElement) -> Result<Self, JsValue> {
        let instance = wgpu::Instance::default();
        let surface: wgpu::Surface<'static> = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|error| js_error("could not create wgpu canvas surface", error))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .map_err(|error| js_error("could not acquire wgpu adapter", error))?;
        let capabilities = surface.get_capabilities(&adapter);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|error| js_error("could not acquire wgpu device", error))?;
        let device_lost = Arc::new(AtomicBool::new(false));
        let lost_signal = Arc::clone(&device_lost);
        device.set_device_lost_callback(move |_reason, _message| {
            lost_signal.store(true, Ordering::Release);
        });
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);
        let mut config = surface
            .get_default_config(&adapter, width, height)
            .ok_or_else(|| JsValue::from_str("wgpu surface has no compatible configuration"))?;
        if capabilities
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::Opaque)
        {
            config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
        } else if capabilities
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            config.alpha_mode = wgpu::CompositeAlphaMode::PreMultiplied;
        }
        // The base-map surface owns its cartographic background. Keep it opaque even when
        // the browser only offers a compositing-capable alpha mode so vector-only frames do
        // not expose an implementation-defined black canvas behind application geometry.
        let surface_clear_alpha = 1.0;
        config.present_mode = wgpu::PresentMode::AutoVsync;
        let surface_view_format = config.format.add_srgb_suffix();
        if surface_view_format != config.format {
            config.view_formats = vec![surface_view_format];
        }
        surface.configure(&device, &config);

        let camera_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Maps base camera layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
        let texture_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Maps raster tile layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Maps base camera uniform"),
            size: CAMERA_UNIFORM_SIZE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps base camera bind group"),
            layout: &camera_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: camera_buffer.as_entire_binding(),
            }],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Maps raster sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Maps raster tile shader"),
            source: wgpu::ShaderSource::Wgsl(BASE_MAP_SHADER.into()),
        });
        let bind_group_layouts = [
            Some(&camera_bind_group_layout),
            Some(&texture_bind_group_layout),
        ];
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Maps base-map pipeline layout"),
            bind_group_layouts: &bind_group_layouts,
            immediate_size: 0,
        });
        let attributes = [
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x2,
                offset: 0,
                shader_location: 0,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x2,
                offset: 8,
                shader_location: 1,
            },
        ];
        let vertex_buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: VERTEX_SIZE,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &attributes,
        })];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Maps raster tile pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &vertex_buffers,
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_view_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let vertex_buffer = create_vertex_buffer(&device, INITIAL_VERTEX_BUFFER_SIZE);

        let application_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Maps application screen-space shader"),
            source: wgpu::ShaderSource::Wgsl(APPLICATION_SHADER.into()),
        });
        let application_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Maps application pipeline layout"),
                bind_group_layouts: &[],
                immediate_size: 0,
            });
        let application_attributes = [
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x2,
                offset: 0,
                shader_location: 0,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x4,
                offset: 8,
                shader_location: 1,
            },
        ];
        let application_vertex_buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: APPLICATION_VERTEX_SIZE,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &application_attributes,
        })];
        let application_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Maps application geometry pipeline"),
            layout: Some(&application_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &application_shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &application_vertex_buffers,
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &application_shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_view_format,
                    blend: Some(premultiplied_blend_state()),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let application_vertex_buffer =
            create_application_vertex_buffer(&device, INITIAL_VERTEX_BUFFER_SIZE);

        let application_circle_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Maps application instanced circle shader"),
            source: wgpu::ShaderSource::Wgsl(APPLICATION_CIRCLE_SHADER.into()),
        });
        let application_circle_attributes = [
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x2,
                offset: 0,
                shader_location: 0,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x2,
                offset: 8,
                shader_location: 1,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32,
                offset: 16,
                shader_location: 2,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32,
                offset: 20,
                shader_location: 3,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x4,
                offset: 24,
                shader_location: 4,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x4,
                offset: 40,
                shader_location: 5,
            },
        ];
        let application_circle_vertex_buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: APPLICATION_CIRCLE_INSTANCE_SIZE,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &application_circle_attributes,
        })];
        let application_circle_pipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Maps application instanced circle pipeline"),
                layout: Some(&application_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &application_circle_shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &application_circle_vertex_buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &application_circle_shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: surface_view_format,
                        blend: Some(premultiplied_blend_state()),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
        let application_circle_instance_buffer =
            create_application_circle_instance_buffer(&device, INITIAL_VERTEX_BUFFER_SIZE);

        Ok(Self {
            surface,
            device,
            queue,
            config,
            surface_view_format,
            surface_clear_alpha,
            device_lost,
            camera_buffer,
            camera_bind_group,
            texture_bind_group_layout,
            sampler,
            pipeline,
            vertex_buffer,
            vertex_capacity: INITIAL_VERTEX_BUFFER_SIZE,
            application_pipeline,
            application_vertex_buffer,
            application_vertex_capacity: INITIAL_VERTEX_BUFFER_SIZE,
            application_circle_pipeline,
            application_circle_instance_buffer,
            application_circle_instance_capacity: INITIAL_VERTEX_BUFFER_SIZE,
            tiles: HashMap::new(),
            frame_vertices: Vec::new(),
            frame_placements: Vec::new(),
        })
    }

    #[wasm_bindgen(js_name = isDeviceLost)]
    pub fn is_device_lost(&self) -> bool {
        self.device_lost.load(Ordering::Acquire)
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let width = width.max(1);
        let height = height.max(1);
        if self.config.width == width && self.config.height == height {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    #[wasm_bindgen(js_name = uploadTile)]
    pub fn upload_tile(
        &mut self,
        z: u8,
        x: u32,
        y: u32,
        image: ImageBitmap,
    ) -> Result<(), JsValue> {
        let width = image.width();
        let height = image.height();
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("raster tile ImageBitmap has zero extent"));
        }

        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Maps raster tile texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            // Browser external-image copies require a renderable destination, even
            // though this renderer only samples the uploaded tile afterwards.
            usage: wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        self.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::ImageBitmap(image),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps raster tile bind group"),
            layout: &self.texture_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        self.tiles.insert(
            (z, x, y),
            TileTexture {
                _texture: texture,
                _view: view,
                bind_group,
            },
        );
        Ok(())
    }

    #[wasm_bindgen(js_name = evictTile)]
    pub fn evict_tile(&mut self, z: u8, x: u32, y: u32) {
        self.tiles.remove(&(z, x, y));
    }

    /// Renders one map frame from packed tile draws (see [`unpack_tile_draws`]).
    #[wasm_bindgen(js_name = renderPacked)]
    pub fn render_packed(
        &mut self,
        tile_draws: &[f64],
        application_frame: JsValue,
    ) -> Result<usize, JsValue> {
        let (view_projection, clip, placements) =
            unpack_tile_draws(tile_draws).map_err(JsValue::from_str)?;
        let application_frame = if application_frame.is_null() || application_frame.is_undefined() {
            None
        } else {
            let mut frame =
                serde_wasm_bindgen::from_value::<WgpuApplicationFrame>(application_frame)
                    .map_err(|error| js_error("invalid wgpu application frame", error))?;
            frame.offset_into_surface(clip.margin);
            Some(frame)
        };
        if view_projection.into_iter().any(|value| !value.is_finite()) {
            return Err(JsValue::from_str(
                "wgpu raster render camera contains non-finite matrix values",
            ));
        }

        let mut placements_buffer = std::mem::take(&mut self.frame_placements);
        placements_buffer.clear();
        placements_buffer.extend(placements);
        let mut vertices = std::mem::take(&mut self.frame_vertices);
        vertices.clear();
        let result = self.render_frame(
            &placements_buffer,
            &mut vertices,
            application_frame,
            view_projection,
            clip,
        );
        self.frame_placements = placements_buffer;
        self.frame_vertices = vertices;
        result
    }

    fn render_frame(
        &mut self,
        placements: &[WgpuRasterTilePlacement],
        vertices: &mut Vec<u8>,
        application_frame: Option<WgpuApplicationFrame>,
        view_projection: [f32; 16],
        clip: SurfaceClip,
    ) -> Result<usize, JsValue> {
        vertices.reserve(placements.len() * 4 * VERTEX_SIZE as usize);
        for placement in placements {
            append_tile_vertices(vertices, placement).map_err(JsValue::from_str)?;
        }

        let required = vertices.len() as u64;
        if required > self.vertex_capacity {
            let capacity = required.next_power_of_two().max(INITIAL_VERTEX_BUFFER_SIZE);
            self.vertex_buffer = create_vertex_buffer(&self.device, capacity);
            self.vertex_capacity = capacity;
        }
        if !vertices.is_empty() {
            self.queue.write_buffer(&self.vertex_buffer, 0, vertices);
        }
        self.queue.write_buffer(
            &self.camera_buffer,
            0,
            &camera_uniform_bytes(view_projection),
        );

        let application_geometry = application_frame
            .as_ref()
            .map(prepare_application_geometry)
            .transpose()
            .map_err(JsValue::from_str)?
            .unwrap_or_default();
        let application_required = application_geometry.triangle_vertices.len() as u64;
        if application_required > self.application_vertex_capacity {
            let capacity = application_required
                .next_power_of_two()
                .max(INITIAL_VERTEX_BUFFER_SIZE);
            self.application_vertex_buffer =
                create_application_vertex_buffer(&self.device, capacity);
            self.application_vertex_capacity = capacity;
        }
        if !application_geometry.triangle_vertices.is_empty() {
            self.queue.write_buffer(
                &self.application_vertex_buffer,
                0,
                &application_geometry.triangle_vertices,
            );
        }
        let circle_required = application_geometry.circle_instances.len() as u64;
        if circle_required > self.application_circle_instance_capacity {
            let capacity = circle_required
                .next_power_of_two()
                .max(INITIAL_VERTEX_BUFFER_SIZE);
            self.application_circle_instance_buffer =
                create_application_circle_instance_buffer(&self.device, capacity);
            self.application_circle_instance_capacity = capacity;
        }
        if !application_geometry.circle_instances.is_empty() {
            self.queue.write_buffer(
                &self.application_circle_instance_buffer,
                0,
                &application_geometry.circle_instances,
            );
        }

        let Some(surface_frame) = self.acquire_surface_frame()? else {
            return Ok(0);
        };
        let view = surface_frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor {
                // Per-frame objects stay unlabeled: labels cost JS crossings every frame.
                label: None,
                format: Some(self.surface_view_format),
                ..Default::default()
            });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: MAP_BACKGROUND_RED,
                    g: MAP_BACKGROUND_GREEN,
                    b: MAP_BACKGROUND_BLUE,
                    a: self.surface_clear_alpha,
                }),
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut drawn_tiles = 0;
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &color_attachments,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if let Some((x, y, width, height)) = clip.scissor(self.config.width, self.config.height)
            {
                // Continuous motion: the margin would be replaced before it is shown.
                pass.set_scissor_rect(x, y, width, height);
            }
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.camera_bind_group, &[]);
            pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));

            for (index, placement) in placements.iter().enumerate() {
                let Some(tile) = placement.key.and_then(|key| self.tiles.get(&key)) else {
                    continue;
                };
                pass.set_bind_group(1, &tile.bind_group, &[]);
                let first = index as u32 * VERTICES_PER_TILE;
                pass.draw(first..first + VERTICES_PER_TILE, 0..1);
                drawn_tiles += 1;
            }

            for draw in &application_geometry.draws {
                match *draw {
                    ApplicationDraw::Circles {
                        first_instance,
                        instance_count,
                    } => {
                        pass.set_pipeline(&self.application_circle_pipeline);
                        pass.set_vertex_buffer(
                            0,
                            self.application_circle_instance_buffer.slice(..),
                        );
                        pass.draw(
                            0..APPLICATION_CIRCLE_VERTEX_COUNT,
                            first_instance..first_instance + instance_count,
                        );
                    }
                    ApplicationDraw::Triangles {
                        first_vertex,
                        vertex_count,
                    } => {
                        pass.set_pipeline(&self.application_pipeline);
                        pass.set_vertex_buffer(0, self.application_vertex_buffer.slice(..));
                        pass.draw(first_vertex..first_vertex + vertex_count, 0..1);
                    }
                }
            }
        }

        self.queue.submit([encoder.finish()]);
        self.queue.present(surface_frame);
        Ok(drawn_tiles)
    }

    fn acquire_surface_frame(&self) -> Result<Option<wgpu::SurfaceTexture>, JsValue> {
        use wgpu::CurrentSurfaceTexture;

        match self.surface.get_current_texture() {
            CurrentSurfaceTexture::Success(frame) | CurrentSurfaceTexture::Suboptimal(frame) => {
                Ok(Some(frame))
            }
            CurrentSurfaceTexture::Timeout | CurrentSurfaceTexture::Occluded => Ok(None),
            CurrentSurfaceTexture::Outdated | CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                match self.surface.get_current_texture() {
                    CurrentSurfaceTexture::Success(frame)
                    | CurrentSurfaceTexture::Suboptimal(frame) => Ok(Some(frame)),
                    CurrentSurfaceTexture::Timeout | CurrentSurfaceTexture::Occluded => Ok(None),
                    CurrentSurfaceTexture::Outdated => Err(JsValue::from_str(
                        "wgpu surface remained outdated after reconfigure",
                    )),
                    CurrentSurfaceTexture::Lost => Err(JsValue::from_str(
                        "wgpu surface remained lost after reconfigure",
                    )),
                    CurrentSurfaceTexture::Validation => {
                        Err(JsValue::from_str("wgpu surface validation failure"))
                    }
                }
            }
            CurrentSurfaceTexture::Validation => {
                Err(JsValue::from_str("wgpu surface validation failure"))
            }
        }
    }
}

fn create_vertex_buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Maps raster placement vertices"),
        size,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn create_application_vertex_buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Maps application screen-space vertices"),
        size,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn create_application_circle_instance_buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Maps application circle instances"),
        size,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn premultiplied_blend_state() -> wgpu::BlendState {
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
    }
}

fn js_error(context: &str, error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{context}: {error}"))
}
