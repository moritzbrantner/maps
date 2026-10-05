//! Shared retained-geometry module of the Maps wgpu backend.
//!
//! One mechanism for geometry that stays on the GPU across camera frames:
//!
//! - [`RetainedSet`] owns retained GPU buffers by key (a vector tile, or for #155 a point
//!   frame) and is the single place where they are uploaded, replaced and evicted;
//! - [`FrameUniforms`] writes one [`FRAME_UNIFORM_SIZE`] uniform per drawn frame into a
//!   dynamic-offset buffer that grows on demand; camera motion only rewrites these;
//! - frame placement and rebasing are the target-independent `retained_frame` math.
//!
//! Rust (`maps-core`) still owns decoding, lowering and tessellation; consumers hand this
//! module finished bytes. It holds no camera state and no scene graph: every frame the
//! consumer passes the Rust camera's view-projection and the frames' local placements.
//!
//! A consumer binds [`FrameUniforms::layout`] as its bind group 0 and declares
//! `@group(0) @binding(0) var<uniform> frame: RetainedFrame;` with
//! `struct RetainedFrame { matrix: mat4x4<f32>, surface: vec4<f32> }`, then draws each
//! retained entry with `pass.set_bind_group(0, uniforms.bind_group(), &[offset])`.

use std::collections::HashMap;
use std::hash::Hash;

use crate::retained_frame::{FRAME_UNIFORM_SIZE, LocalFrame, pack_frame_uniforms};

const INITIAL_FRAME_CAPACITY: u64 = 16;

/// GPU bytes held by one retained entry, for observability.
pub(crate) trait RetainedResource {
    fn byte_size(&self) -> u64;
}

/// Uploads `bytes` into a new GPU buffer; empty input retains nothing.
pub(crate) fn upload_retained_buffer(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    usage: wgpu::BufferUsages,
    bytes: &[u8],
) -> Option<wgpu::Buffer> {
    (!bytes.is_empty()).then(|| {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: bytes.len() as u64,
            usage: usage | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        queue.write_buffer(&buffer, 0, bytes);
        buffer
    })
}

/// Total size of the buffers that an entry actually retains.
pub(crate) fn retained_bytes<'a>(
    buffers: impl IntoIterator<Item = &'a Option<wgpu::Buffer>>,
) -> u64 {
    buffers.into_iter().flatten().map(wgpu::Buffer::size).sum()
}

/// Retained GPU entries by key. Replacing or evicting an entry drops its buffers.
pub(crate) struct RetainedSet<K, V> {
    entries: HashMap<K, V>,
}

impl<K: Eq + Hash, V: RetainedResource> RetainedSet<K, V> {
    pub(crate) fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub(crate) fn insert(&mut self, key: K, entry: V) {
        self.entries.insert(key, entry);
    }

    pub(crate) fn evict(&mut self, key: &K) {
        self.entries.remove(key);
    }

    pub(crate) fn get(&self, key: &K) -> Option<&V> {
        self.entries.get(key)
    }

    pub(crate) fn contains(&self, key: &K) -> bool {
        self.entries.contains_key(key)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.values()
    }

    pub(crate) fn byte_size(&self) -> u64 {
        self.entries.values().map(RetainedResource::byte_size).sum()
    }
}

/// Per-frame uniforms of retained geometry, bound with a dynamic offset per frame.
pub(crate) struct FrameUniforms {
    layout: wgpu::BindGroupLayout,
    buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    capacity: u64,
    stride: u64,
    scratch: Vec<u8>,
}

impl FrameUniforms {
    pub(crate) fn new(device: &wgpu::Device, label: &str) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(label),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(FRAME_UNIFORM_SIZE),
                },
                count: None,
            }],
        });
        let stride = FRAME_UNIFORM_SIZE.next_multiple_of(u64::from(
            device.limits().min_uniform_buffer_offset_alignment,
        ));
        let buffer = create_frame_uniform_buffer(device, INITIAL_FRAME_CAPACITY * stride);
        let bind_group = create_frame_bind_group(device, &layout, &buffer);
        Self {
            layout,
            buffer,
            bind_group,
            capacity: INITIAL_FRAME_CAPACITY,
            stride,
            scratch: Vec::new(),
        }
    }

    pub(crate) fn layout(&self) -> &wgpu::BindGroupLayout {
        &self.layout
    }

    pub(crate) fn bind_group(&self) -> &wgpu::BindGroup {
        &self.bind_group
    }

    /// Writes this frame's uniforms and returns each drawable frame's dynamic offset.
    /// `surface` is (surface width px, surface height px, pixel ratio, 0).
    pub(crate) fn write<K>(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frames: impl IntoIterator<Item = (K, LocalFrame)>,
        view_projection: [f32; 16],
        surface: [f32; 4],
    ) -> Vec<(K, u32)> {
        let offsets = pack_frame_uniforms(
            frames,
            view_projection,
            surface,
            self.stride,
            &mut self.scratch,
        );
        let count = offsets.len() as u64;
        if count > self.capacity {
            let capacity = count.next_power_of_two();
            self.buffer = create_frame_uniform_buffer(device, capacity * self.stride);
            self.bind_group = create_frame_bind_group(device, &self.layout, &self.buffer);
            self.capacity = capacity;
        }
        if !self.scratch.is_empty() {
            queue.write_buffer(&self.buffer, 0, &self.scratch);
        }
        offsets
    }
}

fn create_frame_uniform_buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Maps retained frame uniforms"),
        size,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn create_frame_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Maps retained frame bind group"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                buffer,
                offset: 0,
                size: wgpu::BufferSize::new(FRAME_UNIFORM_SIZE),
            }),
        }],
    })
}
