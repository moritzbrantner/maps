//! Matrix-backed camera adapter between Maps-owned geographic semantics and shared 3D math.
//!
//! Geographic/Mercator state remains authoritative in `MapCamera`. This module rebases the
//! already-authoritative flat projection into a small CSS-pixel local frame before converting
//! to `f32` and delegating generic view/projection math to `3d-lab`.

use crate::{GeographicCoordinate, MapCamera, ScreenCoordinate};
use three_d_camera::PerspectiveCamera;
use three_d_core::Vec3;
use three_d_projective::{transform_point_projective, untransform_point_projective};

const FIELD_OF_VIEW_Y_RADIANS: f32 = core::f32::consts::FRAC_PI_4;
const RAY_EPSILON: f32 = 1.0e-6;
const FAR_PLANE_MULTIPLIER: f32 = 4096.0;

/// Renderer-neutral local camera frame derived from one canonical `MapCamera`.
///
/// The local plane uses CSS pixels around the current map center: +x is east, +y is north,
/// and z=0 is the map plane. Geographic precision is retained by the flat `MapCamera`; only
/// local offsets are converted to `f32` for the shared 3D camera/matrix boundary.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapLocalRenderFrame {
    flat_camera: MapCamera,
    shared_camera: PerspectiveCamera,
}

impl MapCamera {
    /// Derives the renderer-neutral local frame for this geographic camera.
    #[must_use]
    pub fn local_render_frame(self) -> Option<MapLocalRenderFrame> {
        let flat_camera = MapCamera::new(
            self.longitude,
            self.latitude,
            self.zoom,
            0.0,
            0.0,
            self.viewport,
        )?;

        let width = checked_f32(self.viewport.width)?;
        let height = checked_f32(self.viewport.height)?;
        let aspect = width / height;
        if !aspect.is_finite() || aspect <= 0.0 {
            return None;
        }

        let focal = 1.0 / (FIELD_OF_VIEW_Y_RADIANS * 0.5).tan();
        let distance = height * 0.5 * focal;
        if !distance.is_finite() || distance <= 0.0 {
            return None;
        }

        let bearing = checked_f32(self.bearing.to_radians())?;
        let pitch = checked_f32(self.pitch.to_radians())?;
        let (bearing_sin, bearing_cos) = bearing.sin_cos();
        let (pitch_sin, pitch_cos) = pitch.sin_cos();

        // Maps bearing is clockwise from north. The ground-space screen-up direction therefore
        // rotates from north (+y) toward east (+x) as bearing increases.
        let ground_up = Vec3::new(bearing_sin, bearing_cos, 0.0);
        let eye = Vec3::new(
            -ground_up.x * pitch_sin * distance,
            -ground_up.y * pitch_sin * distance,
            pitch_cos * distance,
        );
        let up = Vec3::new(ground_up.x * pitch_cos, ground_up.y * pitch_cos, pitch_sin);

        let near = (distance * 1.0e-4).max(0.01);
        let viewport_extent = width.max(height);
        let far = (distance + viewport_extent) * FAR_PLANE_MULTIPLIER;
        let shared_camera = PerspectiveCamera::new(
            eye,
            Vec3::ZERO,
            up,
            FIELD_OF_VIEW_Y_RADIANS,
            aspect,
            near,
            far,
        )
        .ok()?;

        Some(MapLocalRenderFrame {
            flat_camera,
            shared_camera,
        })
    }

    /// Projects through the matrix-backed camera while preserving Maps-owned geographic truth.
    #[must_use]
    pub fn project_screen_matrix(self, longitude: f64, latitude: f64) -> Option<ScreenCoordinate> {
        self.local_render_frame()?.project(longitude, latitude)
    }

    /// Unprojects through the matrix-backed camera onto the canonical flat map plane.
    ///
    /// Rays that do not hit the map plane inside the configured shared-camera depth range fail
    /// closed instead of inventing a geographic result beyond the horizon.
    #[must_use]
    pub fn unproject_screen_matrix(self, screen: ScreenCoordinate) -> Option<GeographicCoordinate> {
        self.local_render_frame()?.unproject(screen)
    }
}

impl MapLocalRenderFrame {
    /// Returns the shared renderer-neutral view/projection matrix in column-major order.
    #[must_use]
    pub fn view_projection_elements(self) -> [f32; 16] {
        self.shared_camera.view_projection_matrix().elements
    }

    /// Projects a geographic point through the local render frame.
    #[must_use]
    pub fn project(self, longitude: f64, latitude: f64) -> Option<ScreenCoordinate> {
        let flat = self.flat_camera.project_screen(longitude, latitude)?;
        let half_width = self.flat_camera.viewport.width * 0.5;
        let half_height = self.flat_camera.viewport.height * 0.5;
        let local = Vec3::new(
            checked_f32(flat.x - half_width)?,
            checked_f32(-(flat.y - half_height))?,
            0.0,
        );
        let ndc =
            transform_point_projective(self.shared_camera.view_projection_matrix(), local).ok()?;

        let x = (f64::from(ndc.x) + 1.0) * half_width;
        let y = (1.0 - f64::from(ndc.y)) * half_height;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }

        Some(ScreenCoordinate { x, y })
    }

    /// Intersects a screen ray with the canonical z=0 map plane and delegates final Mercator
    /// unprojection to the authoritative north-up `MapCamera` path.
    #[must_use]
    pub fn unproject(self, screen: ScreenCoordinate) -> Option<GeographicCoordinate> {
        if !screen.x.is_finite() || !screen.y.is_finite() {
            return None;
        }

        let width = self.flat_camera.viewport.width;
        let height = self.flat_camera.viewport.height;
        let ndc_x = checked_f32(screen.x / width * 2.0 - 1.0)?;
        let ndc_y = checked_f32(1.0 - screen.y / height * 2.0)?;
        let matrix = self.shared_camera.view_projection_matrix();
        let near = untransform_point_projective(matrix, Vec3::new(ndc_x, ndc_y, 0.0)).ok()?;
        let far = untransform_point_projective(matrix, Vec3::new(ndc_x, ndc_y, 1.0)).ok()?;
        let delta = Vec3::new(far.x - near.x, far.y - near.y, far.z - near.z);
        if !delta.z.is_finite() || delta.z.abs() <= RAY_EPSILON {
            return None;
        }

        let factor = -near.z / delta.z;
        if !factor.is_finite() || !(0.0..=1.0).contains(&factor) {
            return None;
        }

        let local_x = near.x + delta.x * factor;
        let local_y = near.y + delta.y * factor;
        let flat_screen = ScreenCoordinate {
            x: width * 0.5 + f64::from(local_x),
            y: height * 0.5 - f64::from(local_y),
        };
        self.flat_camera.unproject_screen(flat_screen)
    }
}

fn checked_f32(value: f64) -> Option<f32> {
    if !value.is_finite() || value.abs() > f64::from(f32::MAX) {
        return None;
    }
    Some(value as f32)
}
