//! Target-independent half of the shared retained-geometry module (see `wgpu_retained`).
//!
//! Retained geometry is uploaded once in a *local frame*: normalized `(u, v)` in `[0, 1]`
//! (+v south) of a square whose placement in the Rust camera's local map plane is
//! recomputed every frame. Camera motion therefore only changes one small per-frame
//! uniform, and moving the camera's local origin (a rebase) never touches retained
//! buffers: Rust re-derives the placements and the frame matrix follows. Precision is
//! bounded by the frame size, so consumers choose frames (vector tiles, or point tiles at a
//! fixed zoom for #155) small enough for `f32` positions at the zooms they draw.
#![cfg_attr(
    not(all(
        target_arch = "wasm32",
        target_os = "unknown",
        feature = "wgpu-base-map"
    )),
    allow(dead_code)
)]

use maps_core::VectorTilePlacement;

/// Per-frame uniform shared by every retained-geometry shader: the column-major frame
/// matrix, then (surface width px, surface height px, CSS-to-physical pixel ratio, 0).
/// WGSL: `struct RetainedFrame { matrix: mat4x4<f32>, surface: vec4<f32> }`.
pub(crate) const FRAME_UNIFORM_SIZE: u64 = 80;

/// Where one retained frame lies in the camera's local map plane this frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LocalFrame {
    pub(crate) west: f64,
    pub(crate) north: f64,
    pub(crate) size: f64,
}

impl From<&VectorTilePlacement> for LocalFrame {
    fn from(placement: &VectorTilePlacement) -> Self {
        Self {
            west: placement.local_west,
            north: placement.local_north,
            size: placement.local_size,
        }
    }
}

/// `view_projection * T`, where `T` maps frame-normalized `(u, v)` (+v south) to the
/// frame's local map-plane square. Composed in `f64`; `None` when the result is not
/// representable as finite `f32`.
pub(crate) fn local_frame_matrix(
    view_projection: [f32; 16],
    frame: LocalFrame,
) -> Option<[f32; 16]> {
    let column = |index: usize| -> [f64; 4] {
        std::array::from_fn(|row| f64::from(view_projection[index * 4 + row]))
    };
    let (x, y, z, w) = (column(0), column(1), column(2), column(3));
    let size = frame.size;
    let columns = [
        x.map(|value| value * size),
        y.map(|value| -value * size),
        z,
        std::array::from_fn(|row| x[row] * frame.west + y[row] * frame.north + w[row]),
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

pub(crate) fn frame_uniform_bytes(
    matrix: [f32; 16],
    surface: [f32; 4],
) -> [u8; FRAME_UNIFORM_SIZE as usize] {
    let mut bytes = [0; FRAME_UNIFORM_SIZE as usize];
    for (index, value) in matrix.into_iter().chain(surface).enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// Packs per-frame uniforms at `stride` (the device's dynamic-offset alignment) and
/// returns each frame's byte offset; frames whose matrix is unrepresentable are skipped.
pub(crate) fn pack_frame_uniforms<K>(
    frames: impl IntoIterator<Item = (K, LocalFrame)>,
    view_projection: [f32; 16],
    surface: [f32; 4],
    stride: u64,
    bytes: &mut Vec<u8>,
) -> Vec<(K, u32)> {
    bytes.clear();
    let mut offsets = Vec::new();
    for (key, frame) in frames {
        let Some(matrix) = local_frame_matrix(view_projection, frame) else {
            continue;
        };
        let offset = bytes.len();
        bytes.extend_from_slice(&frame_uniform_bytes(matrix, surface));
        bytes.resize(offset + stride as usize, 0);
        offsets.push((key, offset as u32));
    }
    offsets
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn frame_matrix_maps_frame_corners_onto_the_local_square() {
        let frame = LocalFrame {
            west: -40.0,
            north: 25.0,
            size: 256.0,
        };
        let matrix = local_frame_matrix(identity(), frame).unwrap();
        assert_eq!(apply(matrix, [0.0, 0.0]), [-40.0, 25.0]);
        assert_eq!(apply(matrix, [1.0, 1.0]), [216.0, -231.0]);
    }

    #[test]
    fn frame_matrix_composes_with_the_camera() {
        let mut view_projection = identity();
        view_projection[0] = 0.5;
        view_projection[5] = 0.25;
        view_projection[12] = 0.1;
        let frame = LocalFrame {
            west: 2.0,
            north: 4.0,
            size: 8.0,
        };
        let matrix = local_frame_matrix(view_projection, frame).unwrap();
        // Local (2 + 8 * 0.5, 4 - 8 * 0.5) = (6, 0) -> clip (3.1, 0).
        assert_eq!(apply(matrix, [0.5, 0.5]), [3.1, 0.0]);
        let overflow = LocalFrame {
            size: f64::MAX,
            ..frame
        };
        assert_eq!(local_frame_matrix(view_projection, overflow), None);
    }

    #[test]
    fn a_rebased_camera_moves_frames_without_changing_retained_coordinates() {
        // The same retained point, before and after the camera's local origin moves by
        // (+1000, -500): the frame placement follows, the clip position is unchanged.
        let mut view_projection = identity();
        view_projection[0] = 0.001;
        view_projection[5] = 0.001;
        let before = LocalFrame {
            west: 10.0,
            north: 20.0,
            size: 64.0,
        };
        let mut rebased = view_projection;
        rebased[12] = -1000.0 * 0.001;
        rebased[13] = 500.0 * 0.001;
        let after = LocalFrame {
            west: 1010.0,
            north: -480.0,
            size: 64.0,
        };
        let point = [0.25, 0.75];
        let a = apply(local_frame_matrix(view_projection, before).unwrap(), point);
        let b = apply(local_frame_matrix(rebased, after).unwrap(), point);
        assert!((a[0] - b[0]).abs() < 1.0e-6 && (a[1] - b[1]).abs() < 1.0e-6);
    }

    #[test]
    fn packed_uniforms_are_stride_aligned_and_skip_unrepresentable_frames() {
        let frame = LocalFrame {
            west: 0.0,
            north: 0.0,
            size: 1.0,
        };
        let overflow = LocalFrame {
            size: f64::MAX,
            ..frame
        };
        let mut bytes = Vec::new();
        let offsets = pack_frame_uniforms(
            [("a", frame), ("skipped", overflow), ("b", frame)],
            identity(),
            [800.0, 600.0, 2.0, 0.0],
            256,
            &mut bytes,
        );
        assert_eq!(offsets, [("a", 0), ("b", 256)]);
        assert_eq!(bytes.len(), 512);
        assert_eq!(bytes[72..76], 2.0_f32.to_le_bytes());
    }
}
