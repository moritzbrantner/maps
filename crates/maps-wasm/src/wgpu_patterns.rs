//! wgpu resources of MapLibre's fill programs (#323): the image atlas texture (premultiplied
//! RGBA, `LINEAR` / `CLAMP_TO_EDGE` as MapLibre binds `imageAtlasTexture`), the cross-fade
//! uniform, and the fill, outline and retained pattern-cover pipelines of `fill_pattern.wgsl`.
//! Symbol icons (#346) can bind the same atlas.

use maps_core::symbol::{CrossfadeParameters, ImageAtlas};

use crate::retained_polygons::{FILL_OUTLINE_VERTEX_SIZE, FILL_VERTEX_SIZE};

const SHADER: &str = include_str!("shaders/fill_pattern.wgsl");

pub(crate) struct PatternGpu {
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniform: wgpu::Buffer,
    pub(crate) bind_group: wgpu::BindGroup,
    revision: Option<u64>,
    /// Tileset fill triangles and outlines in tile frames.
    pub(crate) style_fill: wgpu::RenderPipeline,
    pub(crate) style_outline: wgpu::RenderPipeline,
    /// The cover of a patterned retained polygon, under its even-odd stencil.
    pub(crate) retained_cover: wgpu::RenderPipeline,
    /// Its `fill-antialias` pattern outline, over the cover.
    pub(crate) retained_outline: wgpu::RenderPipeline,
}

/// What the pipelines share with the rest of the renderer.
pub(crate) struct PatternPipelineTargets<'a> {
    pub(crate) format: wgpu::TextureFormat,
    pub(crate) blend: wgpu::BlendState,
    pub(crate) tile_frames: &'a wgpu::BindGroupLayout,
    pub(crate) retained_frames: &'a wgpu::BindGroupLayout,
    pub(crate) ignored_stencil: Option<wgpu::DepthStencilState>,
    pub(crate) cover_stencil: Option<wgpu::DepthStencilState>,
}

impl PatternGpu {
    pub(crate) fn new(device: &wgpu::Device, targets: &PatternPipelineTargets<'_>) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps image atlas layout"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Maps image atlas sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Maps pattern cross-fade"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Maps fill pattern shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let attribute = |format, offset, shader_location| wgpu::VertexAttribute {
            format,
            offset,
            shader_location,
        };
        use wgpu::VertexFormat::{Float32x2, Float32x4};
        let fill_attributes = [
            attribute(Float32x2, 0, 0),
            attribute(Float32x2, 8, 1),
            attribute(Float32x2, 16, 2),
            attribute(Float32x2, 24, 3),
            attribute(Float32x2, 32, 4),
            attribute(Float32x4, 40, 5),
            attribute(Float32x2, 56, 6),
        ];
        let outline_attributes = [
            attribute(Float32x2, 0, 0),
            attribute(Float32x2, 8, 1),
            attribute(Float32x2, 16, 2),
            attribute(Float32x2, 24, 3),
            attribute(Float32x2, 32, 4),
            attribute(Float32x2, 40, 5),
            attribute(Float32x2, 48, 6),
            attribute(Float32x4, 56, 7),
            attribute(Float32x2, 72, 8),
        ];
        let pipeline = |label: &str,
                        frames: &wgpu::BindGroupLayout,
                        outline: bool,
                        stencil: Option<wgpu::DepthStencilState>| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[Some(frames), Some(&layout)],
                immediate_size: 0,
            });
            let (vertex, fragment, stride, attributes): (_, _, _, &[wgpu::VertexAttribute]) =
                if outline {
                    (
                        "vs_outline",
                        "fs_outline",
                        FILL_OUTLINE_VERTEX_SIZE,
                        &outline_attributes,
                    )
                } else {
                    ("vs_fill", "fs_fill", FILL_VERTEX_SIZE, &fill_attributes)
                };
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vertex),
                    compilation_options: Default::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: stride,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes,
                    })],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: stencil,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fragment),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: targets.format,
                        blend: Some(targets.blend),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let style_fill = pipeline(
            "Maps tileset fill pipeline",
            targets.tile_frames,
            false,
            targets.ignored_stencil.clone(),
        );
        let style_outline = pipeline(
            "Maps tileset fill-antialias outline pipeline",
            targets.tile_frames,
            true,
            targets.ignored_stencil.clone(),
        );
        let retained_cover = pipeline(
            "Maps retained polygon pattern cover pipeline",
            targets.retained_frames,
            false,
            targets.cover_stencil.clone(),
        );
        let retained_outline = pipeline(
            "Maps retained polygon pattern outline pipeline",
            targets.retained_frames,
            true,
            targets.ignored_stencil.clone(),
        );
        // A blank 1 x 1 atlas until the first sprite arrives.
        let bind_group = Self::bind_atlas(
            device,
            None,
            &layout,
            &sampler,
            &uniform,
            &ImageAtlas::default(),
        );
        Self {
            layout,
            sampler,
            uniform,
            bind_group,
            revision: None,
            style_fill,
            style_outline,
            retained_cover,
            retained_outline,
        }
    }

    fn bind_atlas(
        device: &wgpu::Device,
        queue: Option<&wgpu::Queue>,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        uniform: &wgpu::Buffer,
        atlas: &ImageAtlas,
    ) -> wgpu::BindGroup {
        let size = wgpu::Extent3d {
            width: atlas.width.max(1),
            height: atlas.height.max(1),
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Maps image atlas"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        if let Some(queue) = queue {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &atlas.image,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(size.width * 4),
                    rows_per_image: Some(size.height),
                },
                size,
            );
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps image atlas bind group"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        })
    }

    /// Uploads the atlas when it was repacked and writes this frame's cross-fade.
    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        atlas: &ImageAtlas,
        crossfade: CrossfadeParameters,
    ) {
        if self.revision != Some(atlas.revision) && !atlas.image.is_empty() {
            self.bind_group = Self::bind_atlas(
                device,
                Some(queue),
                &self.layout,
                &self.sampler,
                &self.uniform,
                atlas,
            );
            self.revision = Some(atlas.revision);
        }
        let values = [
            crossfade.from_scale as f32,
            crossfade.to_scale as f32,
            crossfade.t as f32,
            0.0,
        ];
        let bytes: Vec<u8> = values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        queue.write_buffer(&self.uniform, 0, &bytes);
    }
}
