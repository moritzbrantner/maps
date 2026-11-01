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

/// Lowers one `[longitude, latitude]` pair through `maps-core` Web Mercator.
fn lower_point(longitude: f64, latitude: f64) -> Result<[f64; 2], &'static str> {
    project_web_mercator(longitude, latitude)
        .map(|world| [world.x, world.y])
        .ok_or("retained point coordinates must be finite")
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
            .map(|&[longitude, latitude]| lower_point(longitude, latitude))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            world,
            paint: paint.to_vec(),
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.world.len()
    }

    /// Replaces the points at `indices` (strictly increasing, in range) with the given
    /// `[longitude, latitude]` pairs and paint records, lowering only those points. Every
    /// input is validated before anything changes.
    pub(crate) fn replace(
        &mut self,
        indices: &[u32],
        lon_lat: &[f64],
        paint: &[f32],
    ) -> Result<(), &'static str> {
        if lon_lat.len() != indices.len() * 2
            || paint.len() != indices.len() * RETAINED_POINT_PAINT_LENGTH
        {
            return Err("retained point updates and records do not match");
        }
        if !indices.windows(2).all(|pair| pair[0] < pair[1])
            || indices
                .last()
                .is_some_and(|&last| last as usize >= self.world.len())
        {
            return Err("retained point update indices must be increasing and in range");
        }
        if !paint.iter().all(|value| value.is_finite()) {
            return Err("retained point paint must be finite");
        }
        let world = lon_lat
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[longitude, latitude]| lower_point(longitude, latitude))
            .collect::<Result<Vec<_>, _>>()?;
        for ((&index, world), paint) in indices
            .iter()
            .zip(world)
            .zip(paint.as_chunks::<RETAINED_POINT_PAINT_LENGTH>().0.iter())
        {
            let index = index as usize;
            self.world[index] = world;
            self.paint[index * RETAINED_POINT_PAINT_LENGTH..][..RETAINED_POINT_PAINT_LENGTH]
                .copy_from_slice(paint);
        }
        Ok(())
    }

    /// Appends point `index` as one GPU instance around `anchor`: its wrapped world offset
    /// as `f32`, then its paint record.
    fn encode_instance(&self, index: usize, anchor: [f64; 2], bytes: &mut Vec<u8>) {
        let world = self.world[index];
        let offset = [
            wrap_world_delta(world[0] - anchor[0]) as f32,
            (world[1] - anchor[1]) as f32,
        ];
        let paint =
            &self.paint[index * RETAINED_POINT_PAINT_LENGTH..][..RETAINED_POINT_PAINT_LENGTH];
        for value in offset.into_iter().chain(paint.iter().copied()) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }

    /// GPU instances around `anchor`: wrapped world offsets as `f32`, then paint.
    pub(crate) fn instance_bytes(&self, anchor: [f64; 2]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.len() * RETAINED_POINT_INSTANCE_SIZE as usize);
        for index in 0..self.len() {
            self.encode_instance(index, anchor, &mut bytes);
        }
        bytes
    }
}

/// Cumulative retained-point work, counted where the work is decided (#155, #189). The
/// wgpu backend only executes the returned [`InstanceUpload`]s.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RetainedPointCounters {
    /// Points lowered from longitude/latitude (data changes only).
    pub(crate) prepared: u64,
    /// Full instance-buffer builds around an anchor (first draw and deterministic rebases).
    pub(crate) rebases: u64,
    /// Points encoded as GPU instances (full builds and in-place updates).
    pub(crate) encoded: u64,
    /// In-place instance-buffer updates of changed points.
    pub(crate) patches: u64,
    /// Instance bytes written to GPU buffers.
    pub(crate) upload_bytes: u64,
}

/// Instance-buffer work for one retained point group, executed by the GPU backend.
#[derive(Debug, PartialEq)]
pub(crate) enum InstanceUpload {
    /// Replace the whole instance buffer (first draw or a deterministic rebase).
    Replace(Vec<u8>),
    /// Write each `(byte offset, bytes)` run into the existing instance buffer.
    Patch(Vec<(u64, Vec<u8>)>),
}

/// CPU half of one retained point group: the retained world truth and the anchor its GPU
/// instances are encoded around. Camera frames only place frames; instances are encoded
/// when data changes, on the first draw and after a deterministic rebase.
#[derive(Debug)]
pub(crate) struct RetainedPointState {
    points: RetainedPoints,
    anchor: Option<[f64; 2]>,
}

impl RetainedPointState {
    /// Lowers a new group (see [`RetainedPoints::lower`]); it is encoded on its first draw.
    pub(crate) fn prepare(
        lon_lat: &[f64],
        paint: &[f32],
        counters: &mut RetainedPointCounters,
    ) -> Result<Self, &'static str> {
        let points = RetainedPoints::lower(lon_lat, paint)?;
        counters.prepared += points.len() as u64;
        Ok(Self {
            points,
            anchor: None,
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.points.len()
    }

    /// Replaces the points at `indices` in place (see [`RetainedPoints::replace`]). Only
    /// the changed points are lowered and, once the group has instances, re-encoded around
    /// the current anchor as a [`InstanceUpload::Patch`] of contiguous runs.
    pub(crate) fn update(
        &mut self,
        indices: &[u32],
        lon_lat: &[f64],
        paint: &[f32],
        counters: &mut RetainedPointCounters,
    ) -> Result<Option<InstanceUpload>, &'static str> {
        self.points.replace(indices, lon_lat, paint)?;
        counters.prepared += indices.len() as u64;
        let Some(anchor) = self.anchor else {
            return Ok(None);
        };
        if indices.is_empty() {
            return Ok(None);
        }
        let mut runs: Vec<(u64, Vec<u8>)> = Vec::new();
        let mut previous: Option<u32> = None;
        for &index in indices {
            let contiguous = previous.is_some_and(|previous| previous + 1 == index);
            if !contiguous {
                runs.push((u64::from(index) * RETAINED_POINT_INSTANCE_SIZE, Vec::new()));
            }
            let run = &mut runs.last_mut().expect("a run was started").1;
            self.points.encode_instance(index as usize, anchor, run);
            previous = Some(index);
        }
        counters.encoded += indices.len() as u64;
        counters.patches += 1;
        counters.upload_bytes += indices.len() as u64 * RETAINED_POINT_INSTANCE_SIZE;
        Ok(Some(InstanceUpload::Patch(runs)))
    }

    /// Prepares the group for a camera frame: rebuilds every instance around the view
    /// centre on the first draw or when the camera has travelled past the rebase distance,
    /// and otherwise does no per-point work.
    pub(crate) fn place(
        &mut self,
        view: &RetainedView,
        counters: &mut RetainedPointCounters,
    ) -> Option<InstanceUpload> {
        if !view.needs_rebase(self.anchor) {
            return None;
        }
        let anchor = view.center;
        let bytes = self.points.instance_bytes(anchor);
        self.anchor = Some(anchor);
        counters.rebases += 1;
        counters.encoded += self.points.len() as u64;
        counters.upload_bytes += bytes.len() as u64;
        Some(InstanceUpload::Replace(bytes))
    }

    /// Local frames placing this group's anchor for the view: one per drawn world copy.
    pub(crate) fn frames<'a>(
        &self,
        view: &'a RetainedView,
    ) -> impl Iterator<Item = LocalFrame> + 'a {
        self.anchor
            .into_iter()
            .flat_map(move |anchor| view.anchor_frames(anchor))
    }
}

/// `delta` wrapped into `[-0.5, 0.5)` world widths.
pub(crate) fn wrap_world_delta(delta: f64) -> f64 {
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
    /// Widest horizontal reach of the placed tiles from the viewport centre, in worlds.
    pub(crate) half_width_world: f64,
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
        let mut local_x_range = (f64::INFINITY, f64::NEG_INFINITY);
        for (z, x, y, west, north, size) in placements {
            if !(west.is_finite() && north.is_finite() && size.is_finite() && size > 0.0) {
                continue;
            }
            let scale = size * f64::from(z).exp2();
            let origin_x = west - f64::from(x) * size;
            let origin_y = north + f64::from(y) * size;
            frame.get_or_insert((scale, origin_y));
            local_x_range = (local_x_range.0.min(west), local_x_range.1.max(west + size));
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
        let half_width_world = (local_x - local_x_range.0).max(local_x_range.1 - local_x) / scale;
        (center.iter().all(|value| value.is_finite()) && px_per_world.is_finite()).then_some(Self {
            copy_origins_x,
            origin_y,
            scale,
            center,
            px_per_world,
            half_width_world,
        })
    }

    /// MapLibre's covering zoom for 512 px vector tiles (GeoJSON sources): the floored camera
    /// zoom. The scale comes through `f32` matrices, so an integer zoom is matched within
    /// 1e-4.
    pub(crate) fn tile_zoom(&self) -> u8 {
        let zoom = (self.px_per_world / 512.0).log2();
        (zoom + 1.0e-4).floor().clamp(0.0, f64::from(u8::MAX)) as u8
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

    /// Local frames placing `anchor` (offset 0) in local space: one per visible world copy
    /// plus one beyond each edge. Offsets are wrapped to the nearest world around the
    /// anchor, so a point may sit one world off its tile-derived copy; the boundary frames
    /// keep every visible copy of every point covered. Frame `(u, v)` offsets are world
    /// units with +v south, as the frame matrix expects.
    ///
    /// The boundary frames are only needed when a visible point can be half a world or more
    /// from the anchor; otherwise every visible point already wraps onto its visible copy.
    pub(crate) fn anchor_frames(&self, anchor: [f64; 2]) -> impl Iterator<Item = LocalFrame> + '_ {
        let anchor_distance = wrap_world_delta(self.center[0] - anchor[0]).abs();
        let boundary = self.half_width_world + anchor_distance >= 0.45;
        let first = self.copy_origins_x.first().copied().unwrap_or_default() - self.scale;
        let last = self.copy_origins_x.last().copied().unwrap_or_default() + self.scale;
        boundary
            .then_some(first)
            .into_iter()
            .chain(self.copy_origins_x.iter().copied())
            .chain(boundary.then_some(last))
            .map(move |origin_x| LocalFrame {
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
    fn updates_lower_and_encode_only_changed_points_in_contiguous_runs() {
        let mut counters = RetainedPointCounters::default();
        let lon_lat: Vec<f64> = (0..6).flat_map(|index| [f64::from(index), 0.0]).collect();
        let mut state =
            RetainedPointState::prepare(&lon_lat, &[paint(); 6].concat(), &mut counters).unwrap();
        assert_eq!(counters.prepared, 6);

        // Before the first draw an update only re-lowers; the draw encodes everything.
        assert_eq!(
            state.update(&[1], &[10.0, 1.0], &paint(), &mut counters),
            Ok(None)
        );
        assert_eq!((counters.prepared, counters.encoded), (7, 0));
        let view = view_at([0.0, 0.0], 0.001);
        let Some(InstanceUpload::Replace(full)) = state.place(&view, &mut counters) else {
            panic!("the first draw replaces the instances");
        };
        assert_eq!(full.len() as u64, 6 * RETAINED_POINT_INSTANCE_SIZE);
        assert_eq!(state.place(&view, &mut counters), None);

        // Adjacent indices share one write; the bytes match a full encode of the new data.
        let mut moved = paint();
        moved[0] = 9.0;
        let upload = state
            .update(
                &[2, 3, 5],
                &[20.0, 2.0, 30.0, 3.0, 50.0, 5.0],
                &[moved; 3].concat(),
                &mut counters,
            )
            .unwrap();
        let Some(InstanceUpload::Patch(runs)) = upload else {
            panic!("a drawn group is patched");
        };
        let size = RETAINED_POINT_INSTANCE_SIZE as usize;
        let expected = state.points.instance_bytes(view.center);
        assert_eq!(
            runs,
            vec![
                (2 * size as u64, expected[2 * size..4 * size].to_vec()),
                (5 * size as u64, expected[5 * size..6 * size].to_vec()),
            ]
        );
        assert_eq!(counters.encoded, 6 + 3);
        assert_eq!(counters.upload_bytes, 9 * RETAINED_POINT_INSTANCE_SIZE);
        assert_eq!((counters.rebases, counters.patches), (1, 1));
    }

    #[test]
    fn rejected_updates_change_nothing() {
        let mut counters = RetainedPointCounters::default();
        let mut state = RetainedPointState::prepare(
            &[0.0, 0.0, 1.0, 1.0],
            &[paint(), paint()].concat(),
            &mut counters,
        )
        .unwrap();
        let before = state.points.instance_bytes([0.5, 0.5]);
        for (indices, lon_lat) in [
            (&[1_u32, 0][..], &[5.0, 5.0, 6.0, 6.0][..]),
            (&[1, 1], &[5.0, 5.0, 6.0, 6.0]),
            (&[2], &[5.0, 5.0]),
            (&[0, 1], &[5.0, 5.0, f64::NAN, 6.0]),
            (&[0], &[5.0]),
        ] {
            let paint = vec![1.0; indices.len() * RETAINED_POINT_PAINT_LENGTH];
            assert!(
                state
                    .update(indices, lon_lat, &paint, &mut counters)
                    .is_err()
            );
        }
        assert_eq!(state.points.instance_bytes([0.5, 0.5]), before);
        assert_eq!(counters.prepared, 2);
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
        let skip = usize::from(view.anchor_frames(anchor).count() > view.copy_origins_x.len());
        for (frame, origin_x) in view
            .anchor_frames(anchor)
            .skip(skip)
            .zip(&view.copy_origins_x)
        {
            let clip = apply(local_frame_matrix(view_projection, frame).unwrap(), offset);
            // Same local position as lowering world x directly into this copy.
            let expected_local_x = origin_x + world_x * view.scale;
            assert!((clip[0] - expected_local_x * 0.001).abs() < 1.0e-6);
            assert!(clip[1].abs() < 1.0e-6);
        }
    }

    #[test]
    fn wrapped_offsets_still_cover_every_visible_world_copy() {
        // Visible copies 0 and 1 (origins -512 and 512) with the anchor at the far east
        // of world 0: a point at world x 0.48 wraps to +0.49 from the anchor.
        let view = view_at([0.0, 0.0], 0.001);
        let anchor = [0.99, 0.5];
        let points = RetainedPoints::lower(&[-7.2, 0.0], &paint()).unwrap();
        let world_x = points.world[0][0];
        let bytes = points.instance_bytes(anchor);
        let offset_u = f64::from(f32::from_le_bytes(bytes[0..4].try_into().unwrap()));
        assert!(offset_u > 0.45);
        let drawn: Vec<f64> = view
            .anchor_frames(anchor)
            .map(|frame| frame.west + offset_u * frame.size)
            .collect();
        for origin_x in &view.copy_origins_x {
            let expected = origin_x + world_x * view.scale;
            assert!(
                drawn.iter().any(|local| (local - expected).abs() < 1.0e-3),
                "copy at {origin_x} missing: {drawn:?}"
            );
        }
    }

    #[test]
    fn a_viewport_well_inside_one_world_draws_only_its_copy() {
        // Zoomed in: tiles reach far less than half a world from the centre.
        let view = RetainedView::from_placements(
            [(10, 512, 512, -128.0, 128.0, 256.0)],
            identity_scaled(0.001),
            1000.0,
        )
        .unwrap();
        assert!(view.half_width_world < 0.01);
        assert_eq!(view.anchor_frames(view.center).count(), 1);
        // The z=2 grid reaches half a world: boundary copies are included.
        let wide = view_at([0.0, 0.0], 0.001);
        assert_eq!(wide.anchor_frames(wide.center).count(), 4);
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
