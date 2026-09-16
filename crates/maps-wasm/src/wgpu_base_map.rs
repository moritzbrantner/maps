use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serde::Deserialize;
use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, ImageBitmap};

const INITIAL_VERTEX_BUFFER_SIZE: u64 = 4 * 1024;
const CAMERA_UNIFORM_SIZE: u64 = 64;
const VERTEX_SIZE: u64 = 16;
const APPLICATION_VERTEX_SIZE: u64 = 24;
const VERTICES_PER_TILE: u32 = 4;
const CIRCLE_SEGMENTS: usize = 24;
const LINE_CAP_SEGMENTS: usize = 12;
const MAX_LINE_MITER_SCALE: f64 = 4.0;
const GEOMETRY_EPSILON: f64 = 1.0e-9;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WgpuRasterRenderCamera {
    view_projection: [f32; 16],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WgpuRasterTilePlacement {
    tile: WgpuRasterTileId,
    local_west: f64,
    local_north: f64,
    local_size: f64,
}

#[derive(Debug, Deserialize)]
struct WgpuRasterTileId {
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WgpuApplicationFrame {
    height: f64,
    primitives: Vec<WgpuApplicationPrimitive>,
    width: f64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
enum WgpuApplicationPrimitive {
    Circle(WgpuApplicationCircle),
    DirectionMarker(WgpuApplicationDirectionMarker),
    Line(WgpuApplicationLine),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WgpuApplicationCircle {
    fill_color: [f32; 4],
    radius: f64,
    stroke_color: [f32; 4],
    stroke_width: f64,
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WgpuApplicationDirectionMarker {
    angle: f64,
    color: [f32; 4],
    size: f64,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct WgpuApplicationPoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WgpuApplicationLine {
    color: [f32; 4],
    points: Vec<WgpuApplicationPoint>,
    stroke_width: f64,
}

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
    tiles: HashMap<String, TileTexture>,
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
        if !capabilities
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            return Err(JsValue::from_str(
                "wgpu surface does not support premultiplied-alpha compositing",
            ));
        }
        config.alpha_mode = wgpu::CompositeAlphaMode::PreMultiplied;
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
        let premultiplied_blend = wgpu::BlendState {
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
        };
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
                    blend: Some(premultiplied_blend),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let application_vertex_buffer =
            create_application_vertex_buffer(&device, INITIAL_VERTEX_BUFFER_SIZE);

        Ok(Self {
            surface,
            device,
            queue,
            config,
            surface_view_format,
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
            tiles: HashMap::new(),
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
    pub fn upload_tile(&mut self, key: String, image: ImageBitmap) -> Result<(), JsValue> {
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
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
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
            key,
            TileTexture {
                _texture: texture,
                _view: view,
                bind_group,
            },
        );
        Ok(())
    }

    #[wasm_bindgen(js_name = evictTile)]
    pub fn evict_tile(&mut self, key: &str) {
        self.tiles.remove(key);
    }

    pub fn render(
        &mut self,
        placements: JsValue,
        render_camera: JsValue,
        application_frame: JsValue,
    ) -> Result<usize, JsValue> {
        let placements = serde_wasm_bindgen::from_value::<Vec<WgpuRasterTilePlacement>>(placements)
            .map_err(|error| js_error("invalid wgpu raster placements", error))?;
        let render_camera = serde_wasm_bindgen::from_value::<WgpuRasterRenderCamera>(render_camera)
            .map_err(|error| js_error("invalid wgpu raster render camera", error))?;
        let application_frame =
            serde_wasm_bindgen::from_value::<Option<WgpuApplicationFrame>>(application_frame)
                .map_err(|error| js_error("invalid wgpu application frame", error))?;
        if render_camera
            .view_projection
            .into_iter()
            .any(|value| !value.is_finite())
        {
            return Err(JsValue::from_str(
                "wgpu raster render camera contains non-finite matrix values",
            ));
        }

        let mut vertices = Vec::with_capacity(placements.len() * 4 * VERTEX_SIZE as usize);
        for placement in &placements {
            append_tile_vertices(&mut vertices, placement)?;
        }

        let required = vertices.len() as u64;
        if required > self.vertex_capacity {
            let capacity = required.next_power_of_two().max(INITIAL_VERTEX_BUFFER_SIZE);
            self.vertex_buffer = create_vertex_buffer(&self.device, capacity);
            self.vertex_capacity = capacity;
        }
        if !vertices.is_empty() {
            self.queue.write_buffer(&self.vertex_buffer, 0, &vertices);
        }
        self.queue.write_buffer(
            &self.camera_buffer,
            0,
            &camera_uniform_bytes(render_camera.view_projection),
        );

        let mut application_vertices = Vec::new();
        if let Some(frame) = application_frame.as_ref() {
            append_application_vertices(&mut application_vertices, frame)?;
        }
        let application_required = application_vertices.len() as u64;
        if application_required > self.application_vertex_capacity {
            let capacity = application_required
                .next_power_of_two()
                .max(INITIAL_VERTEX_BUFFER_SIZE);
            self.application_vertex_buffer =
                create_application_vertex_buffer(&self.device, capacity);
            self.application_vertex_capacity = capacity;
        }
        if !application_vertices.is_empty() {
            self.queue
                .write_buffer(&self.application_vertex_buffer, 0, &application_vertices);
        }
        let application_vertex_count =
            (application_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;

        let Some(surface_frame) = self.acquire_surface_frame()? else {
            return Ok(0);
        };
        let view = surface_frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor {
                label: Some("Maps base-map sRGB surface view"),
                format: Some(self.surface_view_format),
                ..Default::default()
            });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Maps map-frame command encoder"),
            });
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: 0.0,
                    g: 0.0,
                    b: 0.0,
                    a: 0.0,
                }),
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut drawn_tiles = 0;
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Maps raster and application render pass"),
                color_attachments: &color_attachments,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.camera_bind_group, &[]);
            pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));

            for (index, placement) in placements.iter().enumerate() {
                let Some(tile) = self.tiles.get(&placement.tile.key) else {
                    continue;
                };
                pass.set_bind_group(1, &tile.bind_group, &[]);
                let first = index as u32 * VERTICES_PER_TILE;
                pass.draw(first..first + VERTICES_PER_TILE, 0..1);
                drawn_tiles += 1;
            }

            if application_vertex_count > 0 {
                pass.set_pipeline(&self.application_pipeline);
                pass.set_vertex_buffer(0, self.application_vertex_buffer.slice(..));
                pass.draw(0..application_vertex_count, 0..1);
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

fn append_tile_vertices(
    output: &mut Vec<u8>,
    placement: &WgpuRasterTilePlacement,
) -> Result<(), JsValue> {
    let values = [
        placement.local_west,
        placement.local_north,
        placement.local_size,
    ];
    if values.iter().any(|value| !value.is_finite()) || placement.local_size <= 0.0 {
        return Err(JsValue::from_str("invalid raster tile local placement"));
    }

    let left = placement.local_west as f32;
    let top = placement.local_north as f32;
    let right = (placement.local_west + placement.local_size) as f32;
    let bottom = (placement.local_north - placement.local_size) as f32;
    if [left, top, right, bottom]
        .into_iter()
        .any(|value| !value.is_finite())
    {
        return Err(JsValue::from_str(
            "raster tile local placement is not representable as f32",
        ));
    }

    for vertex in [
        [left, top, 0.0, 0.0],
        [left, bottom, 0.0, 1.0],
        [right, top, 1.0, 0.0],
        [right, bottom, 1.0, 1.0],
    ] {
        for value in vertex {
            output.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(())
}

fn append_application_vertices(
    output: &mut Vec<u8>,
    frame: &WgpuApplicationFrame,
) -> Result<(), JsValue> {
    if !frame.width.is_finite()
        || !frame.height.is_finite()
        || frame.width <= 0.0
        || frame.height <= 0.0
    {
        return Err(JsValue::from_str("invalid wgpu application frame extent"));
    }

    for primitive in &frame.primitives {
        match primitive {
            WgpuApplicationPrimitive::Circle(circle) => {
                append_application_circle(output, frame.width, frame.height, circle)?;
            }
            WgpuApplicationPrimitive::DirectionMarker(marker) => {
                append_application_direction_marker(output, frame.width, frame.height, marker)?;
            }
            WgpuApplicationPrimitive::Line(line) => {
                append_application_line(output, frame.width, frame.height, line)?;
            }
        }
    }
    Ok(())
}

fn append_application_circle(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    circle: &WgpuApplicationCircle,
) -> Result<(), JsValue> {
    if [circle.x, circle.y, circle.radius, circle.stroke_width]
        .into_iter()
        .any(|value| !value.is_finite())
        || circle.radius < 0.0
        || circle.stroke_width < 0.0
        || !valid_color(circle.fill_color)
        || !valid_color(circle.stroke_color)
    {
        return Err(JsValue::from_str("invalid wgpu application circle"));
    }

    for segment in 0..CIRCLE_SEGMENTS {
        let angle_a = std::f64::consts::TAU * segment as f64 / CIRCLE_SEGMENTS as f64;
        let angle_b = std::f64::consts::TAU * (segment + 1) as f64 / CIRCLE_SEGMENTS as f64;
        let a = point_on_circle(circle.x, circle.y, circle.radius, angle_a);
        let b = point_on_circle(circle.x, circle.y, circle.radius, angle_b);
        append_application_vertex(output, width, height, circle.x, circle.y, circle.fill_color)?;
        append_application_vertex(output, width, height, a.0, a.1, circle.fill_color)?;
        append_application_vertex(output, width, height, b.0, b.1, circle.fill_color)?;
    }

    if circle.stroke_width > 0.0 {
        let inner_radius = (circle.radius - circle.stroke_width / 2.0).max(0.0);
        let outer_radius = circle.radius + circle.stroke_width / 2.0;
        for segment in 0..CIRCLE_SEGMENTS {
            let angle_a = std::f64::consts::TAU * segment as f64 / CIRCLE_SEGMENTS as f64;
            let angle_b = std::f64::consts::TAU * (segment + 1) as f64 / CIRCLE_SEGMENTS as f64;
            let inner_a = point_on_circle(circle.x, circle.y, inner_radius, angle_a);
            let inner_b = point_on_circle(circle.x, circle.y, inner_radius, angle_b);
            let outer_a = point_on_circle(circle.x, circle.y, outer_radius, angle_a);
            let outer_b = point_on_circle(circle.x, circle.y, outer_radius, angle_b);

            for point in [inner_a, outer_a, outer_b, inner_a, outer_b, inner_b] {
                append_application_vertex(
                    output,
                    width,
                    height,
                    point.0,
                    point.1,
                    circle.stroke_color,
                )?;
            }
        }
    }

    Ok(())
}

fn append_application_direction_marker(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    marker: &WgpuApplicationDirectionMarker,
) -> Result<(), JsValue> {
    if [marker.x, marker.y, marker.angle, marker.size]
        .into_iter()
        .any(|value| !value.is_finite())
        || marker.size < 0.0
        || !valid_color(marker.color)
    {
        return Err(JsValue::from_str(
            "invalid wgpu application direction marker",
        ));
    }

    let local_points = [
        (marker.size * 0.38, 0.0),
        (marker.size * -0.62, marker.size * -0.42),
        (marker.size * -0.62, marker.size * 0.42),
    ];
    let sine = marker.angle.sin();
    let cosine = marker.angle.cos();
    for (local_x, local_y) in local_points {
        let x = marker.x + local_x * cosine - local_y * sine;
        let y = marker.y + local_x * sine + local_y * cosine;
        append_application_vertex(output, width, height, x, y, marker.color)?;
    }
    Ok(())
}

fn append_application_line(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    line: &WgpuApplicationLine,
) -> Result<(), JsValue> {
    if !line.stroke_width.is_finite()
        || line.stroke_width < 0.0
        || !valid_color(line.color)
        || line
            .points
            .iter()
            .any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        return Err(JsValue::from_str("invalid wgpu application line"));
    }
    if line.stroke_width == 0.0 {
        return Ok(());
    }

    let points = deduplicate_line_points(&line.points);
    if points.len() < 2 {
        return Err(JsValue::from_str(
            "wgpu application line has no non-degenerate segment",
        ));
    }

    let half_width = line.stroke_width / 2.0;
    let directions = points
        .windows(2)
        .map(|segment| unit_direction(segment[0], segment[1]))
        .collect::<Result<Vec<_>, _>>()?;
    let normals = directions
        .iter()
        .map(|direction| (-direction.1, direction.0))
        .collect::<Vec<_>>();
    let offsets = line_offsets(&normals, half_width);

    for index in 0..points.len() - 1 {
        let start = points[index];
        let end = points[index + 1];
        let start_offset = offsets[index];
        let end_offset = offsets[index + 1];
        let start_left = (start.x + start_offset.0, start.y + start_offset.1);
        let start_right = (start.x - start_offset.0, start.y - start_offset.1);
        let end_left = (end.x + end_offset.0, end.y + end_offset.1);
        let end_right = (end.x - end_offset.0, end.y - end_offset.1);

        for point in [
            start_left,
            start_right,
            end_left,
            start_right,
            end_right,
            end_left,
        ] {
            append_application_vertex(output, width, height, point.0, point.1, line.color)?;
        }
    }

    let first = points[0];
    let first_direction = directions[0];
    append_round_line_cap(
        output,
        width,
        height,
        first,
        (-first_direction.0).atan2(-first_direction.1),
        half_width,
        line.color,
    )?;
    let last = *points.last().expect("line has at least two points");
    let last_direction = *directions.last().expect("line has at least one direction");
    append_round_line_cap(
        output,
        width,
        height,
        last,
        last_direction.0.atan2(last_direction.1),
        half_width,
        line.color,
    )?;

    Ok(())
}

fn deduplicate_line_points(points: &[WgpuApplicationPoint]) -> Vec<WgpuApplicationPoint> {
    let mut result = Vec::with_capacity(points.len());
    for point in points {
        let keep = result.last().is_none_or(|previous: &WgpuApplicationPoint| {
            let dx = point.x - previous.x;
            let dy = point.y - previous.y;
            dx.hypot(dy) > GEOMETRY_EPSILON
        });
        if keep {
            result.push(*point);
        }
    }
    result
}

fn unit_direction(
    start: WgpuApplicationPoint,
    end: WgpuApplicationPoint,
) -> Result<(f64, f64), JsValue> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let length = dx.hypot(dy);
    if !length.is_finite() || length <= GEOMETRY_EPSILON {
        return Err(JsValue::from_str("invalid wgpu application line segment"));
    }
    Ok((dx / length, dy / length))
}

fn line_offsets(normals: &[(f64, f64)], half_width: f64) -> Vec<(f64, f64)> {
    let point_count = normals.len() + 1;
    let mut offsets = Vec::with_capacity(point_count);
    for index in 0..point_count {
        if index == 0 {
            offsets.push((normals[0].0 * half_width, normals[0].1 * half_width));
            continue;
        }
        if index == point_count - 1 {
            let normal = normals[normals.len() - 1];
            offsets.push((normal.0 * half_width, normal.1 * half_width));
            continue;
        }

        let previous = normals[index - 1];
        let next = normals[index];
        let sum = (previous.0 + next.0, previous.1 + next.1);
        let sum_length = sum.0.hypot(sum.1);
        if sum_length <= GEOMETRY_EPSILON {
            offsets.push((next.0 * half_width, next.1 * half_width));
            continue;
        }

        let miter = (sum.0 / sum_length, sum.1 / sum_length);
        let denominator = miter.0 * next.0 + miter.1 * next.1;
        if denominator.abs() <= GEOMETRY_EPSILON {
            offsets.push((next.0 * half_width, next.1 * half_width));
            continue;
        }

        let scale = (half_width / denominator).clamp(
            -half_width * MAX_LINE_MITER_SCALE,
            half_width * MAX_LINE_MITER_SCALE,
        );
        offsets.push((miter.0 * scale, miter.1 * scale));
    }
    offsets
}

fn append_round_line_cap(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    center: WgpuApplicationPoint,
    outward_angle: f64,
    radius: f64,
    color: [f32; 4],
) -> Result<(), JsValue> {
    let start_angle = outward_angle - std::f64::consts::FRAC_PI_2;
    for segment in 0..LINE_CAP_SEGMENTS {
        let fraction_a = segment as f64 / LINE_CAP_SEGMENTS as f64;
        let fraction_b = (segment + 1) as f64 / LINE_CAP_SEGMENTS as f64;
        let angle_a = start_angle + std::f64::consts::PI * fraction_a;
        let angle_b = start_angle + std::f64::consts::PI * fraction_b;
        let a = point_on_circle(center.x, center.y, radius, angle_a);
        let b = point_on_circle(center.x, center.y, radius, angle_b);
        append_application_vertex(output, width, height, center.x, center.y, color)?;
        append_application_vertex(output, width, height, a.0, a.1, color)?;
        append_application_vertex(output, width, height, b.0, b.1, color)?;
    }
    Ok(())
}

fn append_application_vertex(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    color: [f32; 4],
) -> Result<(), JsValue> {
    let clip_x = (x / width * 2.0 - 1.0) as f32;
    let clip_y = (1.0 - y / height * 2.0) as f32;
    if !clip_x.is_finite() || !clip_y.is_finite() {
        return Err(JsValue::from_str(
            "wgpu application position is not representable as f32",
        ));
    }

    output.extend_from_slice(&clip_x.to_le_bytes());
    output.extend_from_slice(&clip_y.to_le_bytes());
    for value in color {
        output.extend_from_slice(&value.to_le_bytes());
    }
    Ok(())
}

fn point_on_circle(center_x: f64, center_y: f64, radius: f64, angle: f64) -> (f64, f64) {
    (
        center_x + angle.cos() * radius,
        center_y + angle.sin() * radius,
    )
}

fn valid_color(color: [f32; 4]) -> bool {
    color
        .into_iter()
        .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
}

fn camera_uniform_bytes(view_projection: [f32; 16]) -> [u8; 64] {
    let mut bytes = [0; 64];
    for (index, value) in view_projection.into_iter().enumerate() {
        let offset = index * 4;
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn js_error(context: &str, error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{context}: {error}"))
}
