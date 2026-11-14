//! Matrix-backed camera adapter between Maps-owned geographic semantics and shared 3D math.
//!
//! Geographic/Mercator state remains authoritative in `MapCamera`. This module rebases the
//! already-authoritative flat projection into a small CSS-pixel local frame before delegating
//! generic view/projection math to `3d-lab`. The shared camera/matrix remains `f32`, while the
//! projective bridge retains `f64` results for precision-sensitive map projection and ray work.

use crate::{GeographicCoordinate, MapCamera, ScreenCoordinate};
use three_d_animation::Mat4;
use three_d_camera::PerspectiveCamera;
use three_d_core::Vec3;
use three_d_projective::{transform_point_projective_f64, untransform_point_projective_f64};

/// MapLibre's default vertical field of view (`TransformHelper._fovInRadians`, about 36.87°).
pub const FIELD_OF_VIEW_Y_RADIANS: f64 = 0.643_501_108_793_284_4;
/// MapLibre's `maxMercatorHorizonAngle`: the steepest view angle at which ground is drawn.
pub const MAX_MERCATOR_HORIZON_ANGLE_DEGREES: f64 = 89.25;
const RAY_EPSILON: f64 = 1.0e-12;

/// Local-map-plane bounds for the ground visible through a viewport.
///
/// Coordinates use the same CSS-pixel local frame as raster placements: +x east, +y north.
/// As MapLibre's `getBounds`, a viewport reaching past the Mercator horizon is bounded by the
/// horizon line rather than its top edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapLocalViewportBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// Renderer-neutral local camera frame derived from one canonical `MapCamera`.
///
/// The local plane uses CSS pixels around the current map center: +x is east, +y is north,
/// and z=0 is the map plane. Geographic precision is retained by the flat `MapCamera`; the
/// shared camera owns only generic local-frame view/projection math.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapLocalRenderFrame {
    flat_camera: MapCamera,
    view_projection: Mat4,
    pitch_degrees: f64,
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

        let distance = camera_to_center_distance(self.viewport.height);
        if !distance.is_finite() || distance <= 0.0 {
            return None;
        }

        let pitch_radians = self.pitch.to_radians();
        let (near, far) = near_far_z(self.viewport.height, distance, pitch_radians);
        let (near, far, distance) = (
            checked_f32(near)?,
            checked_f32(far)?,
            checked_f32(distance)?,
        );
        let bearing = checked_f32(self.bearing.to_radians())?;
        let pitch = checked_f32(pitch_radians)?;
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

        let shared_camera = PerspectiveCamera::new(
            eye,
            Vec3::ZERO,
            up,
            FIELD_OF_VIEW_Y_RADIANS as f32,
            aspect,
            near,
            far,
        )
        .ok()?;

        Some(MapLocalRenderFrame {
            flat_camera,
            view_projection: shared_camera.view_projection_matrix(),
            pitch_degrees: self.pitch,
        })
    }

    /// Projects through the matrix-backed camera while preserving Maps-owned geographic truth.
    #[must_use]
    pub fn project_screen_matrix(self, longitude: f64, latitude: f64) -> Option<ScreenCoordinate> {
        self.local_render_frame()?.project(longitude, latitude)
    }

    /// Unprojects through the matrix-backed camera onto the canonical flat map plane.
    ///
    /// Rays that do not produce a valid forward intersection with the map plane fail closed
    /// instead of inventing a geographic result beyond the horizon.
    #[must_use]
    pub fn unproject_screen_matrix(self, screen: ScreenCoordinate) -> Option<GeographicCoordinate> {
        self.local_render_frame()?.unproject(screen)
    }

    /// The local screen-to-map-plane scale at a screen point; see
    /// [`MapLocalRenderFrame::map_plane_scale`].
    #[must_use]
    pub fn map_plane_scale_matrix(self, screen: ScreenCoordinate) -> Option<[f64; 4]> {
        self.local_render_frame()?.map_plane_scale(screen)
    }

    /// Returns the local ground bounds visible under this camera, stopping at the Mercator
    /// horizon line as MapLibre's `getBounds` does. Tile covers use the camera frustum instead
    /// (`terrain::covering_tiles`).
    #[must_use]
    pub fn local_viewport_bounds_matrix(self) -> Option<MapLocalViewportBounds> {
        self.local_render_frame()?.viewport_ground_bounds()
    }
}

impl MapLocalRenderFrame {
    /// Returns the shared renderer-neutral view/projection matrix in column-major order.
    #[must_use]
    pub fn view_projection_elements(self) -> [f32; 16] {
        self.view_projection.elements
    }

    /// Projects a geographic point through the local render frame.
    #[must_use]
    pub fn project(self, longitude: f64, latitude: f64) -> Option<ScreenCoordinate> {
        let flat = self.flat_camera.project_screen(longitude, latitude)?;
        let half_width = self.flat_camera.viewport.width * 0.5;
        let half_height = self.flat_camera.viewport.height * 0.5;
        let local = [flat.x - half_width, -(flat.y - half_height), 0.0];
        let ndc = transform_point_projective_f64(self.view_projection, local).ok()?;

        // The shared perspective camera uses WebGPU depth semantics. A finite projective result
        // outside the forward [0, 1] depth interval is behind the eye or outside the configured
        // near/far frustum and must not be mirrored back onto the map screen.
        if !(0.0..=1.0).contains(&ndc[2]) {
            return None;
        }

        let x = (ndc[0] + 1.0) * half_width;
        let y = (1.0 - ndc[1]) * half_height;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }

        Some(ScreenCoordinate { x, y })
    }

    /// Intersects a screen ray with the canonical z=0 map plane and delegates final Mercator
    /// unprojection to the authoritative north-up `MapCamera` path.
    #[must_use]
    pub fn unproject(self, screen: ScreenCoordinate) -> Option<GeographicCoordinate> {
        let [local_x, local_y] = self.unproject_local(screen)?;
        let flat_screen = ScreenCoordinate {
            x: self.flat_camera.viewport.width * 0.5 + local_x,
            y: self.flat_camera.viewport.height * 0.5 - local_y,
        };
        self.flat_camera.unproject_screen(flat_screen)
    }

    /// The local linear map from screen offsets to map-plane offsets at a screen point,
    /// row-major `[a, b, c, d]`: a screen offset `(dx, dy)` spans `(a·dx + b·dy, c·dx + d·dy)`
    /// CSS pixels of the map plane at the camera zoom (+x east, +y south, as the screen).
    ///
    /// MapLibre measures a line's width on this plane (`queryIntersectsFeature` in tile units),
    /// so under pitch a screen pixel far from the camera covers more of it. The derivative of the
    /// plane intersection is taken as a central difference of half a pixel; a point beyond the
    /// horizon has none.
    #[must_use]
    pub fn map_plane_scale(self, screen: ScreenCoordinate) -> Option<[f64; 4]> {
        const STEP: f64 = 0.5;
        let at = |dx: f64, dy: f64| {
            self.unproject_local(ScreenCoordinate {
                x: screen.x + dx,
                y: screen.y + dy,
            })
        };
        let [left, right, up, down] = [
            at(-STEP, 0.0)?,
            at(STEP, 0.0)?,
            at(0.0, -STEP)?,
            at(0.0, STEP)?,
        ];
        let span = 2.0 * STEP;
        // The local frame's +y is north; the screen's is south.
        let scale = [
            (right[0] - left[0]) / span,
            (down[0] - up[0]) / span,
            -(right[1] - left[1]) / span,
            -(down[1] - up[1]) / span,
        ];
        scale.iter().all(|value| value.is_finite()).then_some(scale)
    }

    /// Returns the axis-aligned bound of the ground footprint in the local map plane.
    ///
    /// As MapLibre's `getBounds`, the top edge stops at the Mercator horizon line
    /// (`getMercatorHorizon`) when the viewport reaches past it, so a steep camera has finite
    /// bounds of the ground below that line.
    #[must_use]
    pub fn viewport_ground_bounds(self) -> Option<MapLocalViewportBounds> {
        let width = self.flat_camera.viewport.width;
        let height = self.flat_camera.viewport.height;
        let top = screen_horizon_y(height, self.pitch_degrees).max(0.0);
        let corners = [
            ScreenCoordinate { x: 0.0, y: top },
            ScreenCoordinate { x: width, y: top },
            ScreenCoordinate {
                x: width,
                y: height,
            },
            ScreenCoordinate { x: 0.0, y: height },
        ];

        let mut west = f64::INFINITY;
        let mut south = f64::INFINITY;
        let mut east = f64::NEG_INFINITY;
        let mut north = f64::NEG_INFINITY;
        for corner in corners {
            let [x, y] = self.unproject_local(corner)?;
            west = west.min(x);
            east = east.max(x);
            south = south.min(y);
            north = north.max(y);
        }

        if ![west, south, east, north].into_iter().all(f64::is_finite)
            || west > east
            || south > north
        {
            return None;
        }

        Some(MapLocalViewportBounds {
            west,
            south,
            east,
            north,
        })
    }

    fn unproject_local(self, screen: ScreenCoordinate) -> Option<[f64; 2]> {
        if !screen.x.is_finite() || !screen.y.is_finite() {
            return None;
        }

        let width = self.flat_camera.viewport.width;
        let height = self.flat_camera.viewport.height;
        let ndc_x = screen.x / width * 2.0 - 1.0;
        let ndc_y = 1.0 - screen.y / height * 2.0;
        let matrix = self.view_projection;

        // Avoid NDC depth 1.0 here. With a very large finite far plane, the f32 WebGPU
        // projection can round to the infinite-far form where exact depth 1 represents infinity.
        // Any two finite samples on the same projective ray define the same map-plane hit.
        let ray_start = untransform_point_projective_f64(matrix, [ndc_x, ndc_y, 0.0]).ok()?;
        let ray_sample = untransform_point_projective_f64(matrix, [ndc_x, ndc_y, 0.5]).ok()?;
        let delta = [
            ray_sample[0] - ray_start[0],
            ray_sample[1] - ray_start[1],
            ray_sample[2] - ray_start[2],
        ];
        if !delta[2].is_finite() || delta[2].abs() <= RAY_EPSILON {
            return None;
        }

        let factor = -ray_start[2] / delta[2];
        if !factor.is_finite() || factor < 0.0 {
            return None;
        }

        let local_x = ray_start[0] + delta[0] * factor;
        let local_y = ray_start[1] + delta[1] * factor;
        if !local_x.is_finite() || !local_y.is_finite() {
            return None;
        }

        Some([local_x, local_y])
    }
}

/// MapLibre's `cameraToCenterDistance`: eye-to-center distance in CSS pixels.
#[must_use]
pub fn camera_to_center_distance(viewport_height: f64) -> f64 {
    0.5 / (FIELD_OF_VIEW_Y_RADIANS * 0.5).tan() * viewport_height
}

/// The Mercator horizon line, in CSS pixels down from the viewport's top edge; not positive
/// when the viewport does not reach it.
#[must_use]
pub fn screen_horizon_y(viewport_height: f64, pitch_degrees: f64) -> f64 {
    viewport_height / 2.0 - mercator_horizon(viewport_height, pitch_degrees)
}

/// MapLibre's `getMercatorHorizon`: the horizon line's height above the viewport center in CSS
/// pixels, short of the true horizon to simulate the earth's curvature.
#[must_use]
pub fn mercator_horizon(viewport_height: f64, pitch_degrees: f64) -> f64 {
    camera_to_center_distance(viewport_height)
        * ((90.0 - pitch_degrees).to_radians().tan() * 0.85).min(
            (MAX_MERCATOR_HORIZON_ANGLE_DEGREES - pitch_degrees)
                .to_radians()
                .tan(),
        )
}

/// MapLibre's `MercatorTransform._calculateNearFarZ` for a camera on the ground plane with no
/// roll or center offset: the far plane sits just beyond the farthest visible ground point
/// (or the mercator horizon), the near plane at `height / 50`.
fn near_far_z(height: f64, distance: f64, pitch: f64) -> (f64, f64) {
    use core::f64::consts::{FRAC_PI_2, PI};

    let limited_pitch = pitch.min(MAX_MERCATOR_HORIZON_ANGLE_DEGREES.to_radians());
    let ground_angle = FRAC_PI_2 + pitch;
    let clamp_angle = |angle: f64| angle.clamp(0.01, PI - 0.01);
    let surface_distance =
        |fov: f64| fov.sin() * distance / clamp_angle(PI - ground_angle - fov).sin();

    let pitch_degrees = pitch.to_degrees();
    let horizon = distance
        * ((90.0 - pitch_degrees).to_radians().tan() * 0.85).min(
            (MAX_MERCATOR_HORIZON_ANGLE_DEGREES - pitch_degrees)
                .to_radians()
                .tan(),
        );
    let horizon_angle = (horizon / distance).atan();
    let min_fov_center_to_horizon = (90.0 - MAX_MERCATOR_HORIZON_ANGLE_DEGREES).to_radians();
    let fov_center_to_horizon = if horizon_angle > min_fov_center_to_horizon {
        horizon_angle
    } else {
        min_fov_center_to_horizon
    };

    let top_half_min_distance = surface_distance(FIELD_OF_VIEW_Y_RADIANS * 0.5)
        .min(surface_distance(fov_center_to_horizon));
    let far = ((FRAC_PI_2 - limited_pitch).cos() * top_half_min_distance + distance) * 1.01;
    (height / 50.0, far)
}

fn checked_f32(value: f64) -> Option<f32> {
    if !value.is_finite() || value.abs() > f64::from(f32::MAX) {
        return None;
    }
    Some(value as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ViewportSize;

    fn camera(bearing: f64, pitch: f64) -> MapCamera {
        MapCamera::new(
            13.405,
            52.52,
            8.0,
            bearing,
            pitch,
            ViewportSize::new(800.0, 600.0).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn north_up_viewport_footprint_matches_half_viewport_extents() {
        let bounds = camera(0.0, 0.0).local_viewport_bounds_matrix().unwrap();

        assert!((bounds.west + 400.0).abs() < 1.0e-3, "west={}", bounds.west);
        assert!((bounds.east - 400.0).abs() < 1.0e-3, "east={}", bounds.east);
        assert!(
            (bounds.south + 300.0).abs() < 1.0e-3,
            "south={}",
            bounds.south
        );
        assert!(
            (bounds.north - 300.0).abs() < 1.0e-3,
            "north={}",
            bounds.north
        );
    }

    #[test]
    fn bearing_expands_axis_aligned_tile_cover_footprint() {
        let base = camera(0.0, 0.0).local_viewport_bounds_matrix().unwrap();
        let rotated = camera(45.0, 0.0).local_viewport_bounds_matrix().unwrap();

        assert!(rotated.west < base.west);
        assert!(rotated.east > base.east);
        assert!(rotated.south < base.south);
        assert!(rotated.north > base.north);
    }

    #[test]
    fn practical_pitch_has_finite_conservative_ground_footprint() {
        let bounds = camera(30.0, 60.0).local_viewport_bounds_matrix().unwrap();

        assert!(bounds.west.is_finite());
        assert!(bounds.east.is_finite());
        assert!(bounds.south.is_finite());
        assert!(bounds.north.is_finite());
        assert!(bounds.west < bounds.east);
        assert!(bounds.south < bounds.north);
    }

    #[test]
    fn camera_crossing_ground_horizon_is_bounded_by_the_mercator_horizon() {
        let frame = camera(0.0, 85.0).local_render_frame().unwrap();
        // The viewport's top edge looks past the ground horizon.
        assert!(
            frame
                .unproject(ScreenCoordinate { x: 400.0, y: 0.0 })
                .is_none()
        );

        let bounds = camera(0.0, 85.0).local_viewport_bounds_matrix().unwrap();
        let below = camera(0.0, 60.0).local_viewport_bounds_matrix().unwrap();
        assert!(
            [bounds.west, bounds.south, bounds.east, bounds.north]
                .into_iter()
                .all(f64::is_finite)
        );
        assert!(bounds.north > below.north);
        assert!(bounds.west < bounds.east && bounds.south < bounds.north);
    }

    fn plane_scale(camera: MapCamera, x: f64, y: f64) -> [f64; 4] {
        camera
            .map_plane_scale_matrix(ScreenCoordinate { x, y })
            .unwrap()
    }

    #[test]
    fn map_plane_scale_measures_screen_offsets_on_the_pitched_map_plane() {
        // North-up: at the center a horizontal screen pixel is one map-plane pixel (MapLibre's
        // camera-to-center distance), and a vertical one is foreshortened by the pitch.
        let pitched = camera(0.0, 60.0);
        let [a, b, c, d] = plane_scale(pitched, 400.0, 300.0);
        assert!((a - 1.0).abs() < 1.0e-3, "a={a}");
        assert!(b.abs() < 1.0e-3 && c.abs() < 1.0e-3, "b={b} c={c}");
        assert!(d > 1.5, "d={d}");

        // Farther up the map, one screen pixel spans more of the map plane; nearer, less.
        let [far_a, _, _, far_d] = plane_scale(pitched, 400.0, 100.0);
        let [near_a, _, _, near_d] = plane_scale(pitched, 400.0, 580.0);
        assert!(far_a > a && far_d > d, "far={far_a},{far_d}");
        assert!(near_a < a && near_d < d, "near={near_a},{near_d}");

        // A finite difference of the authoritative unprojection agrees.
        let frame = pitched.local_render_frame().unwrap();
        let local = |x: f64, y: f64| frame.unproject_local(ScreenCoordinate { x, y }).unwrap();
        let [x0, y0] = local(400.0, 99.95);
        let [x1, y1] = local(400.0, 100.05);
        let measured = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt() / 0.1;
        assert!(
            (measured - far_d).abs() / far_d < 1.0e-3,
            "{measured} vs {far_d}"
        );

        // Unpitched, the map plane is the screen up to the bearing's rotation.
        let [a, b, c, d] = plane_scale(camera(30.0, 0.0), 120.0, 80.0);
        assert!((a * d - b * c - 1.0).abs() < 1.0e-6);
        assert!((a * a + c * c - 1.0).abs() < 1.0e-6);
        assert!(
            camera(0.0, 85.0)
                .map_plane_scale_matrix(ScreenCoordinate { x: 400.0, y: 0.0 })
                .is_none()
        );
    }
}
