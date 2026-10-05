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

use maps_core::{
    TileId, VECTOR_FILL_PAINT_ORDER, VECTOR_LINE_GROUP_COUNT, build_shortbread_buckets,
    vector_tile_placements,
};
use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, ImageBitmap};

use crate::retained_frame::LocalFrame;
use crate::vector_basemap_layout::{
    FILL_VERTEX_SIZE, LINE_QUAD_INDICES, LINE_VERTEX_SIZE, STYLE_TABLE_SIZE, fill_index_bytes,
    fill_vertex_bytes, line_index_bytes, line_vertex_bytes, style_table_bytes,
};
use crate::wgpu_retained::{
    FrameUniforms, RetainedResource, RetainedSet, retained_bytes, upload_retained_buffer,
};

const INITIAL_VERTEX_BUFFER_SIZE: u64 = 4 * 1024;
const CAMERA_UNIFORM_SIZE: u64 = 64;
const VERTEX_SIZE: u64 = 16;
const APPLICATION_CIRCLE_VERTEX_COUNT: u32 = 6;
const VERTICES_PER_TILE: u32 = 4;
const MAP_BACKGROUND_RED: f64 = 249.0 / 255.0;
const MAP_BACKGROUND_GREEN: f64 = 244.0 / 255.0;
const MAP_BACKGROUND_BLUE: f64 = 238.0 / 255.0;
/// Shortbread publishes tiles up to z14; deeper cameras overzoom those tiles.
const DEFAULT_VECTOR_MAX_ZOOM: u8 = 14;

const BASE_MAP_SHADER: &str = include_str!("shaders/base_map.wgsl");

const APPLICATION_SHADER: &str = include_str!("shaders/application.wgsl");

const APPLICATION_CIRCLE_SHADER: &str = include_str!("shaders/application_circle.wgsl");

const VECTOR_SHADER: &str = include_str!("shaders/vector_basemap.wgsl");

/// One vector tile's retained GPU buckets (see `maps_core::build_shortbread_buckets`).
struct VectorTileBuffers {
    fill_vertices: Option<wgpu::Buffer>,
    fill_indices: Option<wgpu::Buffer>,
    line_vertices: Option<wgpu::Buffer>,
    line_indices: Option<wgpu::Buffer>,
    fill_groups: [std::ops::Range<u32>; VECTOR_FILL_PAINT_ORDER.len()],
    line_groups: [std::ops::Range<u32>; VECTOR_LINE_GROUP_COUNT],
    feature_count: u32,
}

impl RetainedResource for VectorTileBuffers {
    fn byte_size(&self) -> u64 {
        retained_bytes([
            &self.fill_vertices,
            &self.fill_indices,
            &self.line_vertices,
            &self.line_indices,
        ])
    }
}

/// Counters of the last rendered frame, for hosts' observability.
#[derive(Clone, Copy, Default)]
struct FrameStats {
    raster_tiles: u32,
    vector_tiles: u32,
    draw_calls: u32,
    /// Application circle instances and triangle vertices written to GPU buffers.
    application_upload_bytes: u64,
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
    vector_fill_pipeline: wgpu::RenderPipeline,
    vector_line_pipeline: wgpu::RenderPipeline,
    /// Per-tile frame uniforms of the retained vector buckets (shared retained module).
    vector_frame_uniforms: FrameUniforms,
    vector_style_buffer: wgpu::Buffer,
    vector_style_bind_group: wgpu::BindGroup,
    vector_tiles: RetainedSet<RasterTileKey, VectorTileBuffers>,
    vector_max_zoom: u8,
    frame_stats: FrameStats,
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

        let vector_frame_uniforms = FrameUniforms::new(&device, "Maps vector tile frame layout");
        let vector_style_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Maps vector style layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(STYLE_TABLE_SIZE),
                    },
                    count: None,
                }],
            });
        let vector_style_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Maps vector style table"),
            size: STYLE_TABLE_SIZE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            // Zeroed: nothing is visible until the host provides a style table.
            mapped_at_creation: false,
        });
        let vector_style_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps vector style bind group"),
            layout: &vector_style_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: vector_style_buffer.as_entire_binding(),
            }],
        });
        let vector_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Maps vector basemap shader"),
            source: wgpu::ShaderSource::Wgsl(VECTOR_SHADER.into()),
        });
        let vector_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Maps vector basemap pipeline layout"),
                bind_group_layouts: &[
                    Some(vector_frame_uniforms.layout()),
                    Some(&vector_style_layout),
                ],
                immediate_size: 0,
            });
        let vector_fill_attributes = [
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x2,
                offset: 0,
                shader_location: 0,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Uint32,
                offset: 8,
                shader_location: 1,
            },
        ];
        let vector_line_attributes = [
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Float32x4,
                offset: 0,
                shader_location: 0,
            },
            wgpu::VertexAttribute {
                format: wgpu::VertexFormat::Uint32,
                offset: 16,
                shader_location: 1,
            },
        ];
        let vector_pipeline =
            |label: &str, entry: (&str, &str), layout: wgpu::VertexBufferLayout<'_>| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(label),
                    layout: Some(&vector_pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &vector_shader,
                        entry_point: Some(entry.0),
                        compilation_options: Default::default(),
                        buffers: &[Some(layout)],
                    },
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        ..Default::default()
                    },
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &vector_shader,
                        entry_point: Some(entry.1),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: surface_view_format,
                            blend: Some(premultiplied_blend_state()),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview_mask: None,
                    cache: None,
                })
            };
        let vector_fill_pipeline = vector_pipeline(
            "Maps vector fill pipeline",
            ("vs_fill", "fs_fill"),
            wgpu::VertexBufferLayout {
                array_stride: FILL_VERTEX_SIZE,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &vector_fill_attributes,
            },
        );
        let vector_line_pipeline = vector_pipeline(
            "Maps vector line pipeline",
            ("vs_line", "fs_line"),
            wgpu::VertexBufferLayout {
                array_stride: LINE_VERTEX_SIZE,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &vector_line_attributes,
            },
        );

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
            vector_fill_pipeline,
            vector_line_pipeline,
            vector_frame_uniforms,
            vector_style_buffer,
            vector_style_bind_group,
            vector_tiles: RetainedSet::new(),
            vector_max_zoom: DEFAULT_VECTOR_MAX_ZOOM,
            frame_stats: FrameStats::default(),
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

    /// Decodes a Shortbread tile and retains its tile-local buckets on the GPU.
    /// Returns the number of decoded features. Camera frames only update uniforms.
    #[wasm_bindgen(js_name = uploadVectorTile)]
    pub fn upload_vector_tile(
        &mut self,
        z: u8,
        x: u32,
        y: u32,
        bytes: &[u8],
    ) -> Result<u32, JsValue> {
        if TileId::new(z, x, y).is_none() {
            return Err(JsValue::from_str("invalid vector tile identity"));
        }
        let buckets = build_shortbread_buckets(bytes)
            .map_err(|error| js_error("could not build Shortbread buckets", error))?;
        let upload = |label: &str, usage: wgpu::BufferUsages, contents: Vec<u8>| {
            upload_retained_buffer(&self.device, &self.queue, label, usage, &contents)
        };
        let fill_vertices = upload(
            "Maps vector fill vertices",
            wgpu::BufferUsages::VERTEX,
            fill_vertex_bytes(&buckets),
        );
        let fill_indices = upload(
            "Maps vector fill indices",
            wgpu::BufferUsages::INDEX,
            fill_index_bytes(&buckets),
        );
        let line_vertices = upload(
            "Maps vector line vertices",
            wgpu::BufferUsages::VERTEX,
            line_vertex_bytes(&buckets),
        );
        let line_indices = upload(
            "Maps vector line indices",
            wgpu::BufferUsages::INDEX,
            line_index_bytes(&buckets),
        );
        self.vector_tiles.insert(
            (z, x, y),
            VectorTileBuffers {
                fill_vertices,
                fill_indices,
                line_vertices,
                line_indices,
                fill_groups: buckets.fill_groups,
                line_groups: buckets.line_groups,
                feature_count: buckets.feature_count,
            },
        );
        Ok(buckets.feature_count)
    }

    #[wasm_bindgen(js_name = evictVectorTile)]
    pub fn evict_vector_tile(&mut self, z: u8, x: u32, y: u32) {
        self.vector_tiles.evict(&(z, x, y));
    }

    /// Replaces the vector style table: one entry of 8 floats (RGBA in [0, 1], line
    /// width in CSS px, 3 reserved) per `maps_core::VectorBasemapStyleClass`.
    #[wasm_bindgen(js_name = setVectorStyle)]
    pub fn set_vector_style(&mut self, table: &[f32]) -> Result<(), JsValue> {
        let bytes = style_table_bytes(table).map_err(JsValue::from_str)?;
        self.queue
            .write_buffer(&self.vector_style_buffer, 0, &bytes);
        Ok(())
    }

    /// Deepest vector tile zoom; deeper raster placements draw their ancestor.
    #[wasm_bindgen(js_name = setVectorMaxZoom)]
    pub fn set_vector_max_zoom(&mut self, max_zoom: u8) {
        self.vector_max_zoom = max_zoom;
    }

    /// Last frame and retained-resource counters: raster tiles drawn, vector tiles
    /// drawn, draw calls, then retained vector tiles, features, fill triangles, line
    /// segments and GPU bytes, then application GPU upload bytes of the last frame.
    #[wasm_bindgen(js_name = frameStats)]
    pub fn frame_stats(&self) -> Vec<f64> {
        let (mut features, mut triangles, mut segments) = (0_u64, 0_u64, 0_u64);
        for tile in self.vector_tiles.values() {
            features += u64::from(tile.feature_count);
            triangles += tile
                .fill_groups
                .iter()
                .map(|range| u64::from(range.len() as u32 / 3))
                .sum::<u64>();
            segments += tile
                .line_groups
                .iter()
                .map(|range| range.len() as u64)
                .sum::<u64>();
        }
        vec![
            f64::from(self.frame_stats.raster_tiles),
            f64::from(self.frame_stats.vector_tiles),
            f64::from(self.frame_stats.draw_calls),
            self.vector_tiles.len() as f64,
            features as f64,
            triangles as f64,
            segments as f64,
            self.vector_tiles.byte_size() as f64,
            self.frame_stats.application_upload_bytes as f64,
        ]
    }

    /// Renders one map frame from packed tile draws (see [`unpack_tile_draws`]).
    #[wasm_bindgen(js_name = renderPacked)]
    pub fn render_packed(
        &mut self,
        tile_draws: &[f64],
        application_frame: JsValue,
        circle_data: &[f32],
        order: &[u32],
    ) -> Result<usize, JsValue> {
        let (view_projection, clip, placements) =
            unpack_tile_draws(tile_draws).map_err(JsValue::from_str)?;
        let application_frame = if application_frame.is_null() || application_frame.is_undefined() {
            None
        } else {
            let mut frame =
                serde_wasm_bindgen::from_value::<WgpuApplicationFrame>(application_frame)
                    .map_err(|error| js_error("invalid wgpu application frame", error))?;
            frame
                .attach_packed(circle_data, order)
                .map_err(JsValue::from_str)?;
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

        let vector_draws = self.prepare_vector_draws(placements, view_projection, clip);

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
        let mut draw_calls = 0;
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
                draw_calls += 1;
            }

            draw_calls += self.draw_vector_tiles(&mut pass, &vector_draws);

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
                        draw_calls += 1;
                    }
                    ApplicationDraw::Triangles {
                        first_vertex,
                        vertex_count,
                    } => {
                        pass.set_pipeline(&self.application_pipeline);
                        pass.set_vertex_buffer(0, self.application_vertex_buffer.slice(..));
                        pass.draw(first_vertex..first_vertex + vertex_count, 0..1);
                        draw_calls += 1;
                    }
                }
            }
        }

        self.queue.submit([encoder.finish()]);
        self.queue.present(surface_frame);
        self.frame_stats = FrameStats {
            raster_tiles: drawn_tiles as u32,
            vector_tiles: vector_draws.len() as u32,
            draw_calls,
            application_upload_bytes: (application_geometry.circle_instances.len()
                + application_geometry.triangle_vertices.len())
                as u64,
        };
        Ok(drawn_tiles)
    }
    /// Resolves retained vector tiles for this frame's raster placements and writes
    /// one per-tile camera uniform each. Returns (tile key, uniform offset) pairs.
    fn prepare_vector_draws(
        &mut self,
        placements: &[WgpuRasterTilePlacement],
        view_projection: [f32; 16],
        clip: SurfaceClip,
    ) -> Vec<(RasterTileKey, u32)> {
        if self.vector_tiles.is_empty() {
            return Vec::new();
        }
        let raster = placements.iter().filter_map(|placement| {
            let (z, x, y) = placement.key?;
            Some((
                TileId::new(z, x, y)?,
                placement.local_west,
                placement.local_north,
                placement.local_size,
            ))
        });
        let surface = [
            self.config.width as f32,
            self.config.height as f32,
            clip.pixel_ratio as f32,
            0.0,
        ];
        let frames = vector_tile_placements(raster, self.vector_max_zoom)
            .into_iter()
            .filter_map(|placement| {
                let key = (placement.tile.z, placement.tile.x, placement.tile.y);
                self.vector_tiles
                    .contains(&key)
                    .then(|| (key, LocalFrame::from(&placement)))
            })
            .collect::<Vec<_>>();
        self.vector_frame_uniforms.write(
            &self.device,
            &self.queue,
            frames,
            view_projection,
            surface,
        )
    }

    /// Paints fills group-major across tiles (style order spans tiles), then building
    /// outlines and linework. Returns the number of draw calls.
    fn draw_vector_tiles(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        draws: &[(RasterTileKey, u32)],
    ) -> u32 {
        if draws.is_empty() {
            return 0;
        }
        let mut calls = 0;
        pass.set_bind_group(1, &self.vector_style_bind_group, &[]);
        pass.set_pipeline(&self.vector_fill_pipeline);
        for group in 0..VECTOR_FILL_PAINT_ORDER.len() {
            for (key, offset) in draws {
                let Some(tile) = self.vector_tiles.get(key) else {
                    continue;
                };
                let range = tile.fill_groups[group].clone();
                let (Some(vertices), Some(indices)) = (&tile.fill_vertices, &tile.fill_indices)
                else {
                    continue;
                };
                if range.is_empty() {
                    continue;
                }
                pass.set_bind_group(0, self.vector_frame_uniforms.bind_group(), &[*offset]);
                pass.set_vertex_buffer(0, vertices.slice(..));
                pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(range, 0, 0..1);
                calls += 1;
            }
        }
        pass.set_pipeline(&self.vector_line_pipeline);
        for group in 0..VECTOR_LINE_GROUP_COUNT {
            for (key, offset) in draws {
                let Some(tile) = self.vector_tiles.get(key) else {
                    continue;
                };
                let range = tile.line_groups[group].clone();
                let (Some(vertices), Some(indices)) = (&tile.line_vertices, &tile.line_indices)
                else {
                    continue;
                };
                if range.is_empty() {
                    continue;
                }
                let per_segment = LINE_QUAD_INDICES.len() as u32;
                pass.set_bind_group(0, self.vector_frame_uniforms.bind_group(), &[*offset]);
                pass.set_vertex_buffer(0, vertices.slice(..));
                pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(range.start * per_segment..range.end * per_segment, 0, 0..1);
                calls += 1;
            }
        }
        calls
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
