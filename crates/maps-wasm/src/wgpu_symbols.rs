//! wgpu resources for tileset style layers (#321): the SDF glyph pipeline, the glyph atlas
//! texture and the per-frame circle and glyph buffers written by `style_symbols`.

use maps_core::symbol::GlyphAtlas;

use crate::style_symbols::{GLYPH_VERTEX_SIZE, StyleDraw, StyleFrame};

const SYMBOL_SHADER: &str = include_str!("shaders/symbol_sdf.wgsl");
const INITIAL_BUFFER_SIZE: u64 = 4 * 1024;

pub(crate) struct SymbolGpu {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    atlas: Option<(u64, wgpu::BindGroup)>,
    glyphs: wgpu::Buffer,
    glyph_capacity: u64,
    circles: wgpu::Buffer,
    circle_capacity: u64,
    /// Line strip vertices of the visible tiles (#322), replaced when they change.
    lines: wgpu::Buffer,
    line_capacity: u64,
}

/// What line draws need besides their vertices: the retained line pipeline, the tile frame
/// uniforms with each `StyleFrame::line_frames` entry's dynamic offset, and the dash atlas.
pub(crate) struct StyleLines<'a> {
    pub(crate) pipeline: &'a wgpu::RenderPipeline,
    pub(crate) frames: &'a wgpu::BindGroup,
    pub(crate) offsets: &'a [Option<u32>],
    pub(crate) dash_atlas: &'a wgpu::BindGroup,
}

fn vertex_buffer(device: &wgpu::Device, label: &str, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

impl SymbolGpu {
    pub(crate) fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        blend: wgpu::BlendState,
        depth_stencil: Option<wgpu::DepthStencilState>,
    ) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps glyph atlas layout"),
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
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Maps SDF glyph shader"),
            source: wgpu::ShaderSource::Wgsl(SYMBOL_SHADER.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Maps SDF glyph pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let attribute =
            |location: u32, offset: u64, format: wgpu::VertexFormat| wgpu::VertexAttribute {
                format,
                offset,
                shader_location: location,
            };
        let attributes = [
            attribute(0, 0, wgpu::VertexFormat::Float32x2),
            attribute(1, 8, wgpu::VertexFormat::Float32x2),
            attribute(2, 16, wgpu::VertexFormat::Float32x4),
            attribute(3, 32, wgpu::VertexFormat::Float32x4),
            attribute(4, 48, wgpu::VertexFormat::Float32x4),
            attribute(5, 64, wgpu::VertexFormat::Float32x4),
        ];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Maps SDF glyph pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: GLYPH_VERTEX_SIZE,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &attributes,
                })],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(blend),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        // MapLibre samples the glyph atlas with LINEAR / CLAMP_TO_EDGE.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Maps glyph atlas sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self {
            pipeline,
            layout,
            sampler,
            atlas: None,
            glyphs: vertex_buffer(device, "Maps glyph vertices", INITIAL_BUFFER_SIZE),
            glyph_capacity: INITIAL_BUFFER_SIZE,
            circles: vertex_buffer(device, "Maps style circle instances", INITIAL_BUFFER_SIZE),
            circle_capacity: INITIAL_BUFFER_SIZE,
            lines: vertex_buffer(device, "Maps style line vertices", INITIAL_BUFFER_SIZE),
            line_capacity: INITIAL_BUFFER_SIZE,
        }
    }

    /// Uploads the frame's buffers, and the atlas when it was rebuilt.
    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frame: &StyleFrame,
        atlas: &GlyphAtlas,
    ) {
        if let Some(bytes) = frame.line_bytes.as_ref().filter(|bytes| !bytes.is_empty()) {
            let required = bytes.len() as u64;
            if required > self.line_capacity {
                self.line_capacity = required.next_power_of_two().max(INITIAL_BUFFER_SIZE);
                self.lines = vertex_buffer(device, "Maps style line vertices", self.line_capacity);
            }
            queue.write_buffer(&self.lines, 0, bytes);
        }
        if frame.draws.is_empty() {
            return;
        }
        if self.atlas.as_ref().map(|(revision, _)| *revision) != Some(atlas.revision) {
            let size = wgpu::Extent3d {
                width: atlas.width,
                height: atlas.height,
                depth_or_array_layers: 1,
            };
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Maps glyph atlas"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
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
                    bytes_per_row: Some(atlas.width),
                    rows_per_image: Some(atlas.height),
                },
                size,
            );
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Maps glyph atlas bind group"),
                layout: &self.layout,
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
            self.atlas = Some((atlas.revision, bind_group));
        }
        let upload = |buffer: &mut wgpu::Buffer, capacity: &mut u64, data: &[f32], label: &str| {
            if data.is_empty() {
                return;
            }
            let bytes: Vec<u8> = data.iter().flat_map(|value| value.to_le_bytes()).collect();
            let required = bytes.len() as u64;
            if required > *capacity {
                *capacity = required.next_power_of_two().max(INITIAL_BUFFER_SIZE);
                *buffer = vertex_buffer(device, label, *capacity);
            }
            queue.write_buffer(buffer, 0, &bytes);
        };
        upload(
            &mut self.glyphs,
            &mut self.glyph_capacity,
            &frame.glyphs,
            "Maps glyph vertices",
        );
        upload(
            &mut self.circles,
            &mut self.circle_capacity,
            &frame.circles,
            "Maps style circle instances",
        );
    }

    /// Records the frame's style draws in painter order; returns the draw calls.
    pub(crate) fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        draws: &[StyleDraw],
        circle_pipeline: &wgpu::RenderPipeline,
        circle_vertex_count: u32,
        lines: &StyleLines<'_>,
    ) -> u32 {
        let mut calls = 0;
        for draw in draws {
            match *draw {
                StyleDraw::Circles { first, count } => {
                    pass.set_pipeline(circle_pipeline);
                    pass.set_vertex_buffer(0, self.circles.slice(..));
                    pass.draw(0..circle_vertex_count, first..first + count);
                }
                StyleDraw::Lines {
                    frame,
                    first,
                    count,
                } => {
                    let Some(Some(offset)) = lines.offsets.get(frame as usize) else {
                        continue;
                    };
                    pass.set_pipeline(lines.pipeline);
                    pass.set_bind_group(0, lines.frames, &[*offset]);
                    pass.set_bind_group(1, lines.dash_atlas, &[]);
                    pass.set_vertex_buffer(0, self.lines.slice(..));
                    pass.draw(first..first + count, 0..1);
                }
                StyleDraw::Glyphs { first, count } => {
                    let Some((_, atlas)) = &self.atlas else {
                        continue;
                    };
                    pass.set_pipeline(&self.pipeline);
                    pass.set_bind_group(0, atlas, &[]);
                    pass.set_vertex_buffer(0, self.glyphs.slice(..));
                    pass.draw(first..first + count, 0..1);
                }
            }
            calls += 1;
        }
        calls
    }
}
