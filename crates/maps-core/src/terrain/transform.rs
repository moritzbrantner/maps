//! MapLibre 6.15's Web Mercator camera with terrain (`MercatorTransform._calcMatrices`,
//! `_calculateNearFarZ`, `getCameraFrustum`, `cameraMercatorCoordinate`).
//!
//! World coordinates are MapLibre's: x and y in pixels of a `512 · 2^zoom` world, z in meters
//! (the view-projection scales z by `pixelPerMeter`). Matrices are column-major `f64` because
//! MapLibre composes them in `Float64Array`s and the terrain's elevated camera needs that
//! precision; they are narrowed to `f32` per tile, as MapLibre's tile matrices are.

use core::f64::consts::{FRAC_PI_2, PI};

use crate::matrix_camera::{FIELD_OF_VIEW_Y_RADIANS, MAX_MERCATOR_HORIZON_ANGLE_DEGREES};

/// MapLibre's `earthRadius` (m) and the equatorial circumference it implies.
pub const EARTH_RADIUS_METERS: f64 = 6_371_008.8;
pub const EARTH_CIRCUMFERENCE_METERS: f64 = 2.0 * PI * EARTH_RADIUS_METERS;
/// Tile-local coordinate extent (`EXTENT`).
pub const TILE_EXTENT: f64 = 8192.0;

pub type Mat4 = [f64; 16];

/// One camera state, as MapLibre's transform holds it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainCamera {
    pub longitude: f64,
    pub latitude: f64,
    pub zoom: f64,
    /// Degrees, clockwise from north.
    pub bearing: f64,
    pub pitch: f64,
    /// CSS pixels.
    pub width: f64,
    pub height: f64,
    /// Terrain elevation (m) under the center (`transform.elevation`).
    pub elevation: f64,
    /// Lowest elevation (m) of the DEM tile under the center (`minElevationForCurrentTile`).
    pub min_elevation_for_current_tile: f64,
}

/// The derived matrices and camera placement of a [`TerrainCamera`].
#[derive(Clone, Debug)]
pub struct TerrainTransform {
    pub camera: TerrainCamera,
    pub world_size: f64,
    pub pixel_per_meter: f64,
    pub camera_to_center_distance: f64,
    /// Center in world pixels.
    pub center_x: f64,
    pub center_y: f64,
    pub near_z: f64,
    pub far_z: f64,
    /// World (px, px, m) to GL clip space.
    pub view_projection: Mat4,
    pub inverse_view_projection: Mat4,
    /// `view_projection` shifted to the pixel grid for raster-like tiles (`_alignedProjMatrix`).
    pub aligned_view_projection: Mat4,
}

impl TerrainTransform {
    #[must_use]
    pub fn new(camera: TerrainCamera) -> Option<Self> {
        if !(camera.width > 0.0 && camera.height > 0.0) {
            return None;
        }
        let world_size = 512.0 * 2_f64.powf(camera.zoom);
        let latitude = camera
            .latitude
            .clamp(-85.051_128_779_806_59, 85.051_128_779_806_59);
        let pixel_per_meter = world_size / circumference_at_latitude(latitude);
        let camera_to_center_distance = 0.5 / (FIELD_OF_VIEW_Y_RADIANS / 2.0).tan() * camera.height;
        let (center_x, center_y) = world_pixels(camera.longitude, latitude, world_size);
        let pitch = camera.pitch.to_radians();
        let bearing = camera.bearing.to_radians();

        let limited_pitch = camera
            .pitch
            .min(MAX_MERCATOR_HORIZON_ANGLE_DEGREES)
            .to_radians();
        let camera_to_sea_level = (camera_to_center_distance / 2.0).max(
            camera_to_center_distance + camera.elevation * pixel_per_meter / limited_pitch.cos(),
        );

        // `_calculateNearFarZ` without roll or center offset.
        let camera_altitude =
            pitch.cos() * camera_to_center_distance / pixel_per_meter + camera.elevation;
        let min_elevation = camera
            .elevation
            .min(camera.min_elevation_for_current_tile)
            .min(camera_altitude - 100.0);
        let lowest_plane = if min_elevation < 0.0 {
            camera_to_sea_level - min_elevation * pixel_per_meter / limited_pitch.cos()
        } else {
            camera_to_sea_level
        };
        let ground_angle = FRAC_PI_2 + pitch;
        let clamp_angle = |angle: f64| angle.clamp(0.01, PI - 0.01);
        let fov_above_center = FIELD_OF_VIEW_Y_RADIANS * 0.5;
        let top_half_surface = fov_above_center.sin() * lowest_plane
            / clamp_angle(PI - ground_angle - fov_above_center).sin();
        let horizon = camera_to_center_distance
            * ((90.0 - camera.pitch).to_radians().tan() * 0.85).min(
                (MAX_MERCATOR_HORIZON_ANGLE_DEGREES - camera.pitch)
                    .to_radians()
                    .tan(),
            );
        let horizon_angle = (horizon / camera_to_center_distance).atan();
        let min_fov_center_to_horizon = (90.0 - MAX_MERCATOR_HORIZON_ANGLE_DEGREES).to_radians();
        let fov_center_to_horizon = if horizon_angle > min_fov_center_to_horizon {
            2.0 * horizon_angle * 0.5
        } else {
            min_fov_center_to_horizon
        };
        let top_half_horizon = fov_center_to_horizon.sin() * lowest_plane
            / clamp_angle(PI - ground_angle - fov_center_to_horizon).sin();
        let top_half_min = top_half_surface.min(top_half_horizon);
        let far_z = ((FRAC_PI_2 - limited_pitch).cos() * top_half_min + lowest_plane) * 1.01;
        let near_z = camera.height / 50.0;

        let mut m = perspective(
            FIELD_OF_VIEW_Y_RADIANS,
            camera.width / camera.height,
            near_z,
            far_z,
        );
        m = scale(m, [1.0, -1.0, 1.0]);
        m = translate(m, [0.0, 0.0, -camera_to_center_distance]);
        m = rotate_x(m, pitch);
        m = rotate_z(m, -bearing);
        m = translate(m, [-center_x, -center_y, 0.0]);
        m = scale(m, [1.0, 1.0, pixel_per_meter]);
        m = translate(m, [0.0, 0.0, -camera.elevation]);
        let view_projection = m;
        let inverse_view_projection = invert(view_projection)?;

        let x_shift = (camera.width % 2.0) / 2.0;
        let y_shift = (camera.height % 2.0) / 2.0;
        let angle_cos = bearing.cos();
        let angle_sin = (-bearing).sin();
        let dx = center_x - center_x.round() + angle_cos * x_shift + angle_sin * y_shift;
        let dy = center_y - center_y.round() + angle_cos * y_shift + angle_sin * x_shift;
        let aligned_view_projection = translate(
            view_projection,
            [
                if dx > 0.5 { dx - 1.0 } else { dx },
                if dy > 0.5 { dy - 1.0 } else { dy },
                0.0,
            ],
        );

        Some(Self {
            camera,
            world_size,
            pixel_per_meter,
            camera_to_center_distance,
            center_x,
            center_y,
            near_z,
            far_z,
            view_projection,
            inverse_view_projection,
            aligned_view_projection,
        })
    }

    /// `calculateTileMatrix`: tile-local `0..EXTENT` (z in meters) to world.
    #[must_use]
    pub fn tile_matrix(&self, z: u8, x: u32, y: u32, wrap: i32) -> Mat4 {
        let tiles = f64::from(1_u32 << z);
        let scale_px = self.world_size / tiles;
        let unwrapped_x = f64::from(x) + tiles * f64::from(wrap);
        let mut m = identity();
        m = translate(m, [unwrapped_x * scale_px, f64::from(y) * scale_px, 0.0]);
        scale(m, [scale_px / TILE_EXTENT, scale_px / TILE_EXTENT, 1.0])
    }

    /// Tile-local to clip space (`calculatePosMatrix`).
    #[must_use]
    pub fn tile_pos_matrix(&self, z: u8, x: u32, y: u32, wrap: i32, aligned: bool) -> Mat4 {
        let base = if aligned {
            self.aligned_view_projection
        } else {
            self.view_projection
        };
        multiply(base, self.tile_matrix(z, x, y, wrap))
    }

    /// Camera position in Mercator units, its altitude in Mercator units too
    /// (`cameraMercatorCoordinate`).
    #[must_use]
    pub fn camera_mercator(&self) -> [f64; 3] {
        let [cx, cy, cz] = self.center_mercator();
        let pitch = self.camera.pitch.to_radians();
        let bearing = self.camera.bearing.to_radians();
        let (dir_x, dir_y, dir_z) = (
            pitch.sin() * bearing.sin(),
            -pitch.sin() * bearing.cos(),
            (-pitch).cos(),
        );
        let distance = self.camera_to_center_distance / self.world_size;
        [
            cx - distance * dir_x,
            cy - distance * dir_y,
            cz + distance * dir_z,
        ]
    }

    /// The center in Mercator units, its elevation in Mercator units.
    #[must_use]
    pub fn center_mercator(&self) -> [f64; 3] {
        let latitude = self.camera.latitude;
        [
            self.center_x / self.world_size,
            self.center_y / self.world_size,
            self.camera.elevation / circumference_at_latitude(latitude),
        ]
    }

    /// `Frustum.fromInvProjectionMatrix(invViewProj, worldSize)`: x/y in Mercator units, z in m.
    #[must_use]
    pub fn frustum(&self) -> Frustum {
        const CORNERS: [[f64; 4]; 8] = [
            [-1.0, 1.0, -1.0, 1.0],
            [1.0, 1.0, -1.0, 1.0],
            [1.0, -1.0, -1.0, 1.0],
            [-1.0, -1.0, -1.0, 1.0],
            [-1.0, 1.0, 1.0, 1.0],
            [1.0, 1.0, 1.0, 1.0],
            [1.0, -1.0, 1.0, 1.0],
            [-1.0, -1.0, 1.0, 1.0],
        ];
        const PLANES: [[usize; 3]; 6] = [
            [0, 1, 2],
            [6, 5, 4],
            [0, 3, 7],
            [2, 1, 5],
            [3, 2, 6],
            [0, 4, 5],
        ];
        let points = CORNERS.map(|corner| {
            let v = transform_vec4(self.inverse_view_projection, corner);
            let s = 1.0 / v[3] / self.world_size;
            [v[0] * s, v[1] * s, v[2] / v[3]]
        });
        let planes = PLANES.map(|[a, b, c]| {
            let u = sub(points[a], points[b]);
            let v = sub(points[c], points[b]);
            let n = normalize(cross(u, v));
            [n[0], n[1], n[2], -dot(n, points[b])]
        });
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for point in points {
            for axis in 0..3 {
                min[axis] = min[axis].min(point[axis]);
                max[axis] = max[axis].max(point[axis]);
            }
        }
        Frustum { planes, min, max }
    }

    /// Clip-space matrix for WebGPU (`z` in `0..1`): `M' = D · M`.
    #[must_use]
    pub fn webgpu_clip(matrix: Mat4) -> Mat4 {
        let mut depth = identity();
        depth[10] = 0.5;
        depth[14] = 0.5;
        multiply(depth, matrix)
    }
}

/// A camera frustum: inward planes `[nx, ny, nz, d]` and the corners' bounds.
#[derive(Clone, Copy, Debug)]
pub struct Frustum {
    pub planes: [[f64; 4]; 6],
    pub min: [f64; 3],
    pub max: [f64; 3],
}

/// Equatorial circumference scaled to a latitude (m).
#[must_use]
pub fn circumference_at_latitude(latitude: f64) -> f64 {
    EARTH_CIRCUMFERENCE_METERS * latitude.to_radians().cos()
}

/// World pixels of a longitude/latitude in a `world_size` world.
#[must_use]
pub fn world_pixels(longitude: f64, latitude: f64, world_size: f64) -> (f64, f64) {
    let x = (180.0 + longitude) / 360.0;
    let y = (180.0 - (180.0 / PI) * ((PI / 4.0 + latitude.to_radians() / 2.0).tan()).ln()) / 360.0;
    (x * world_size, y * world_size)
}

/// Latitude (degrees) of a Mercator y in `0..1`.
#[must_use]
pub fn latitude_of_mercator_y(y: f64) -> f64 {
    let y2 = 180.0 - y * 360.0;
    360.0 / PI * (y2.to_radians()).exp().atan() - 90.0
}

#[must_use]
pub fn identity() -> Mat4 {
    let mut m = [0.0; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m
}

fn perspective(fovy: f64, aspect: f64, near: f64, far: f64) -> Mat4 {
    let f = 1.0 / (fovy / 2.0).tan();
    let nf = 1.0 / (near - far);
    let mut m = [0.0; 16];
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1.0;
    m[14] = 2.0 * far * near * nf;
    m
}

/// `a · b`, column-major.
#[must_use]
pub fn multiply(a: Mat4, b: Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            out[column * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[column * 4 + k]).sum();
        }
    }
    out
}

#[must_use]
pub fn translate(m: Mat4, [x, y, z]: [f64; 3]) -> Mat4 {
    let mut out = m;
    for row in 0..4 {
        out[12 + row] = m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row];
    }
    out
}

#[must_use]
pub fn scale(m: Mat4, [x, y, z]: [f64; 3]) -> Mat4 {
    let mut out = m;
    for row in 0..4 {
        out[row] *= x;
        out[4 + row] *= y;
        out[8 + row] *= z;
    }
    out
}

fn rotate_x(m: Mat4, angle: f64) -> Mat4 {
    let (s, c) = angle.sin_cos();
    let mut out = m;
    for row in 0..4 {
        let (a1, a2) = (m[4 + row], m[8 + row]);
        out[4 + row] = a1 * c + a2 * s;
        out[8 + row] = a2 * c - a1 * s;
    }
    out
}

fn rotate_z(m: Mat4, angle: f64) -> Mat4 {
    let (s, c) = angle.sin_cos();
    let mut out = m;
    for row in 0..4 {
        let (a0, a1) = (m[row], m[4 + row]);
        out[row] = a0 * c + a1 * s;
        out[4 + row] = a1 * c - a0 * s;
    }
    out
}

/// Ortho projection (`mat4.ortho`), GL depth.
#[must_use]
pub fn ortho(left: f64, right: f64, bottom: f64, top: f64, near: f64, far: f64) -> Mat4 {
    let lr = 1.0 / (left - right);
    let bt = 1.0 / (bottom - top);
    let nf = 1.0 / (near - far);
    let mut m = [0.0; 16];
    m[0] = -2.0 * lr;
    m[5] = -2.0 * bt;
    m[10] = 2.0 * nf;
    m[12] = (left + right) * lr;
    m[13] = (top + bottom) * bt;
    m[14] = (far + near) * nf;
    m[15] = 1.0;
    m
}

fn transform_vec4(m: Mat4, v: [f64; 4]) -> [f64; 4] {
    let mut out = [0.0; 4];
    for (row, value) in out.iter_mut().enumerate() {
        *value = (0..4).map(|k| m[k * 4 + row] * v[k]).sum();
    }
    out
}

/// Projects a world point through a matrix to clip space.
#[cfg(test)]
#[must_use]
pub fn project(m: Mat4, point: [f64; 3]) -> [f64; 4] {
    transform_vec4(m, [point[0], point[1], point[2], 1.0])
}

#[must_use]
pub fn invert(a: Mat4) -> Option<Mat4> {
    let [
        a00,
        a01,
        a02,
        a03,
        a10,
        a11,
        a12,
        a13,
        a20,
        a21,
        a22,
        a23,
        a30,
        a31,
        a32,
        a33,
    ] = a;
    let b00 = a00 * a11 - a01 * a10;
    let b01 = a00 * a12 - a02 * a10;
    let b02 = a00 * a13 - a03 * a10;
    let b03 = a01 * a12 - a02 * a11;
    let b04 = a01 * a13 - a03 * a11;
    let b05 = a02 * a13 - a03 * a12;
    let b06 = a20 * a31 - a21 * a30;
    let b07 = a20 * a32 - a22 * a30;
    let b08 = a20 * a33 - a23 * a30;
    let b09 = a21 * a32 - a22 * a31;
    let b10 = a21 * a33 - a23 * a31;
    let b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let d = 1.0 / det;
    Some([
        (a11 * b11 - a12 * b10 + a13 * b09) * d,
        (a02 * b10 - a01 * b11 - a03 * b09) * d,
        (a31 * b05 - a32 * b04 + a33 * b03) * d,
        (a22 * b04 - a21 * b05 - a23 * b03) * d,
        (a12 * b08 - a10 * b11 - a13 * b07) * d,
        (a00 * b11 - a02 * b08 + a03 * b07) * d,
        (a32 * b02 - a30 * b05 - a33 * b01) * d,
        (a20 * b05 - a22 * b02 + a23 * b01) * d,
        (a10 * b10 - a11 * b08 + a13 * b06) * d,
        (a01 * b08 - a00 * b10 - a03 * b06) * d,
        (a30 * b04 - a31 * b02 + a33 * b00) * d,
        (a21 * b02 - a20 * b04 - a23 * b00) * d,
        (a11 * b07 - a10 * b09 - a12 * b06) * d,
        (a00 * b09 - a01 * b07 + a02 * b06) * d,
        (a31 * b01 - a30 * b03 - a32 * b00) * d,
        (a20 * b03 - a21 * b01 + a22 * b00) * d,
    ])
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(a: [f64; 3]) -> [f64; 3] {
    let length = dot(a, a).sqrt();
    if length > 0.0 {
        [a[0] / length, a[1] / length, a[2] / length]
    } else {
        a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera(pitch: f64, elevation: f64) -> TerrainCamera {
        TerrainCamera {
            longitude: 9.0,
            latitude: 47.2,
            zoom: 8.0,
            bearing: 20.0,
            pitch,
            width: 720.0,
            height: 480.0,
            elevation,
            min_elevation_for_current_tile: 0.0,
        }
    }

    #[test]
    fn center_projects_to_the_viewport_center_at_its_elevation() {
        let transform = TerrainTransform::new(camera(55.0, 2000.0)).unwrap();
        let clip = project(
            transform.view_projection,
            [transform.center_x, transform.center_y, 2000.0],
        );
        assert!((clip[0] / clip[3]).abs() < 1e-9);
        assert!((clip[1] / clip[3]).abs() < 1e-9);
    }

    #[test]
    fn inverse_round_trips() {
        let transform = TerrainTransform::new(camera(40.0, 0.0)).unwrap();
        let product = multiply(transform.view_projection, transform.inverse_view_projection);
        for (index, value) in product.iter().enumerate() {
            let expected = if index % 5 == 0 { 1.0 } else { 0.0 };
            assert!((value - expected).abs() < 1e-6, "{index}: {value}");
        }
    }

    #[test]
    fn latitude_inverts_world_pixels() {
        let (_, y) = world_pixels(0.0, 47.2, 1.0);
        assert!((latitude_of_mercator_y(y) - 47.2).abs() < 1e-9);
    }
}
