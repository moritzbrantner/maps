//! The dash atlas texture (#322): `maps_core::LineAtlas` as an R8 texture with MapLibre's
//! linear filtering and repeat wrapping, bound as group 1 of the retained shape pipelines.

use maps_core::{LINE_ATLAS_HEIGHT, LINE_ATLAS_WIDTH, LineAtlas};

pub(crate) struct DashAtlasGpu {
    pub(crate) layout: wgpu::BindGroupLayout,
    texture: wgpu::Texture,
    pub(crate) bind_group: wgpu::BindGroup,
    version: Option<u32>,
}

const SIZE: wgpu::Extent3d = wgpu::Extent3d {
    width: LINE_ATLAS_WIDTH,
    height: LINE_ATLAS_HEIGHT,
    depth_or_array_layers: 1,
};

impl DashAtlasGpu {
    pub(crate) fn new(device: &wgpu::Device) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps dash atlas layout"),
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
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Maps dash atlas"),
            size: SIZE,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Maps dash atlas sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps dash atlas bind group"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        Self {
            layout,
            texture,
            bind_group,
            version: None,
        }
    }

    /// Uploads the atlas when it changed since the last upload.
    pub(crate) fn upload(&mut self, queue: &wgpu::Queue, atlas: &LineAtlas) {
        if self.version == Some(atlas.version) {
            return;
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &atlas.data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(LINE_ATLAS_WIDTH),
                rows_per_image: Some(LINE_ATLAS_HEIGHT),
            },
            SIZE,
        );
        self.version = Some(atlas.version);
    }
}
