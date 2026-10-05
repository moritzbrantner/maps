//! Target-independent GPU layout of retained vector basemap buckets.
//!
//! The wgpu backend (wasm32 only) uploads these bytes once per tile through the shared
//! retained-geometry module (`retained_frame`, `wgpu_retained`); keeping the packing here
//! lets native `cargo test` cover it.
#![cfg_attr(
    not(all(
        target_arch = "wasm32",
        target_os = "unknown",
        feature = "wgpu-base-map"
    )),
    allow(dead_code)
)]

use maps_core::{VectorBasemapStyleClass, VectorTileBuckets};

/// Fill vertex: tile-normalized position (2 x f32) and style class (u32).
pub(crate) const FILL_VERTEX_SIZE: u64 = 12;
/// Line vertex: tile-normalized segment start/end (4 x f32) and style class (u32). Each
/// segment is four identical vertices (quad corners come from `vertex_index & 3`) drawn
/// with [`LINE_QUAD_INDICES`]; per-segment instancing of 6-vertex quads is ~45x slower
/// on SwiftShader and wasteful on hardware GPUs.
pub(crate) const LINE_VERTEX_SIZE: u64 = 20;
pub(crate) const LINE_VERTICES_PER_SEGMENT: u32 = 4;
pub(crate) const LINE_QUAD_INDICES: [u32; 6] = [0, 1, 2, 2, 1, 3];
/// Style entry: premultiplied-at-draw RGBA color, then (width CSS px, 0, 0, 0).
pub(crate) const STYLE_ENTRY_FLOATS: usize = 8;
pub(crate) const STYLE_TABLE_SIZE: u64 =
    (VectorBasemapStyleClass::COUNT * STYLE_ENTRY_FLOATS * 4) as u64;

pub(crate) fn fill_vertex_bytes(buckets: &VectorTileBuckets) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(buckets.fill_vertices.len() * FILL_VERTEX_SIZE as usize);
    for vertex in &buckets.fill_vertices {
        bytes.extend_from_slice(&vertex.position[0].to_le_bytes());
        bytes.extend_from_slice(&vertex.position[1].to_le_bytes());
        bytes.extend_from_slice(&(vertex.class as u32).to_le_bytes());
    }
    bytes
}

pub(crate) fn fill_index_bytes(buckets: &VectorTileBuckets) -> Vec<u8> {
    buckets
        .fill_indices
        .iter()
        .flat_map(|index| index.to_le_bytes())
        .collect()
}

pub(crate) fn line_vertex_bytes(buckets: &VectorTileBuckets) -> Vec<u8> {
    let mut vertex = [0_u8; LINE_VERTEX_SIZE as usize];
    let mut bytes = Vec::with_capacity(
        buckets.line_segments.len()
            * (LINE_VERTEX_SIZE as usize)
            * LINE_VERTICES_PER_SEGMENT as usize,
    );
    for segment in &buckets.line_segments {
        for (index, value) in [segment.start, segment.end]
            .into_iter()
            .flatten()
            .enumerate()
        {
            vertex[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        vertex[16..20].copy_from_slice(&(segment.class as u32).to_le_bytes());
        for _ in 0..LINE_VERTICES_PER_SEGMENT {
            bytes.extend_from_slice(&vertex);
        }
    }
    bytes
}

/// Triangle-list indices of every segment quad; segment `n` uses `n * 6 .. n * 6 + 6`.
pub(crate) fn line_index_bytes(buckets: &VectorTileBuckets) -> Vec<u8> {
    (0..buckets.line_segments.len() as u32)
        .flat_map(|segment| {
            LINE_QUAD_INDICES.map(|corner| segment * LINE_VERTICES_PER_SEGMENT + corner)
        })
        .flat_map(u32::to_le_bytes)
        .collect()
}

/// Validates a host style table (one [`STYLE_ENTRY_FLOATS`] entry per style class).
pub(crate) fn style_table_bytes(table: &[f32]) -> Result<Vec<u8>, &'static str> {
    if table.len() != VectorBasemapStyleClass::COUNT * STYLE_ENTRY_FLOATS {
        return Err("vector basemap style table has the wrong length");
    }
    for entry in table.as_chunks::<STYLE_ENTRY_FLOATS>().0 {
        if !entry[..4]
            .iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
        {
            return Err("vector basemap style color must be finite RGBA in [0, 1]");
        }
        if !(entry[4].is_finite() && entry[4] >= 0.0) {
            return Err("vector basemap line width must be a finite, non-negative CSS px value");
        }
    }
    Ok(table.iter().flat_map(|value| value.to_le_bytes()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maps_core::{VectorFillVertex, VectorLineSegment};

    #[test]
    fn bucket_bytes_follow_the_documented_strides() {
        let buckets = VectorTileBuckets {
            fill_vertices: vec![VectorFillVertex {
                position: [0.25, 0.5],
                class: VectorBasemapStyleClass::Building,
            }],
            fill_indices: vec![0, 0, 0],
            line_segments: vec![VectorLineSegment {
                start: [0.0, 0.0],
                end: [1.0, 1.0],
                class: VectorBasemapStyleClass::Street,
            }],
            ..VectorTileBuckets::default()
        };
        let vertices = fill_vertex_bytes(&buckets);
        assert_eq!(vertices.len() as u64, FILL_VERTEX_SIZE);
        assert_eq!(vertices[8..12], 6_u32.to_le_bytes());
        assert_eq!(fill_index_bytes(&buckets).len(), 12);
        let lines = line_vertex_bytes(&buckets);
        assert_eq!(lines.len() as u64, 4 * LINE_VERTEX_SIZE);
        assert_eq!(lines[16..20], 10_u32.to_le_bytes());
        assert_eq!(lines[..20], lines[60..80]);
        let indices = line_index_bytes(&buckets);
        assert_eq!(
            indices,
            [0_u32, 1, 2, 2, 1, 3]
                .into_iter()
                .flat_map(u32::to_le_bytes)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn style_tables_reject_out_of_range_colors_and_widths() {
        let valid = vec![0.5; VectorBasemapStyleClass::COUNT * STYLE_ENTRY_FLOATS];
        assert_eq!(
            style_table_bytes(&valid).unwrap().len() as u64,
            STYLE_TABLE_SIZE
        );
        assert!(style_table_bytes(&valid[1..]).is_err());
        let mut bright = valid.clone();
        bright[0] = 1.5;
        assert!(style_table_bytes(&bright).is_err());
        let mut negative = valid;
        negative[4] = -1.0;
        assert!(style_table_bytes(&negative).is_err());
    }
}
