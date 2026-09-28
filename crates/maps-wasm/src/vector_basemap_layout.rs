//! Target-independent GPU layout of retained vector basemap buckets.
//!
//! The wgpu backend (wasm32 only) uploads these bytes once per tile and composes one
//! per-tile matrix per frame; keeping the packing and matrix math here lets native
//! `cargo test` cover them.
#![cfg_attr(
    not(all(
        target_arch = "wasm32",
        target_os = "unknown",
        feature = "wgpu-base-map"
    )),
    allow(dead_code)
)]

use maps_core::{VectorBasemapStyleClass, VectorTileBuckets, VectorTilePlacement};

/// Fill vertex: tile-normalized position (2 x f32) and style class (u32).
pub(crate) const FILL_VERTEX_SIZE: u64 = 12;
/// Line vertex: tile-normalized segment start/end (4 x f32) and style class (u32). Each
/// segment is four identical vertices (quad corners come from `vertex_index & 3`) drawn
/// with [`LINE_QUAD_INDICES`]; per-segment instancing of 6-vertex quads is ~45x slower
/// on SwiftShader and wasteful on hardware GPUs.
pub(crate) const LINE_VERTEX_SIZE: u64 = 20;
pub(crate) const LINE_VERTICES_PER_SEGMENT: u32 = 4;
pub(crate) const LINE_QUAD_INDICES: [u32; 6] = [0, 1, 2, 2, 1, 3];
/// Per-tile uniform: column-major matrix, then (surface width px, height px, pixel ratio, 0).
pub(crate) const TILE_UNIFORM_SIZE: u64 = 80;
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

/// `view_projection * T`, where `T` maps tile-normalized `(u, v)` (+v south) to the
/// placement's local map-plane rectangle. Composed in `f64`; `None` when the result
/// is not representable as finite `f32`.
pub(crate) fn tile_matrix(
    view_projection: [f32; 16],
    placement: &VectorTilePlacement,
) -> Option<[f32; 16]> {
    let column = |index: usize| -> [f64; 4] {
        std::array::from_fn(|row| f64::from(view_projection[index * 4 + row]))
    };
    let (x, y, z, w) = (column(0), column(1), column(2), column(3));
    let size = placement.local_size;
    let columns = [
        x.map(|value| value * size),
        y.map(|value| -value * size),
        z,
        std::array::from_fn(|row| {
            x[row] * placement.local_west + y[row] * placement.local_north + w[row]
        }),
    ];
    let mut matrix = [0.0_f32; 16];
    for (index, value) in columns.into_iter().flatten().enumerate() {
        let value = value as f32;
        if !value.is_finite() {
            return None;
        }
        matrix[index] = value;
    }
    Some(matrix)
}

pub(crate) fn tile_uniform_bytes(matrix: [f32; 16], surface: [f32; 4]) -> [u8; 80] {
    let mut bytes = [0; TILE_UNIFORM_SIZE as usize];
    for (index, value) in matrix.into_iter().chain(surface).enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
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
    use maps_core::{TileId, VectorFillVertex, VectorLineSegment};

    fn identity() -> [f32; 16] {
        let mut matrix = [0.0; 16];
        for index in 0..4 {
            matrix[index * 5] = 1.0;
        }
        matrix
    }

    fn apply(matrix: [f32; 16], point: [f32; 2]) -> [f32; 2] {
        [
            matrix[0] * point[0] + matrix[4] * point[1] + matrix[12],
            matrix[1] * point[0] + matrix[5] * point[1] + matrix[13],
        ]
    }

    #[test]
    fn tile_matrix_maps_tile_corners_onto_the_local_placement() {
        let placement = VectorTilePlacement {
            tile: TileId::new(3, 1, 2).unwrap(),
            local_west: -40.0,
            local_north: 25.0,
            local_size: 256.0,
        };
        let matrix = tile_matrix(identity(), &placement).unwrap();
        assert_eq!(apply(matrix, [0.0, 0.0]), [-40.0, 25.0]);
        assert_eq!(apply(matrix, [1.0, 1.0]), [216.0, -231.0]);
    }

    #[test]
    fn tile_matrix_composes_with_the_camera() {
        let mut view_projection = identity();
        view_projection[0] = 0.5;
        view_projection[5] = 0.25;
        view_projection[12] = 0.1;
        let placement = VectorTilePlacement {
            tile: TileId::new(0, 0, 0).unwrap(),
            local_west: 2.0,
            local_north: 4.0,
            local_size: 8.0,
        };
        let matrix = tile_matrix(view_projection, &placement).unwrap();
        // Local (2 + 8 * 0.5, 4 - 8 * 0.5) = (6, 0) -> clip (3.1, 0).
        assert_eq!(apply(matrix, [0.5, 0.5]), [3.1, 0.0]);
        let overflow = VectorTilePlacement {
            local_size: f64::MAX,
            ..placement
        };
        assert_eq!(tile_matrix(view_projection, &overflow), None);
    }

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
