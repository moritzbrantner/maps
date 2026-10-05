//! Target-independent half of the retained application points (#155).
//!
//! Points are lowered once from longitude/latitude into `f64` Web Mercator world
//! coordinates by `maps-core`; that is the retained geographic truth. GPU instances store
//! `f32` offsets from an *anchor* near the camera (wrapped across the antimeridian), and a
//! single local frame per world copy places the anchor in the Rust camera's local plane
//! (`retained_frame`). Ordinary camera motion therefore only rewrites one frame uniform per
//! world copy. When the camera has moved [`REBASE_DISTANCE_PX`] away from the anchor, the
//! offsets are rebuilt around the new camera centre from the retained world coordinates:
//! a deterministic, counted rebase that keeps on-screen `f32` offsets small.
#![cfg_attr(
    not(all(
        target_arch = "wasm32",
        target_os = "unknown",
        feature = "wgpu-base-map"
    )),
    allow(dead_code)
)]

use maps_core::project_web_mercator;

use crate::retained_frame::LocalFrame;

/// Per-point paint record: radius and stroke width (CSS px), fill RGBA, stroke RGBA
/// (linear light). Shared with `src/wgpu-application-frame.ts`.
pub(crate) const RETAINED_POINT_PAINT_LENGTH: usize = 10;
/// GPU instance: anchor offset (2 x f32) followed by the paint record.
pub(crate) const RETAINED_POINT_INSTANCE_SIZE: u64 = 48;
/// Camera travel (screen px at the current zoom) after which offsets are rebuilt. On-screen
/// offsets then stay below ~2^15 px, i.e. below ~0.002 px of `f32` error.
pub(crate) const REBASE_DISTANCE_PX: f64 = 32_768.0;

/// Retained points: `f64` world coordinates and their paint records.
#[derive(Debug)]
pub(crate) struct RetainedPoints {
    world: Vec<[f64; 2]>,
    paint: Vec<f32>,
}

impl RetainedPoints {
    /// Lowers `[longitude, latitude]` pairs once through `maps-core` Web Mercator.
    pub(crate) fn lower(lon_lat: &[f64], paint: &[f32]) -> Result<Self, &'static str> {
        if !lon_lat.len().is_multiple_of(2)
            || paint.len() != lon_lat.len() / 2 * RETAINED_POINT_PAINT_LENGTH
        {
            return Err("retained points and paint records do not match");
        }
        if !paint.iter().all(|value| value.is_finite()) {
            return Err("retained point paint must be finite");
        }
        let world = lon_lat
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[longitude, latitude]| {
                project_web_mercator(longitude, latitude)
                    .map(|world| [world.x, world.y])
                    .ok_or("retained point coordinates must be finite")
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            world,
            paint: paint.to_vec(),
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.world.len()
    }

    /// GPU instances around `anchor`: wrapped world offsets as `f32`, then paint.
    pub(crate) fn instance_bytes(&self, anchor: [f64; 2]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.len() * RETAINED_POINT_INSTANCE_SIZE as usize);
        for (world, paint) in self.world.iter().zip(
            self.paint
                .as_chunks::<RETAINED_POINT_PAINT_LENGTH>()
                .0
                .iter(),
        ) {
            let offset = [
                wrap_world_delta(world[0] - anchor[0]) as f32,
                (world[1] - anchor[1]) as f32,
            ];
            for value in offset.into_iter().chain(paint.iter().copied()) {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        bytes
    }
}

/// `delta` wrapped into `[-0.5, 0.5)` world widths.
fn wrap_world_delta(delta: f64) -> f64 {
    delta - (delta + 0.5).floor()
}

/// The camera as seen through this frame's raster placements.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RetainedView {
    /// World x origin (local units) of each visible world copy; world y origin is shared.
    pub(crate) copy_origins_x: Vec<f64>,
    pub(crate) origin_y: f64,
    /// Local units per world unit.
    pub(crate) scale: f64,
    /// World coordinate under the viewport centre (x wrapped into `[0, 1)`).
    pub(crate) center: [f64; 2],
    /// Screen px per world unit at the viewport centre.
    pub(crate) px_per_world: f64,
}

impl RetainedView {
    /// Derives the view from raster placements `(z, x, y, local west, local north, local
    /// size)`, the camera view-projection and the surface width in px. `None` without a
    /// usable placement.
    pub(crate) fn from_placements(
        placements: impl IntoIterator<Item = (u8, u32, u32, f64, f64, f64)>,
        view_projection: [f32; 16],
        surface_width_px: f64,
    ) -> Option<Self> {
        let mut copy_origins_x: Vec<f64> = Vec::new();
        let mut frame: Option<(f64, f64)> = None;
        for (z, x, y, west, north, size) in placements {
            if !(west.is_finite() && north.is_finite() && size.is_finite() && size > 0.0) {
                continue;
            }
            let scale = size * f64::from(z).exp2();
            let origin_x = west - f64::from(x) * size;
            let origin_y = north + f64::from(y) * size;
            frame.get_or_insert((scale, origin_y));
            if !copy_origins_x
                .iter()
                .any(|existing| (existing - origin_x).abs() < scale * 0.5)
            {
                copy_origins_x.push(origin_x);
            }
        }
        let (scale, origin_y) = frame?;
        copy_origins_x.sort_by(f64::total_cmp);

        // The local point under clip (0, 0) on the map plane: solve the 2 x 2 system.
        let m = view_projection.map(f64::from);
        let determinant = m[0] * m[5] - m[4] * m[1];
        if determinant.abs() < f64::EPSILON || !determinant.is_finite() {
            return None;
        }
        let local_x = (-m[12] * m[5] + m[4] * m[13]) / determinant;
        let local_y = (-m[0] * m[13] + m[1] * m[12]) / determinant;
        let center = [
            ((local_x - copy_origins_x[0]) / scale).rem_euclid(1.0),
            (origin_y - local_y) / scale,
        ];
        let w = m[3] * local_x + m[7] * local_y + m[15];
        let px_per_world = m[0].hypot(m[1]) / w.abs() * surface_width_px * 0.5 * scale;
        (center.iter().all(|value| value.is_finite()) && px_per_world.is_finite()).then_some(Self {
            copy_origins_x,
            origin_y,
            scale,
            center,
            px_per_world,
        })
    }

    /// Whether offsets around `anchor` must be rebuilt for this view.
    pub(crate) fn needs_rebase(&self, anchor: Option<[f64; 2]>) -> bool {
        let Some(anchor) = anchor else {
            return true;
        };
        let dx = wrap_world_delta(self.center[0] - anchor[0]);
        let dy = self.center[1] - anchor[1];
        dx.hypot(dy) * self.px_per_world > REBASE_DISTANCE_PX
    }

    /// One local frame per visible world copy, placing `anchor` (offset 0) in local space.
    /// Frame `(u, v)` offsets are world units with +v south, as the frame matrix expects.
    pub(crate) fn anchor_frames(&self, anchor: [f64; 2]) -> impl Iterator<Item = LocalFrame> + '_ {
        self.copy_origins_x.iter().map(move |origin_x| LocalFrame {
            west: origin_x + anchor[0] * self.scale,
            north: self.origin_y - anchor[1] * self.scale,
            size: self.scale,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retained_frame::local_frame_matrix;

    fn identity_scaled(scale: f32) -> [f32; 16] {
        let mut matrix = [0.0; 16];
        matrix[0] = scale;
        matrix[5] = scale;
        matrix[10] = 1.0;
        matrix[15] = 1.0;
        matrix
    }

    fn apply(matrix: [f32; 16], point: [f32; 2]) -> [f64; 2] {
        let m = matrix.map(f64::from);
        let (x, y) = (f64::from(point[0]), f64::from(point[1]));
        [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13]]
    }

    fn paint() -> [f32; RETAINED_POINT_PAINT_LENGTH] {
        [4.0, 1.0, 0.1, 0.2, 0.3, 1.0, 1.0, 1.0, 1.0, 1.0]
    }

    #[test]
    fn lowering_is_maps_core_web_mercator_and_validates_records() {
        let points =
            RetainedPoints::lower(&[0.0, 0.0, 90.0, 0.0], &[paint(), paint()].concat()).unwrap();
        assert_eq!(points.world, vec![[0.5, 0.5], [0.75, 0.5]]);
        assert!(RetainedPoints::lower(&[0.0], &[]).is_err());
        assert!(RetainedPoints::lower(&[0.0, 0.0], &paint()[..9]).is_err());
        assert!(RetainedPoints::lower(&[f64::NAN, 0.0], &paint()).is_err());
        let mut bad = paint();
        bad[0] = f32::INFINITY;
        assert!(RetainedPoints::lower(&[0.0, 0.0], &bad).is_err());
    }

    #[test]
    fn instances_store_wrapped_anchor_offsets_then_paint() {
        let points =
            RetainedPoints::lower(&[179.9, 0.0, -179.9, 0.0], &[paint(), paint()].concat())
                .unwrap();
        let bytes = points.instance_bytes([1.0 - 1.0e-6, 0.5]);
        assert_eq!(bytes.len() as u64, 2 * RETAINED_POINT_INSTANCE_SIZE);
        let first_u = f32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let second_u = f32::from_le_bytes(bytes[48..52].try_into().unwrap());
        // Both sides of the antimeridian stay within a tiny offset of the anchor.
        assert!(first_u < 0.0 && first_u > -1.0e-3);
        assert!(second_u > 0.0 && second_u < 1.0e-3);
        assert_eq!(bytes[8..12], 4.0_f32.to_le_bytes());
    }

    /// A z=2 placement grid around local origin 0 with 256 local units per tile.
    fn view_at(center_local: [f32; 2], scale: f32) -> RetainedView {
        let mut view_projection = identity_scaled(scale);
        view_projection[12] = -center_local[0] * scale;
        view_projection[13] = -center_local[1] * scale;
        RetainedView::from_placements(
            [
                (2, 1, 1, -256.0, 256.0, 256.0),
                (2, 2, 1, 0.0, 256.0, 256.0),
                // The same tile one world copy to the right.
                (2, 1, 1, 768.0, 256.0, 256.0),
            ],
            view_projection,
            1000.0,
        )
        .unwrap()
    }

    #[test]
    fn view_recovers_world_copies_and_the_viewport_centre() {
        let view = view_at([0.0, 0.0], 0.001);
        // World x 0 sits at local -512 in the first copy, +512 in the next.
        assert_eq!(view.copy_origins_x, vec![-512.0, 512.0]);
        assert_eq!(view.scale, 1024.0);
        assert_eq!(view.origin_y, 512.0);
        assert_eq!(view.center, [0.5, 0.5]);
        // 1024 local units per world x 0.001 clip per local unit x 500 px per clip unit.
        assert!((view.px_per_world - 512.0).abs() < 1.0e-3);
    }

    #[test]
    fn retained_points_land_where_the_frame_matrix_puts_them_in_every_world_copy() {
        let view = view_at([0.0, 0.0], 0.001);
        let anchor = view.center;
        let points = RetainedPoints::lower(&[45.0, 0.0], &paint()).unwrap();
        let bytes = points.instance_bytes(anchor);
        let offset = [
            f32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            f32::from_le_bytes(bytes[4..8].try_into().unwrap()),
        ];
        let world_x = points.world[0][0];
        let mut view_projection = identity_scaled(0.001);
        view_projection[12] = 0.0;
        for (frame, origin_x) in view.anchor_frames(anchor).zip(&view.copy_origins_x) {
            let clip = apply(local_frame_matrix(view_projection, frame).unwrap(), offset);
            // Same local position as lowering world x directly into this copy.
            let expected_local_x = origin_x + world_x * view.scale;
            assert!((clip[0] - expected_local_x * 0.001).abs() < 1.0e-6);
            assert!(clip[1].abs() < 1.0e-6);
        }
    }

    #[test]
    fn camera_travel_rebases_only_beyond_the_threshold() {
        let view = view_at([0.0, 0.0], 0.001);
        assert!(view.needs_rebase(None));
        assert!(!view.needs_rebase(Some(view.center)));
        // 512 px per world unit: 32768 px is 64 world widths, never reached by panning
        // at this zoom; a deep zoom reaches it after a short pan.
        assert!(!view.needs_rebase(Some([view.center[0] + 0.4, view.center[1]])));
        let deep = view_at([0.0, 0.0], 1000.0);
        assert!(deep.px_per_world > 1.0e8);
        let travel = REBASE_DISTANCE_PX / deep.px_per_world;
        assert!(!deep.needs_rebase(Some([deep.center[0] + travel * 0.9, deep.center[1]])));
        assert!(deep.needs_rebase(Some([deep.center[0] + travel * 1.1, deep.center[1]])));
    }

    #[test]
    fn deep_zoom_offsets_keep_sub_pixel_precision_after_a_rebase() {
        // Zoom ~22 (px per world 2^30): two points 1 px apart near the anchor.
        let px_per_world = 2.0_f64.powi(30);
        let anchor = [0.3, 0.4];
        let points = RetainedPoints {
            world: vec![
                [anchor[0] + 1000.0 / px_per_world, anchor[1]],
                [anchor[0] + 1001.0 / px_per_world, anchor[1]],
            ],
            paint: [paint(), paint()].concat(),
        };
        let bytes = points.instance_bytes(anchor);
        let a = f64::from(f32::from_le_bytes(bytes[0..4].try_into().unwrap())) * px_per_world;
        let b = f64::from(f32::from_le_bytes(bytes[48..52].try_into().unwrap())) * px_per_world;
        assert!((b - a - 1.0).abs() < 1.0e-3);
    }
}
