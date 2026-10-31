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
/// Line vertex of the round-joined strip (`maps_core::LineMesh`): tile-normalized position
/// (2 x f32), unit extrusion (2 x f32), then style class with [`LINE_ROUND_FLAG`] and
/// [`LINE_UP_FLAG`] (u32). Indexed triangle list.
pub(crate) const LINE_VERTEX_SIZE: u64 = 20;
pub(crate) const LINE_ROUND_FLAG: u32 = 1 << 8;
pub(crate) const LINE_UP_FLAG: u32 = 1 << 9;
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
    let mut bytes = Vec::with_capacity(buckets.line_vertices.len() * LINE_VERTEX_SIZE as usize);
    for vertex in &buckets.line_vertices {
        for value in vertex.position.into_iter().chain(vertex.extrude) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let flags = vertex.class as u32
            | if vertex.round { LINE_ROUND_FLAG } else { 0 }
            | if vertex.up { LINE_UP_FLAG } else { 0 };
        bytes.extend_from_slice(&flags.to_le_bytes());
    }
    bytes
}

pub(crate) fn line_index_bytes(buckets: &VectorTileBuckets) -> Vec<u8> {
    buckets
        .line_indices
        .iter()
        .flat_map(|index| index.to_le_bytes())
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
    use maps_core::{VectorFillVertex, VectorLineVertex};

    #[test]
    fn bucket_bytes_follow_the_documented_strides() {
        let buckets = VectorTileBuckets {
            fill_vertices: vec![VectorFillVertex {
                position: [0.25, 0.5],
                class: VectorBasemapStyleClass::Building,
            }],
            fill_indices: vec![0, 0, 0],
            line_vertices: vec![VectorLineVertex {
                position: [0.0, 0.5],
                extrude: [-1.0, 1.0],
                round: true,
                up: true,
                class: VectorBasemapStyleClass::Street,
            }],
            line_indices: vec![0, 0, 0],
            ..VectorTileBuckets::default()
        };
        let vertices = fill_vertex_bytes(&buckets);
        assert_eq!(vertices.len() as u64, FILL_VERTEX_SIZE);
        assert_eq!(vertices[8..12], 6_u32.to_le_bytes());
        assert_eq!(fill_index_bytes(&buckets).len(), 12);
        let lines = line_vertex_bytes(&buckets);
        assert_eq!(lines.len() as u64, LINE_VERTEX_SIZE);
        assert_eq!(lines[4..8], 0.5_f32.to_le_bytes());
        assert_eq!(lines[8..12], (-1.0_f32).to_le_bytes());
        assert_eq!(lines[16..20], (10_u32 | 0x300).to_le_bytes());
        assert_eq!(line_index_bytes(&buckets).len(), 12);
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
