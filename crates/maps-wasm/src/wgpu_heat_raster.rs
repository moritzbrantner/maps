//! Prepared heat/scalar pixels in the existing application painter-order pass (#171).
//! Projection and raster semantics belong to Maps; this module only uploads and draws.
use super::wgpu_geometry::WgpuApplicationFrame;
use std::collections::HashMap;

struct Texture {
    _texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
}

pub(super) struct HeatRasterGpu {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    textures: HashMap<u32, Texture>,
    vertices: Option<wgpu::Buffer>,
    capacity: u64,
    draws: Vec<(u32, std::ops::Range<u32>)>,
}

impl HeatRasterGpu {
    pub(super) fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps heat raster texture"),
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
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Maps heat raster shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/heat_raster.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Maps heat raster pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Maps heat raster pipeline"), layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[Some(wgpu::VertexBufferLayout { array_stride: 20, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32] })] },
            primitive: wgpu::PrimitiveState::default(), depth_stencil: super::wgpu_base_map::ignored_stencil(), multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_main"), compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })] }), multiview_mask: None, cache: None,
        });
        Self {
            pipeline,
            layout,
            sampler,
            textures: HashMap::new(),
            vertices: None,
            capacity: 0,
            draws: Vec::new(),
        }
    }

    pub(super) fn upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        id: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), &'static str> {
        if width == 0
            || height == 0
            || u64::from(width) * u64::from(height) * 4 != rgba.len() as u64
            || width > device.limits().max_texture_dimension_2d
            || height > device.limits().max_texture_dimension_2d
        {
            return Err("invalid heat raster pixels");
        }
        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Maps heat raster"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
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
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            size,
        );
        let view = texture.create_view(&Default::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps heat raster bind group"),
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
        self.textures.insert(
            id,
            Texture {
                _texture: texture,
                bind_group,
            },
        );
        Ok(())
    }

    pub(super) fn evict(&mut self, id: u32) {
        self.textures.remove(&id);
    }

    pub(super) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frame: Option<&WgpuApplicationFrame>,
    ) -> Result<u64, &'static str> {
        self.draws.clear();
        let mut bytes = Vec::new();
        if let Some(frame) = frame {
            for raster in &frame.rasters {
                if !raster.vertices.len().is_multiple_of(12)
                    || !raster.opacity.is_finite()
                    || raster.vertices.iter().any(|v| !v.is_finite())
                    || frame.width <= 0.0
                    || frame.height <= 0.0
                {
                    return Err("invalid heat raster mesh");
                }
                let first = (bytes.len() / 20) as u32;
                for vertex in raster.vertices.as_chunks::<4>().0 {
                    for value in [
                        (2.0 * vertex[0] / frame.width - 1.0) as f32,
                        (1.0 - 2.0 * vertex[1] / frame.height) as f32,
                        vertex[2] as f32,
                        vertex[3] as f32,
                        raster.opacity.clamp(0.0, 1.0) as f32,
                    ] {
                        bytes.extend_from_slice(&value.to_le_bytes());
                    }
                }
                self.draws
                    .push((raster.id, first..(bytes.len() / 20) as u32));
            }
        }
        let size = bytes.len() as u64;
        if size > self.capacity {
            self.capacity = size.next_power_of_two().max(4096);
            self.vertices = Some(device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Maps heat raster mesh"),
                size: self.capacity,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::VERTEX,
                mapped_at_creation: false,
            }));
        }
        if size > 0 {
            queue.write_buffer(self.vertices.as_ref().unwrap(), 0, &bytes);
        }
        Ok(size)
    }

    pub(super) fn draw(&self, pass: &mut wgpu::RenderPass<'_>, index: u32) -> u32 {
        let Some((id, range)) = self.draws.get(index as usize) else {
            return 0;
        };
        let (Some(texture), Some(vertices)) = (self.textures.get(id), &self.vertices) else {
            return 0;
        };
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &texture.bind_group, &[]);
        pass.set_vertex_buffer(0, vertices.slice(..));
        pass.draw(range.clone(), 0..1);
        1
    }
}
