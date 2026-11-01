//! wgpu side of relief (#324): MapLibre 6.15's hillshade (`draw_hillshade.ts`: a prepare pass
//! per DEM tile, then the shading pass) and terrain (`render_to_texture.ts`,
//! `draw_terrain.ts`: raster and hillshade layers rendered into one 1024² target per terrain
//! tile, then a 128 × 128 DEM-lifted mesh per tile with skirts, depth tested).
//!
//! [`ReliefPlanner`] decides the tiles; this module owns their textures and draws.

use std::collections::{HashMap, HashSet};

use maps_core::TileId;
use maps_core::terrain::{
    CoveredTile, HillshadeLayer, Mat4, ReliefFrame, ReliefPlanner, ReliefStyle, TILE_EXTENT,
    TerrainCamera, TerrainTransform, latitude_of_mercator_y, terrain_tile_matrix,
};
use web_sys::ImageBitmap;

use crate::wgpu_mipmaps::{MipmapGenerator, mip_level_count};

const PREPARE_SHADER: &str = include_str!("shaders/hillshade_prepare.wgsl");
const HILLSHADE_SHADER: &str = include_str!("shaders/hillshade.wgsl");
const TERRAIN_SHADER: &str = include_str!("shaders/terrain.wgsl");

/// Dynamic uniform slot: at least WebGPU's 256-byte offset alignment and the hillshade block.
const SLOT: u64 = 512;
const SLOTS: u64 = 2048;
const MAX_LIGHTS: usize = 8;
/// `RenderToTexture.rttSize`: terrain tile size (2 · 256) times `qualityFactor` 2.
const RTT_SIZE: u32 = 1024;
/// `Terrain.meshSize`.
const MESH_SIZE: u32 = 128;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;
const RTT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// MapLibre's `getLog2WorldWidth` for the wrapping Mercator world.
const LOG2_WORLD_WIDTH: f32 = 25.2562;
/// Relief raster tiles kept beyond the current frame's.
const RASTER_CACHE_TILES: usize = 256;
/// `extTextureFilterAnisotropicMax` of the WebGL contexts MapLibre runs on.
const MAX_ANISOTROPY: u16 = 16;

/// The camera of the next frame, CSS pixels.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ReliefCamera {
    pub(crate) longitude: f64,
    pub(crate) latitude: f64,
    pub(crate) zoom: f64,
    pub(crate) bearing: f64,
    pub(crate) pitch: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

struct DemTexture {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    terrain_group: wgpu::BindGroup,
    prepared: Option<Prepared>,
    needs_prepare: bool,
}

struct Prepared {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    linear: wgpu::BindGroup,
    nearest: wgpu::BindGroup,
}

struct SampledTexture {
    _texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
}

struct RttTile {
    texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
    fingerprint: Fingerprint,
}

/// MapLibre's `RTTFingerprint` of a terrain tile target, without its zoom: relief paint is
/// constant, so a target drawn at another zoom from the same tiles is the same image.
#[derive(Default, PartialEq)]
struct Fingerprint {
    revision: u64,
    /// `(layer kind, z, x, y)` of every source tile drawn.
    tiles: Vec<(usize, u8, u32, u32)>,
}

/// `RTT_DIFFERENCES`, mildest first.
enum Difference {
    None,
    SourceTiles,
    Revision,
}

impl Fingerprint {
    fn difference(&self, other: &Self) -> Difference {
        if self.revision != other.revision {
            Difference::Revision
        } else if self.tiles != other.tiles {
            Difference::SourceTiles
        } else {
            Difference::None
        }
    }
}

/// A terrain tile draw: uniform offset, tile and its DEM texture key.
type TerrainDraw = (u32, CoveredTile, Option<(usize, TileId)>);

/// Draws the main pass makes for relief this frame.
#[derive(Default)]
pub(crate) struct ReliefDraws {
    /// `(uniform offset, terrain tile)` per terrain tile; non-empty means terrain is drawn.
    terrain: Vec<TerrainDraw>,
    /// `(uniform offset, source, DEM tile, nearest)` hillshade draws on the flat map.
    hillshade: Vec<(u32, usize, TileId, bool)>,
}

impl ReliefDraws {
    pub(crate) fn has_terrain(&self) -> bool {
        !self.terrain.is_empty()
    }
}

/// Byte writer for 512-byte uniform slots.
struct Slots {
    bytes: Vec<u8>,
}

impl Slots {
    fn push(&mut self, values: &[f32]) -> Option<u32> {
        let offset = self.bytes.len() as u64;
        if offset + SLOT > SLOT * SLOTS {
            return None;
        }
        for value in values {
            self.bytes.extend_from_slice(&value.to_le_bytes());
        }
        self.bytes.resize((offset + SLOT) as usize, 0);
        Some(offset as u32)
    }
}

fn matrix_f32(matrix: Mat4) -> [f32; 16] {
    matrix.map(|value| value as f32)
}

pub(crate) struct ReliefGpu {
    planner: ReliefPlanner,
    camera: Option<ReliefCamera>,
    wanted: Vec<(usize, TileId)>,
    uniforms: wgpu::Buffer,
    uniform_group: wgpu::BindGroup,
    prepare_uniform_group: wgpu::BindGroup,
    dem_layout: wgpu::BindGroupLayout,
    sampled_layout: wgpu::BindGroupLayout,
    linear_sampler: wgpu::Sampler,
    nearest_sampler: wgpu::Sampler,
    raster_sampler: wgpu::Sampler,
    surface_sampler: wgpu::Sampler,
    prepare_pipeline: wgpu::RenderPipeline,
    hillshade_rtt: wgpu::RenderPipeline,
    hillshade_main: wgpu::RenderPipeline,
    raster_rtt: wgpu::RenderPipeline,
    terrain_pipeline: wgpu::RenderPipeline,
    empty_dem_group: wgpu::BindGroup,
    dems: HashMap<(usize, TileId), DemTexture>,
    rasters: HashMap<TileId, SampledTexture>,
    rtts: HashMap<CoveredTile, RttTile>,
    mesh_vertices: wgpu::Buffer,
    mesh_indices: wgpu::Buffer,
    mesh_index_count: u32,
    depth: Option<(wgpu::TextureView, u32, u32)>,
    /// Bumped whenever a relief texture changes, so terrain targets redraw.
    revision: u64,
    /// Whether this frame already redrew a target for a source-tile change.
    stale_redrawn: bool,
    /// Targets left stale this frame; the host renders another frame.
    follow_up: bool,
}

impl ReliefGpu {
    pub(crate) fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface_format: wgpu::TextureFormat,
        blend: wgpu::BlendState,
        main_stencil: Option<wgpu::DepthStencilState>,
    ) -> Self {
        let uniform_entry = |binding, dynamic| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: dynamic,
                min_binding_size: wgpu::BufferSize::new(SLOT),
            },
            count: None,
        };
        let texture_entry = |binding, filterable| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let uniform_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps relief uniforms"),
            entries: &[uniform_entry(0, true)],
        });
        let prepare_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps hillshade prepare uniforms"),
            entries: &[uniform_entry(0, true)],
        });
        let dem_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps DEM texture"),
            entries: &[texture_entry(0, false)],
        });
        let sampled_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Maps relief sampled texture"),
            entries: &[
                texture_entry(0, true),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Maps relief uniform slots"),
            size: SLOT * SLOTS,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let slot_binding = wgpu::BindingResource::Buffer(wgpu::BufferBinding {
            buffer: &uniforms,
            offset: 0,
            size: wgpu::BufferSize::new(SLOT),
        });
        let uniform_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps relief uniforms"),
            layout: &uniform_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: slot_binding.clone(),
            }],
        });
        let prepare_uniform_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps hillshade prepare uniforms"),
            layout: &prepare_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: slot_binding,
            }],
        });
        let sampler = |label, filter, mipmap| {
            device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some(label),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: filter,
                min_filter: filter,
                mipmap_filter: mipmap,
                ..Default::default()
            })
        };
        use wgpu::{FilterMode, MipmapFilterMode};
        let linear_sampler = sampler(
            "Maps hillshade linear",
            FilterMode::Linear,
            MipmapFilterMode::Nearest,
        );
        let nearest_sampler = sampler(
            "Maps hillshade nearest",
            FilterMode::Nearest,
            MipmapFilterMode::Nearest,
        );
        // Raster tiles: `LINEAR` / `LINEAR_MIPMAP_NEAREST`.
        let raster_sampler = sampler(
            "Maps relief raster",
            FilterMode::Linear,
            MipmapFilterMode::Nearest,
        );
        // Terrain targets (`Painter.acquireRTT`): `LINEAR_MIPMAP_LINEAR` at the context's
        // maximum anisotropy, which WebGPU samplers take directly with linear mip filtering.
        let surface_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Maps terrain surface"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: FilterMode::Linear,
            min_filter: FilterMode::Linear,
            mipmap_filter: MipmapFilterMode::Linear,
            anisotropy_clamp: MAX_ANISOTROPY,
            ..Default::default()
        });

        let module = |label, source: &str| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            })
        };
        let prepare_shader = module("Maps hillshade prepare shader", PREPARE_SHADER);
        let hillshade_shader = module("Maps hillshade shader", HILLSHADE_SHADER);
        let terrain_shader = module("Maps terrain shader", TERRAIN_SHADER);

        struct Spec<'a> {
            label: &'a str,
            shader: &'a wgpu::ShaderModule,
            vertex: &'a str,
            fragment: &'a str,
            layouts: &'a [&'a wgpu::BindGroupLayout],
            buffers: &'a [Option<wgpu::VertexBufferLayout<'a>>],
            format: wgpu::TextureFormat,
            blend: Option<wgpu::BlendState>,
            depth: Option<wgpu::DepthStencilState>,
        }
        let pipeline = |spec: Spec<'_>| {
            let layouts: Vec<Option<&wgpu::BindGroupLayout>> =
                spec.layouts.iter().map(|layout| Some(*layout)).collect();
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(spec.label),
                bind_group_layouts: &layouts,
                immediate_size: 0,
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(spec.label),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: spec.shader,
                    entry_point: Some(spec.vertex),
                    compilation_options: Default::default(),
                    buffers: spec.buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: spec.depth,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: spec.shader,
                    entry_point: Some(spec.fragment),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: spec.format,
                        blend: spec.blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let prepare_pipeline = pipeline(Spec {
            label: "Maps hillshade prepare pipeline",
            shader: &prepare_shader,
            vertex: "vs_main",
            fragment: "fs_main",
            layouts: &[&prepare_layout, &dem_layout],
            buffers: &[],
            format: RTT_FORMAT,
            blend: None,
            depth: None,
        });
        let hillshade_rtt = pipeline(Spec {
            label: "Maps hillshade terrain-target pipeline",
            shader: &hillshade_shader,
            vertex: "vs_main",
            fragment: "fs_main",
            layouts: &[&uniform_layout, &sampled_layout],
            buffers: &[],
            format: RTT_FORMAT,
            blend: Some(blend),
            depth: None,
        });
        let hillshade_main = pipeline(Spec {
            label: "Maps hillshade pipeline",
            shader: &hillshade_shader,
            vertex: "vs_main",
            fragment: "fs_main",
            layouts: &[&uniform_layout, &sampled_layout],
            buffers: &[],
            format: surface_format,
            blend: Some(blend),
            depth: main_stencil,
        });
        let raster_rtt = pipeline(Spec {
            label: "Maps terrain-target raster pipeline",
            shader: &terrain_shader,
            vertex: "vs_raster",
            fragment: "fs_raster",
            layouts: &[&uniform_layout, &sampled_layout],
            buffers: &[],
            format: RTT_FORMAT,
            blend: Some(blend),
            depth: None,
        });
        let terrain_pipeline = pipeline(Spec {
            label: "Maps terrain pipeline",
            shader: &terrain_shader,
            vertex: "vs_main",
            fragment: "fs_main",
            layouts: &[&uniform_layout, &dem_layout, &sampled_layout],
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 0,
                    shader_location: 0,
                }],
            })],
            format: surface_format,
            blend: Some(blend),
            depth: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
        });

        let empty = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Maps empty DEM"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: RTT_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let empty_view = empty.create_view(&wgpu::TextureViewDescriptor::default());
        let empty_dem_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Maps empty DEM"),
            layout: &dem_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&empty_view),
            }],
        });

        let (vertices, indices) = terrain_mesh();
        let buffer = |label, bytes: &[u8], usage| {
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: bytes.len() as u64,
                usage: usage | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&buffer, 0, bytes);
            buffer
        };
        let vertex_bytes: Vec<u8> = vertices
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let index_bytes: Vec<u8> = indices
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let mesh_vertices = buffer(
            "Maps terrain mesh",
            &vertex_bytes,
            wgpu::BufferUsages::VERTEX,
        );
        let mesh_indices = buffer(
            "Maps terrain mesh indices",
            &index_bytes,
            wgpu::BufferUsages::INDEX,
        );

        Self {
            planner: ReliefPlanner::default(),
            camera: None,
            wanted: Vec::new(),
            uniforms,
            uniform_group,
            prepare_uniform_group,
            dem_layout,
            sampled_layout,
            linear_sampler,
            nearest_sampler,
            raster_sampler,
            surface_sampler,
            prepare_pipeline,
            hillshade_rtt,
            hillshade_main,
            raster_rtt,
            terrain_pipeline,
            empty_dem_group,
            dems: HashMap::new(),
            rasters: HashMap::new(),
            rtts: HashMap::new(),
            mesh_vertices,
            mesh_indices,
            mesh_index_count: indices.len() as u32,
            depth: None,
            revision: 0,
            stale_redrawn: false,
            follow_up: false,
        }
    }

    pub(crate) fn set_style(&mut self, json: &str) -> Result<(), String> {
        let style = if json.is_empty() {
            ReliefStyle::default()
        } else {
            ReliefStyle::parse(json)?
        };
        if &style == self.planner.style() {
            return Ok(());
        }
        self.planner.set_style(style);
        self.dems.clear();
        self.rasters.clear();
        self.rtts.clear();
        self.wanted.clear();
        self.revision += 1;
        Ok(())
    }

    pub(crate) fn is_active(&self) -> bool {
        self.planner.is_active()
    }

    /// Whether terrain targets were left stale for this frame, so the host renders again.
    pub(crate) fn needs_follow_up(&self) -> bool {
        self.follow_up
    }

    pub(crate) fn set_camera(&mut self, camera: ReliefCamera) {
        self.camera = Some(camera);
    }

    /// Tiles the last frame wanted and did not have, as `"source|z|x|y"`.
    pub(crate) fn requests(&self) -> Vec<String> {
        let sources = &self.planner.style().sources;
        self.wanted
            .iter()
            .map(|(source, tile)| {
                format!("{}|{}|{}|{}", sources[*source].id, tile.z, tile.x, tile.y)
            })
            .collect()
    }

    fn source_index(&self, id: &str) -> Option<usize> {
        self.planner
            .style()
            .sources
            .iter()
            .position(|source| source.id == id)
    }

    pub(crate) fn add_dem_tile(
        &mut self,
        source: &str,
        tile: TileId,
        size: usize,
        rgba: &[u8],
    ) -> Result<(), String> {
        let index = self.source_index(source).ok_or("unknown relief source")?;
        self.planner.add_dem_tile(index, tile, size, rgba)
    }

    pub(crate) fn add_raster_tile(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        mipmaps: &MipmapGenerator,
        tile: TileId,
        image: ImageBitmap,
    ) {
        let (width, height) = (image.width().max(1), image.height().max(1));
        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Maps relief raster tile"),
            size,
            mip_level_count: mip_level_count(width, height),
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: RTT_FORMAT,
            usage: wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        queue.copy_external_image_to_texture(
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
            size,
        );
        mipmaps.generate(device, queue, &texture);
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.sampled_group(device, &view, &self.raster_sampler);
        self.rasters.insert(
            tile,
            SampledTexture {
                _texture: texture,
                bind_group,
            },
        );
        self.planner.set_raster_loaded(tile, true);
        self.revision += 1;
    }

    fn sampled_group(
        &self,
        device: &wgpu::Device,
        view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.sampled_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }

    /// Plans the frame, uploads changed DEM tiles and renders the hillshade prepare passes and
    /// terrain tile targets. Returns the main-pass draws.
    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        mipmaps: &MipmapGenerator,
        surface: (u32, u32),
        margin: f64,
    ) -> ReliefDraws {
        let Some(camera) = self.camera.filter(|_| self.planner.is_active()) else {
            return ReliefDraws::default();
        };
        let Some(frame) = self.planner.plan(TerrainCamera {
            longitude: camera.longitude,
            latitude: camera.latitude,
            zoom: camera.zoom,
            bearing: camera.bearing,
            pitch: camera.pitch,
            width: camera.width,
            height: camera.height,
            elevation: 0.0,
            min_elevation_for_current_tile: 0.0,
        }) else {
            return ReliefDraws::default();
        };
        self.wanted.clone_from(&frame.wanted);
        self.upload_dems(device, queue);
        self.prune_rasters(&frame);

        // The viewport image lands in the center of the margin-grown surface.
        let clip_scale = [
            camera.width / (camera.width + 2.0 * margin),
            camera.height / (camera.height + 2.0 * margin),
        ];
        let to_surface = |matrix: Mat4| {
            let mut matrix = TerrainTransform::webgpu_clip(matrix);
            for column in 0..4 {
                matrix[column * 4] *= clip_scale[0];
                matrix[column * 4 + 1] *= clip_scale[1];
            }
            matrix
        };

        let mut slots = Slots { bytes: Vec::new() };
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        self.encode_prepares(device, &frame, &mut slots, &mut encoder);

        let mut draws = ReliefDraws::default();
        let transform = &frame.transform;
        let mut redrawn = Vec::new();
        self.stale_redrawn = false;
        self.follow_up = false;
        if let Some(terrain) = self.planner.style().terrain {
            let exaggeration = terrain.exaggeration;
            let skirt = 40_075_016.685_578_5 / 2_f64.powf(camera.zoom.max(0.0)) / 5.0;
            for plan in &frame.terrain {
                let tile = plan.tile;
                if self.render_target(device, &frame, tile, &mut slots, &mut encoder, camera) {
                    redrawn.push(tile);
                }
                let dem = plan.dem.and_then(|dem| {
                    self.dems
                        .contains_key(&(terrain.source, dem))
                        .then_some((terrain.source, dem))
                });
                let (dim, unpack) = dem
                    .and_then(|(source, tile)| self.planner.dem(source, tile))
                    .map_or((1.0, [0.0; 4]), |dem| {
                        (dem.dim() as f64, dem.unpack_vector())
                    });
                let matrix =
                    to_surface(transform.tile_pos_matrix(tile.z, tile.x, tile.y, tile.wrap, false));
                let mut values = matrix_f32(matrix).to_vec();
                values.extend(
                    [plan.dem_scale, plan.dem_offset[0], plan.dem_offset[1], dim].map(|v| v as f32),
                );
                values.extend(unpack.map(|v| v as f32));
                values.extend(
                    [
                        exaggeration,
                        skirt,
                        if dem.is_some() { 1.0 } else { 0.0 },
                        0.0,
                    ]
                    .map(|v| v as f32),
                );
                if let Some(offset) = slots.push(&values) {
                    draws.terrain.push((offset, tile, dem));
                }
            }
            self.rtts
                .retain(|tile, _| frame.terrain.iter().any(|plan| plan.tile == *tile));
        } else {
            for (layer, tiles) in self.planner.style().hillshade.iter().zip(&frame.hillshade) {
                for tile in tiles {
                    let matrix = to_surface(
                        transform.tile_pos_matrix(tile.z, tile.x, tile.y, tile.wrap, true),
                    );
                    let Some(id) = TileId::new(tile.z, tile.x, tile.y) else {
                        continue;
                    };
                    if !self
                        .dems
                        .get(&(layer.source, id))
                        .is_some_and(|dem| dem.prepared.is_some())
                    {
                        continue;
                    }
                    let values = hillshade_uniform(layer, matrix, *tile, camera.bearing);
                    if let Some(offset) = slots.push(&values) {
                        draws
                            .hillshade
                            .push((offset, layer.source, id, layer.nearest));
                    }
                }
            }
        }

        if !slots.bytes.is_empty() {
            queue.write_buffer(&self.uniforms, 0, &slots.bytes);
        }
        queue.submit([encoder.finish()]);
        for tile in redrawn {
            if let Some(target) = self.rtts.get(&tile) {
                mipmaps.generate(device, queue, &target.texture);
            }
        }
        if draws.has_terrain() {
            self.ensure_depth(device, surface);
        }
        draws
    }

    fn upload_dems(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        for (source, tile) in self.planner.take_dirty() {
            let Some(dem) = self.planner.dem(source, tile) else {
                continue;
            };
            let stride = dem.stride() as u32;
            let size = wgpu::Extent3d {
                width: stride,
                height: stride,
                depth_or_array_layers: 1,
            };
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Maps DEM tile"),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: RTT_FORMAT,
                usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let bytes: Vec<u8> = dem.pixels().iter().flatten().copied().collect();
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &bytes,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride * 4),
                    rows_per_image: Some(stride),
                },
                size,
            );
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let terrain_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.dem_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                }],
            });
            let prepared = self
                .dems
                .remove(&(source, tile))
                .and_then(|old| old.prepared);
            self.dems.insert(
                (source, tile),
                DemTexture {
                    _texture: texture,
                    view,
                    terrain_group,
                    prepared,
                    needs_prepare: true,
                },
            );
            self.revision += 1;
        }
        let planner = &self.planner;
        self.dems
            .retain(|(source, tile), _| planner.dem(*source, *tile).is_some());
    }

    fn prune_rasters(&mut self, frame: &ReliefFrame) {
        if self.rasters.len() <= RASTER_CACHE_TILES {
            return;
        }
        let keep: HashSet<TileId> = frame
            .raster
            .iter()
            .filter_map(|tile| TileId::new(tile.z, tile.x, tile.y))
            .collect();
        let planner = &mut self.planner;
        self.rasters.retain(|tile, _| {
            let kept = keep.contains(tile);
            if !kept {
                planner.set_raster_loaded(*tile, false);
            }
            kept
        });
    }

    /// The hillshade prepare pass of every DEM tile a hillshade layer draws whose pixels changed.
    fn encode_prepares(
        &mut self,
        device: &wgpu::Device,
        frame: &ReliefFrame,
        slots: &mut Slots,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let style = self.planner.style();
        for (layer, tiles) in style.hillshade.iter().zip(&frame.hillshade) {
            for tile in tiles {
                let Some(id) = TileId::new(tile.z, tile.x, tile.y) else {
                    continue;
                };
                let key = (layer.source, id);
                let Some(dem) = self.planner.dem(layer.source, id) else {
                    continue;
                };
                let (stride, unpack) = (dem.stride(), dem.unpack_vector());
                let Some(texture) = self.dems.get(&key) else {
                    continue;
                };
                if !texture.needs_prepare {
                    continue;
                }
                let size = (dem.dim() + 2) as u32;
                let mut values: Vec<f32> = unpack.map(|v| v as f32).to_vec();
                values.extend([stride as f32, f32::from(tile.z), LOG2_WORLD_WIDTH, 0.0]);
                let Some(offset) = slots.push(&values) else {
                    continue;
                };
                let prepared = match self.dems.get_mut(&key).and_then(|dem| dem.prepared.take()) {
                    Some(prepared) => prepared,
                    None => self.prepared_target(device, size),
                };
                let dem_view = &self.dems[&key].view;
                let dem_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.dem_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(dem_view),
                    }],
                });
                {
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: None,
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &prepared.view,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
                    pass.set_pipeline(&self.prepare_pipeline);
                    pass.set_bind_group(0, &self.prepare_uniform_group, &[offset]);
                    pass.set_bind_group(1, &dem_group, &[]);
                    pass.draw(0..3, 0..1);
                }
                if let Some(dem) = self.dems.get_mut(&key) {
                    dem.prepared = Some(prepared);
                    dem.needs_prepare = false;
                }
                self.revision += 1;
            }
        }
    }

    fn prepared_target(&self, device: &wgpu::Device, size: u32) -> Prepared {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Maps hillshade prepared slopes"),
            size: wgpu::Extent3d {
                width: size,
                height: size,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: RTT_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let linear = self.sampled_group(device, &view, &self.linear_sampler);
        let nearest = self.sampled_group(device, &view, &self.nearest_sampler);
        Prepared {
            _texture: texture,
            view,
            linear,
            nearest,
        }
    }

    /// Renders a terrain tile's target when its contents changed (`RenderToTexture.renderLayer`):
    /// the raster layer's tiles, then each hillshade layer's. Returns whether it rendered.
    fn render_target(
        &mut self,
        device: &wgpu::Device,
        frame: &ReliefFrame,
        terrain: CoveredTile,
        slots: &mut Slots,
        encoder: &mut wgpu::CommandEncoder,
        camera: ReliefCamera,
    ) -> bool {
        let bearing = camera.bearing;
        // (draw kind, tile, matrix): 0 raster, 1 + layer index hillshade.
        let mut contents: Vec<(usize, CoveredTile, Mat4)> = Vec::new();
        for tile in &frame.raster {
            let Some(id) = TileId::new(tile.z, tile.x, tile.y) else {
                continue;
            };
            if !self.rasters.contains_key(&id) {
                continue;
            }
            if let Some(matrix) = terrain_tile_matrix(*tile, terrain) {
                contents.push((0, *tile, matrix));
            }
        }
        for (index, tiles) in frame.hillshade.iter().enumerate() {
            for tile in tiles {
                if let Some(matrix) = terrain_tile_matrix(*tile, terrain) {
                    contents.push((index + 1, *tile, matrix));
                }
            }
        }
        // A rotated camera keeps the target, so viewport-anchored hillshade keeps the bearing it
        // was rendered at, as in MapLibre.
        let fingerprint = Fingerprint {
            revision: self.revision,
            tiles: contents
                .iter()
                .map(|(kind, tile, _)| (*kind, tile.z, tile.x, tile.y))
                .collect(),
        };
        // `RenderToTexture.prepareForRender`: one stale target per frame redraws for a
        // source-tile change, the rest follow in later frames; a revision redraws at once.
        if let Some(target) = self.rtts.get(&terrain) {
            match fingerprint.difference(&target.fingerprint) {
                Difference::None => return false,
                Difference::SourceTiles if self.stale_redrawn => {
                    self.follow_up = true;
                    return false;
                }
                Difference::SourceTiles => self.stale_redrawn = true,
                Difference::Revision => {}
            }
        }

        let style = self.planner.style();
        let mut draws = Vec::new();
        for (kind, tile, matrix) in &contents {
            let matrix = TerrainTransform::webgpu_clip(*matrix);
            let Some(id) = TileId::new(tile.z, tile.x, tile.y) else {
                continue;
            };
            if *kind == 0 {
                if let Some(offset) = slots.push(&matrix_f32(matrix)) {
                    draws.push((offset, None, id));
                }
            } else {
                let layer = &style.hillshade[kind - 1];
                if !self
                    .dems
                    .get(&(layer.source, id))
                    .is_some_and(|dem| dem.prepared.is_some())
                {
                    continue;
                }
                let values = hillshade_uniform(layer, matrix, *tile, bearing);
                if let Some(offset) = slots.push(&values) {
                    draws.push((offset, Some((layer.source, layer.nearest)), id));
                }
            }
        }

        let target = match self.rtts.remove(&terrain) {
            Some(target) => target,
            None => {
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Maps terrain tile target"),
                    size: wgpu::Extent3d {
                        width: RTT_SIZE,
                        height: RTT_SIZE,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: mip_level_count(RTT_SIZE, RTT_SIZE),
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: RTT_FORMAT,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                });
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                let bind_group = self.sampled_group(device, &view, &self.surface_sampler);
                RttTile {
                    texture,
                    bind_group,
                    fingerprint: Fingerprint::default(),
                }
            }
        };
        let level0 = target.texture.create_view(&wgpu::TextureViewDescriptor {
            label: None,
            base_mip_level: 0,
            mip_level_count: Some(1),
            ..Default::default()
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &level0,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            for (offset, hillshade, id) in &draws {
                match hillshade {
                    None => {
                        let Some(raster) = self.rasters.get(id) else {
                            continue;
                        };
                        pass.set_pipeline(&self.raster_rtt);
                        pass.set_bind_group(0, &self.uniform_group, &[*offset]);
                        pass.set_bind_group(1, &raster.bind_group, &[]);
                    }
                    Some((source, nearest)) => {
                        let Some(prepared) = self
                            .dems
                            .get(&(*source, *id))
                            .and_then(|dem| dem.prepared.as_ref())
                        else {
                            continue;
                        };
                        pass.set_pipeline(&self.hillshade_rtt);
                        pass.set_bind_group(0, &self.uniform_group, &[*offset]);
                        pass.set_bind_group(
                            1,
                            if *nearest {
                                &prepared.nearest
                            } else {
                                &prepared.linear
                            },
                            &[],
                        );
                    }
                }
                pass.draw(0..6, 0..1);
            }
        }
        self.rtts.insert(
            terrain,
            RttTile {
                fingerprint,
                ..target
            },
        );
        true
    }

    fn ensure_depth(&mut self, device: &wgpu::Device, (width, height): (u32, u32)) {
        if self
            .depth
            .as_ref()
            .is_some_and(|(_, w, h)| (*w, *h) == (width, height))
        {
            return;
        }
        let view = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("Maps terrain depth"),
                size: wgpu::Extent3d {
                    width: width.max(1),
                    height: height.max(1),
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: DEPTH_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default());
        self.depth = Some((view, width, height));
    }

    /// Draws the terrain tiles into the surface in their own pass (color cleared to
    /// `clear`, depth tested). Returns the number of tiles drawn.
    pub(crate) fn draw_terrain(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        clear: wgpu::Color,
        draws: &ReliefDraws,
        scissor: Option<(u32, u32, u32, u32)>,
    ) -> u32 {
        let Some((depth, _, _)) = &self.depth else {
            return 0;
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Discard,
                }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        if let Some((x, y, width, height)) = scissor {
            pass.set_scissor_rect(x, y, width, height);
        }
        pass.set_pipeline(&self.terrain_pipeline);
        pass.set_vertex_buffer(0, self.mesh_vertices.slice(..));
        pass.set_index_buffer(self.mesh_indices.slice(..), wgpu::IndexFormat::Uint32);
        let mut drawn = 0;
        for (offset, tile, dem) in &draws.terrain {
            let Some(target) = self.rtts.get(tile) else {
                continue;
            };
            let dem_group = dem
                .and_then(|key| self.dems.get(&key))
                .map_or(&self.empty_dem_group, |dem| &dem.terrain_group);
            pass.set_bind_group(0, &self.uniform_group, &[*offset]);
            pass.set_bind_group(1, dem_group, &[]);
            pass.set_bind_group(2, &target.bind_group, &[]);
            pass.draw_indexed(0..self.mesh_index_count, 0, 0..1);
            drawn += 1;
        }
        drawn
    }

    /// Draws flat-map hillshade tiles in the main pass. Returns the draw count.
    pub(crate) fn draw_hillshade(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        draws: &ReliefDraws,
    ) -> u32 {
        let mut drawn = 0;
        for (offset, source, tile, nearest) in &draws.hillshade {
            let Some(prepared) = self
                .dems
                .get(&(*source, *tile))
                .and_then(|dem| dem.prepared.as_ref())
            else {
                continue;
            };
            pass.set_pipeline(&self.hillshade_main);
            pass.set_bind_group(0, &self.uniform_group, &[*offset]);
            pass.set_bind_group(
                1,
                if *nearest {
                    &prepared.nearest
                } else {
                    &prepared.linear
                },
                &[],
            );
            pass.draw(0..6, 0..1);
            drawn += 1;
        }
        drawn
    }
}

/// `hillshadeUniformValues`: matrix, tile latitude range, exaggeration, method, accent and the
/// lights (direction turned by the bearing when anchored to the viewport).
fn hillshade_uniform(
    layer: &HillshadeLayer,
    matrix: Mat4,
    tile: CoveredTile,
    bearing: f64,
) -> Vec<f32> {
    let tiles = f64::from(1_u32 << tile.z);
    let north = latitude_of_mercator_y(f64::from(tile.y) / tiles);
    let south = latitude_of_mercator_y(f64::from(tile.y + 1) / tiles);
    let mut values = matrix_f32(matrix).to_vec();
    values.extend(
        [
            north,
            south,
            layer.exaggeration,
            f64::from(layer.method as u8),
        ]
        .map(|v| v as f32),
    );
    values.extend(layer.accent);
    let count = layer.lights.len().min(MAX_LIGHTS);
    values.extend([count as f32, 0.0, 0.0, 0.0]);
    let rotation = if layer.viewport_anchor {
        bearing.to_radians()
    } else {
        0.0
    };
    for index in 0..MAX_LIGHTS {
        let light = layer.lights.get(index.min(count.saturating_sub(1)));
        let (altitude, direction) = light.map_or((0.0, 0.0), |light| {
            (light.altitude, light.direction + rotation)
        });
        values.extend([altitude as f32, direction as f32, 0.0, 0.0]);
    }
    for index in 0..MAX_LIGHTS {
        values.extend(
            layer
                .lights
                .get(index)
                .map_or([0.0; 4], |light| light.shadow),
        );
    }
    for index in 0..MAX_LIGHTS {
        values.extend(
            layer
                .lights
                .get(index)
                .map_or([0.0; 4], |light| light.highlight),
        );
    }
    values
}

/// `Terrain.getTerrainMesh` without poles: a `(MESH_SIZE + 1)²` grid over `0..EXTENT` and
/// skirts (z = 1 vertices hang `skirt` meters below their edge).
fn terrain_mesh() -> (Vec<f32>, Vec<u32>) {
    let n = MESH_SIZE;
    let delta = TILE_EXTENT as f32 / n as f32;
    let extent = TILE_EXTENT as f32;
    let mut vertices: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let vertex = |vertices: &mut Vec<f32>, x: f32, y: f32, z: f32| vertices.extend([x, y, z]);
    for y in 0..=n {
        for x in 0..=n {
            vertex(&mut vertices, x as f32 * delta, y as f32 * delta, 0.0);
        }
    }
    let mut y = 0;
    while y < n * n {
        for x in 0..n {
            indices.extend([x + y, n + x + y + 1, n + x + y + 2]);
            indices.extend([x + y, n + x + y + 2, x + y + 1]);
        }
        y += n + 1;
    }
    let count = |vertices: &Vec<f32>| (vertices.len() / 3) as u32;
    let offset_top = count(&vertices);
    let offset_top_edge = 0;
    let offset_bottom = offset_top + n + 1;
    let offset_bottom_edge = (n + 1) * n;
    for x in 0..=n {
        vertex(&mut vertices, x as f32 * delta, 0.0, 1.0);
    }
    for x in 0..=n {
        vertex(&mut vertices, x as f32 * delta, extent, 1.0);
    }
    for x in 0..n {
        indices.extend([
            offset_bottom_edge + x,
            offset_bottom + x,
            offset_bottom + x + 1,
        ]);
        indices.extend([
            offset_bottom_edge + x,
            offset_bottom + x + 1,
            offset_bottom_edge + x + 1,
        ]);
        indices.extend([offset_top_edge + x, offset_top + x + 1, offset_top + x]);
        indices.extend([
            offset_top_edge + x,
            offset_top_edge + x + 1,
            offset_top + x + 1,
        ]);
    }
    let offset_left = count(&vertices);
    let offset_right = offset_left + (n + 1) * 2;
    for column in [0.0, 1.0] {
        for y in 0..=n {
            for z in [0.0, 1.0] {
                vertex(&mut vertices, column * extent, y as f32 * delta, z);
            }
        }
    }
    let mut y = 0;
    while y < n * 2 {
        indices.extend([offset_left + y, offset_left + y + 1, offset_left + y + 3]);
        indices.extend([offset_left + y, offset_left + y + 3, offset_left + y + 2]);
        indices.extend([offset_right + y, offset_right + y + 3, offset_right + y + 1]);
        indices.extend([offset_right + y, offset_right + y + 2, offset_right + y + 3]);
        y += 2;
    }
    (vertices, indices)
}
