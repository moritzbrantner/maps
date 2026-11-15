//! Animated flat-map camera flight (#433).
//!
//! A [`CameraFlight`] is the Maps-owned trajectory of an animated `flyTo`. It follows
//! MapLibre's `flyTo` path so the first-party runtime matches the MapLibre reference
//! implementation: van Wijk & Nuij's "optimal" zoom-out/zoom-back curve over the Web
//! Mercator plane with MapLibre's default `curve` (ρ = 1.42) and `speed` (1.2), eased by
//! MapLibre's default cubic Bézier `(0.25, 0.1, 0.25, 1)`. The center is interpolated in
//! Mercator world space along the shortest path across the antimeridian, the bearing along
//! the shortest arc, and the pitch linearly.
//!
//! The trajectory is pure and deterministic: a sample depends only on the elapsed time
//! since the flight started. Hosts own the scheduler (one animation-frame loop); the
//! runtime owns the camera state, constraints and cancellation.

use crate::{
    MapCamera, WorldCoordinate, project_web_mercator, unproject_web_mercator, wrap_longitude,
};

/// MapLibre's default `flyTo` `curve` (ρ).
pub const CAMERA_FLIGHT_CURVE: f64 = 1.42;
/// MapLibre's default `flyTo` `speed`: ρ-screenfuls per second.
pub const CAMERA_FLIGHT_SPEED: f64 = 1.2;
/// MapLibre's default `easeTo` duration, used when a flight only rotates or pitches.
pub const CAMERA_EASE_DEFAULT_DURATION_MS: f64 = 500.0;

const CAMERA_TILE_SIZE: f64 = 512.0;

/// A geographic camera pose: what a flight presents at one instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraPose {
    pub longitude: f64,
    pub latitude: f64,
    pub zoom: f64,
    pub bearing: f64,
    pub pitch: f64,
}

/// Why a flight could not be planned. A rejected flight leaves the camera untouched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CameraFlightError {
    /// A nonfinite coordinate, zoom, bearing, pitch, duration or zoom bound.
    InvalidInput,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum FlightPath {
    /// Van Wijk & Nuij zoom-out/zoom-back over a ground path of length `u1` > 0.
    Optimal { r0: f64, rho: f64, w0: f64, u1: f64 },
    /// Same ground point: zoom only, `w(s) = exp(k ρ s)`.
    ZoomOnly { k: f64, rho: f64 },
    /// Same ground point and zoom: only bearing/pitch ease (MapLibre falls back to `easeTo`).
    Still,
}

/// The planned trajectory of one animated `flyTo`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraFlight {
    start: CameraPose,
    target: CameraPose,
    /// Start center in Mercator world pixels at the start zoom.
    from: WorldCoordinate,
    /// Start → target center in world pixels at the start zoom (shortest across the dateline).
    delta: WorldCoordinate,
    start_world_size: f64,
    min_zoom: f64,
    max_zoom: f64,
    /// Total path length S in ρ-screenfuls.
    length: f64,
    path: FlightPath,
    duration_ms: f64,
}

impl CameraFlight {
    /// Plans a flight from `start` to `target`.
    ///
    /// `target.zoom` is clamped to `[min_zoom, max_zoom]`; `min_zoom` also bounds how far the
    /// flight may zoom out, as MapLibre limits ρ by its minimum zoom. `wrap_center` crosses the
    /// antimeridian along the shortest path (MapLibre's `normalizeCenter` for repeating
    /// worlds). `duration_ms` overrides the speed-derived duration; `0` is an immediate jump.
    pub fn new(
        start: MapCamera,
        target: CameraPose,
        duration_ms: Option<f64>,
        min_zoom: f64,
        max_zoom: f64,
        wrap_center: bool,
    ) -> Result<Self, CameraFlightError> {
        let finite = [
            start.longitude,
            start.latitude,
            start.zoom,
            start.bearing,
            start.pitch,
            target.longitude,
            target.latitude,
            target.zoom,
            target.bearing,
            target.pitch,
            min_zoom,
            max_zoom,
        ]
        .iter()
        .all(|value| value.is_finite());
        if !finite || min_zoom > max_zoom {
            return Err(CameraFlightError::InvalidInput);
        }
        if let Some(duration) = duration_ms
            && (!duration.is_finite() || duration < 0.0)
        {
            return Err(CameraFlightError::InvalidInput);
        }

        let start_pose = CameraPose {
            longitude: start.longitude,
            latitude: start.latitude,
            zoom: start.zoom,
            bearing: start.bearing,
            pitch: start.pitch,
        };
        let mut target_longitude = target.longitude;
        if wrap_center {
            // MapLibre `normalizeCenter`: fly the shorter way around the world.
            let delta = target_longitude - start.longitude;
            target_longitude += if delta > 180.0 {
                -360.0
            } else if delta < -180.0 {
                360.0
            } else {
                0.0
            };
        }
        let target_pose = CameraPose {
            longitude: target_longitude,
            latitude: target.latitude,
            zoom: target.zoom.clamp(min_zoom, max_zoom),
            bearing: shortest_bearing(target.bearing, start.bearing),
            pitch: target.pitch,
        };

        let start_world_size = CAMERA_TILE_SIZE * 2.0_f64.powf(start.zoom);
        let from = world_pixels(start.longitude, start.latitude, start_world_size)
            .ok_or(CameraFlightError::InvalidInput)?;
        let to = world_pixels(
            target_pose.longitude,
            target_pose.latitude,
            start_world_size,
        )
        .ok_or(CameraFlightError::InvalidInput)?;
        let delta = WorldCoordinate {
            x: to.x - from.x,
            y: to.y - from.y,
        };

        let mut rho = CAMERA_FLIGHT_CURVE;
        // w₀: initial visible span; w₁: final span at the initial scale; u₁: ground path length.
        let w0 = start.viewport.width.max(start.viewport.height);
        let w1 = w0 / 2.0_f64.powf(target_pose.zoom - start.zoom);
        let u1 = delta.x.hypot(delta.y);
        // wₘ: the widest span the minimum zoom allows. Only reduce ρ (limit the zoom-out).
        let flight_min_zoom = min_zoom.min(start.zoom).min(target_pose.zoom);
        let w_max = w0 / 2.0_f64.powf(flight_min_zoom - start.zoom);
        rho = rho.min((w_max / u1 * 2.0).sqrt());
        let rho2 = rho * rho;
        let zoom_out_factor = |descent: bool| {
            let sign = if descent { -1.0 } else { 1.0 };
            let b = (w1 * w1 - w0 * w0 + sign * rho2 * rho2 * u1 * u1)
                / (2.0 * if descent { w1 } else { w0 } * rho2 * u1);
            ((b * b + 1.0).sqrt() - b).ln()
        };
        let r0 = zoom_out_factor(false);
        let mut length = (zoom_out_factor(true) - r0) / rho;
        let path = if u1.abs() < 0.000_002 || !length.is_finite() {
            if (w0 - w1).abs() < 0.000_001 {
                length = 0.0;
                FlightPath::Still
            } else {
                let rho = CAMERA_FLIGHT_CURVE.min(rho);
                let rho = if rho.is_finite() && rho > 0.0 {
                    rho
                } else {
                    CAMERA_FLIGHT_CURVE
                };
                length = (w1 / w0).ln().abs() / rho;
                FlightPath::ZoomOnly {
                    k: if w1 < w0 { -1.0 } else { 1.0 },
                    rho,
                }
            }
        } else {
            FlightPath::Optimal { r0, rho, w0, u1 }
        };

        let duration_ms = match (duration_ms, path) {
            (Some(duration), _) => duration,
            (None, FlightPath::Still) => CAMERA_EASE_DEFAULT_DURATION_MS,
            (None, _) => 1000.0 * length / CAMERA_FLIGHT_SPEED,
        };
        if !duration_ms.is_finite() {
            return Err(CameraFlightError::InvalidInput);
        }

        Ok(Self {
            start: start_pose,
            target: target_pose,
            from,
            delta,
            start_world_size,
            length,
            path,
            duration_ms,
            min_zoom,
            max_zoom,
        })
    }

    /// The flight's duration; `0` means an immediate jump to [`Self::target`].
    #[must_use]
    pub const fn duration_ms(&self) -> f64 {
        self.duration_ms
    }

    /// The final pose (target zoom clamped, longitude/bearing on the shortest path).
    #[must_use]
    pub fn target(&self) -> CameraPose {
        presented(self.target)
    }

    /// Whether the flight has reached its target after `elapsed_ms`.
    #[must_use]
    pub fn is_finished_at(&self, elapsed_ms: f64) -> bool {
        self.progress(elapsed_ms) >= 1.0
    }

    /// The pose presented `elapsed_ms` after the flight started. Nonfinite or negative time
    /// presents the start pose; time at or past the duration presents the exact target.
    #[must_use]
    pub fn pose_at(&self, elapsed_ms: f64) -> CameraPose {
        let t = self.progress(elapsed_ms);
        if t >= 1.0 {
            return self.target();
        }
        if t <= 0.0 {
            return presented(self.start);
        }
        let k = maplibre_default_easing(t);
        let s = k * self.length;
        let (scale, center_factor) = match self.path {
            FlightPath::Optimal { r0, rho, w0, u1 } => {
                let w = r0.cosh() / (r0 + rho * s).cosh();
                let u = w0 * ((r0.cosh() * (r0 + rho * s).tanh() - r0.sinh()) / (rho * rho)) / u1;
                (1.0 / w, u)
            }
            FlightPath::ZoomOnly { k: sign, rho } => (1.0 / (sign * rho * s).exp(), 0.0),
            FlightPath::Still => (1.0, 0.0),
        };
        let center = unproject_web_mercator(WorldCoordinate {
            x: (self.from.x + self.delta.x * center_factor) / self.start_world_size,
            y: (self.from.y + self.delta.y * center_factor) / self.start_world_size,
        });
        let (longitude, latitude) = center
            .map_or((self.start.longitude, self.start.latitude), |center| {
                (center.longitude, center.latitude)
            });
        // As MapLibre's transform, the presented zoom stays within the zoom bounds.
        presented(CameraPose {
            longitude,
            latitude,
            zoom: (self.start.zoom + scale.log2()).clamp(self.min_zoom, self.max_zoom),
            bearing: interpolate(self.start.bearing, self.target.bearing, k),
            pitch: interpolate(self.start.pitch, self.target.pitch, k),
        })
    }

    fn progress(&self, elapsed_ms: f64) -> f64 {
        if self.duration_ms <= 0.0 {
            return 1.0;
        }
        if !elapsed_ms.is_finite() || elapsed_ms <= 0.0 {
            return 0.0;
        }
        (elapsed_ms / self.duration_ms).min(1.0)
    }
}

/// MapLibre's default easing: the unit cubic Bézier `(0.25, 0.1, 0.25, 1)` solved as
/// `@mapbox/unitbezier` does (Newton steps, then bisection, ε = 1e-6).
#[must_use]
pub fn maplibre_default_easing(x: f64) -> f64 {
    unit_bezier(0.25, 0.1, 0.25, 1.0, x)
}

fn unit_bezier(p1x: f64, p1y: f64, p2x: f64, p2y: f64, x: f64) -> f64 {
    const EPSILON: f64 = 1e-6;
    let cx = 3.0 * p1x;
    let bx = 3.0 * (p2x - p1x) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * p1y;
    let by = 3.0 * (p2y - p1y) - cy;
    let ay = 1.0 - cy - by;
    let sample_y = |t: f64| ((ay * t + by) * t + cy) * t;

    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let mut t = x;
    for _ in 0..8 {
        let x2 = ((ax * t + bx) * t + cx) * t - x;
        if x2.abs() < EPSILON {
            return sample_y(t);
        }
        let d2 = (3.0 * ax * t + 2.0 * bx) * t + cx;
        if d2.abs() < 1e-6 {
            break;
        }
        t -= x2 / d2;
    }
    let (mut t0, mut t1) = (0.0, 1.0);
    t = x;
    for _ in 0..20 {
        let x2 = ((ax * t + bx) * t + cx) * t;
        if (x2 - x).abs() < EPSILON {
            break;
        }
        if x > x2 {
            t0 = t;
        } else {
            t1 = t;
        }
        t = (t0 + t1) * 0.5;
    }
    sample_y(t)
}

/// MapLibre `_normalizeBearing`: the target bearing numerically closest to `current`.
fn shortest_bearing(bearing: f64, current: f64) -> f64 {
    let mut bearing = (bearing + 180.0).rem_euclid(360.0) - 180.0;
    let diff = (bearing - current).abs();
    if (bearing - 360.0 - current).abs() < diff {
        bearing -= 360.0;
    }
    if (bearing + 360.0 - current).abs() < diff {
        bearing += 360.0;
    }
    bearing
}

/// A pose as the camera presents it: longitude and bearing in `[-180, 180)`.
fn presented(pose: CameraPose) -> CameraPose {
    CameraPose {
        longitude: wrap_longitude(pose.longitude),
        bearing: (pose.bearing + 180.0).rem_euclid(360.0) - 180.0,
        ..pose
    }
}

fn interpolate(from: f64, to: f64, k: f64) -> f64 {
    from * (1.0 - k) + to * k
}

/// Mercator world pixels at `world_size`, without wrapping the longitude, so a path
/// normalized across the antimeridian stays continuous.
fn world_pixels(longitude: f64, latitude: f64, world_size: f64) -> Option<WorldCoordinate> {
    let wrapped = project_web_mercator(longitude, latitude)?;
    let x = (longitude + 180.0) / 360.0;
    if !x.is_finite() {
        return None;
    }
    Some(WorldCoordinate {
        x: x * world_size,
        y: wrapped.y * world_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ViewportSize;

    fn camera(longitude: f64, latitude: f64, zoom: f64, bearing: f64, pitch: f64) -> MapCamera {
        MapCamera::new(
            longitude,
            latitude,
            zoom,
            bearing,
            pitch,
            ViewportSize::new(800.0, 600.0).unwrap(),
        )
        .unwrap()
    }

    fn pose(longitude: f64, latitude: f64, zoom: f64, bearing: f64, pitch: f64) -> CameraPose {
        CameraPose {
            longitude,
            latitude,
            zoom,
            bearing,
            pitch,
        }
    }

    /// Independent transliteration of MapLibre GL JS 6.4.1 `Camera.flyTo` +
    /// `MercatorCameraHelper.handleFlyTo` (default curve/speed/easing, no offset/padding),
    /// using its own spherical Mercator formulas. Returns (duration, sampler).
    fn maplibre_oracle(
        start: (f64, f64, f64, f64, f64),
        target: (f64, f64, f64, f64, f64),
        size: (f64, f64),
    ) -> (f64, impl Fn(f64) -> (f64, f64, f64, f64, f64)) {
        let (lng0, lat0, z0, b0, p0) = start;
        let (mut lng1, lat1, z1, b1, p1) = target;
        let mercator_x = |lng: f64| (180.0 + lng) / 360.0;
        let mercator_y = |lat: f64| {
            (180.0
                - (180.0 / std::f64::consts::PI)
                    * (std::f64::consts::PI / 4.0 + lat * std::f64::consts::PI / 360.0)
                        .tan()
                        .ln())
                / 360.0
        };
        let delta_lng = lng1 - lng0;
        if delta_lng > 180.0 {
            lng1 -= 360.0;
        } else if delta_lng < -180.0 {
            lng1 += 360.0;
        }
        let mut bearing = (b1 + 180.0).rem_euclid(360.0) - 180.0;
        let diff = (bearing - b0).abs();
        if (bearing - 360.0 - b0).abs() < diff {
            bearing -= 360.0;
        }
        if (bearing + 360.0 - b0).abs() < diff {
            bearing += 360.0;
        }
        let world = 512.0 * 2.0_f64.powf(z0);
        let from = (mercator_x(lng0) * world, mercator_y(lat0) * world);
        let to = (mercator_x(lng1) * world, mercator_y(lat1) * world);
        let delta = (to.0 - from.0, to.1 - from.1);
        let u1 = delta.0.hypot(delta.1);
        let w0 = size.0.max(size.1);
        let w1 = w0 / 2.0_f64.powf(z1 - z0);
        let w_max = w0 / 2.0_f64.powf(0.0_f64.min(z0).min(z1) - z0);
        let rho = 1.42_f64.min((w_max / u1 * 2.0).sqrt());
        let rho2 = rho * rho;
        let r = |descent: bool| {
            let b = (w1 * w1 - w0 * w0 + if descent { -1.0 } else { 1.0 } * rho2 * rho2 * u1 * u1)
                / (2.0 * if descent { w1 } else { w0 } * rho2 * u1);
            ((b * b + 1.0).sqrt() - b).ln()
        };
        let r0 = r(false);
        let s_total = (r(true) - r0) / rho;
        let duration = 1000.0 * s_total / 1.2;
        let sample = move |k: f64| {
            let s = k * s_total;
            let w = r0.cosh() / (r0 + rho * s).cosh();
            let u = w0 * ((r0.cosh() * (r0 + rho * s).tanh() - r0.sinh()) / rho2) / u1;
            let scale = 1.0 / w;
            let x = (from.0 + delta.0 * u) / world;
            let y = (from.1 + delta.1 * u) / world;
            let lng = x * 360.0 - 180.0;
            let lat = 360.0 / std::f64::consts::PI
                * ((180.0 - y * 360.0) * std::f64::consts::PI / 180.0)
                    .exp()
                    .atan()
                - 90.0;
            let lng = (lng + 180.0).rem_euclid(360.0) - 180.0;
            (
                lng,
                lat,
                z0 + scale.log2(),
                b0 + (bearing - b0) * k,
                p0 + (p1 - p0) * k,
            )
        };
        (duration, sample)
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64, label: &str) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{label}: {actual} vs {expected}"
        );
    }

    #[test]
    fn matches_the_maplibre_reference_trajectory_at_every_sample() {
        let start = (-74.006, 40.7128, 9.0, 0.0, 0.0);
        let target = (13.405, 52.52, 11.0, 40.0, 30.0);
        let (oracle_duration, oracle) = maplibre_oracle(start, target, (800.0, 600.0));
        let flight = CameraFlight::new(
            camera(start.0, start.1, start.2, start.3, start.4),
            pose(target.0, target.1, target.2, target.3, target.4),
            None,
            0.0,
            22.0,
            true,
        )
        .unwrap();

        assert_close(flight.duration_ms(), oracle_duration, 1e-9, "duration");
        for step in 1..20 {
            let elapsed = flight.duration_ms() * f64::from(step) / 20.0;
            let k = maplibre_default_easing(elapsed / flight.duration_ms());
            let expected = oracle(k);
            let actual = flight.pose_at(elapsed);
            assert_close(actual.longitude, expected.0, 1e-9, "longitude");
            assert_close(actual.latitude, expected.1, 1e-9, "latitude");
            assert_close(actual.zoom, expected.2, 1e-9, "zoom");
            assert_close(actual.bearing, expected.3, 1e-9, "bearing");
            assert_close(actual.pitch, expected.4, 1e-9, "pitch");
        }
    }

    /// Samples recorded from MapLibre GL JS 6.4.1 itself: its real `Camera.flyTo` over a
    /// `MercatorTransform` (renderWorldCopies, minZoom 0, maxZoom 22, maxPitch 85), driven
    /// with a frozen clock at `fraction × duration`.
    /// Columns: fraction, longitude, latitude, zoom, bearing (MapLibre-normalized), pitch.
    struct RecordedFlight {
        start: (f64, f64, f64, f64, f64),
        target: (f64, f64, f64, f64, f64),
        duration: Option<f64>,
        size: (f64, f64),
        expected_duration: f64,
        samples: &'static [[f64; 6]],
    }

    const RECORDED_FLIGHTS: &[RecordedFlight] = &[
        RecordedFlight {
            start: (-74.006, 40.7128, 9.0, 0.0, 0.0),
            target: (13.405, 52.52, 11.0, 40.0, 30.0),
            duration: None,
            size: (800.0, 600.0),
            expected_duration: 6_796.036_841_496_711_5,
            samples: &[
                [
                    0.25,
                    -45.633_295_343_224_69,
                    44.829_922_919_641_35,
                    2.741_153_972_191_394,
                    16.340_423_720_624_013,
                    12.255_317_790_468_009,
                ],
                [
                    0.5,
                    13.385_359_757_561_9,
                    52.517_636_162_768_3,
                    7.699_067_079_602_243,
                    32.096_135_507_816_48,
                    24.072_101_630_862_377,
                ],
                [
                    0.75,
                    13.404_693_861_001_76,
                    52.519_963_155_057_75,
                    10.339_392_683_263_97,
                    38.418_362_918_103_53,
                    28.813_772_188_577_673,
                ],
                [1.0, 13.405, 52.52, 11.0, 40.0, 30.0],
            ],
        },
        // Across the antimeridian, with a bearing that crosses ±180°.
        RecordedFlight {
            start: (170.0, 10.0, 4.0, 170.0, 0.0),
            target: (-160.0, -20.0, 6.0, -150.0, 20.0),
            duration: None,
            size: (1024.0, 768.0),
            expected_duration: 1_724.294_593_035_834_9,
            samples: &[
                [
                    0.1,
                    174.109_169_500_957_25,
                    5.867_311_838_510_83,
                    3.807_664_028_314_617,
                    173.791_799_892_060_23,
                    1.895_899_946_030_113_1,
                ],
                [
                    0.5,
                    -160.854_167_535_706_72,
                    -19.182_679_381_021_416,
                    5.195_146_721_275_339,
                    -157.903_864_492_183_52,
                    16.048_067_753_908_253,
                ],
                [
                    0.9,
                    -160.013_523_367_799_1,
                    -19.987_092_512_081_36,
                    5.976_420_639_518_635,
                    -150.227_340_899_619_15,
                    19.886_329_550_190_42,
                ],
            ],
        },
        // Zoom in place: the ground point stays fixed.
        RecordedFlight {
            start: (5.0, 45.0, 3.0, 0.0, 0.0),
            target: (5.0, 45.0, 7.0, 0.0, 0.0),
            duration: None,
            size: (800.0, 600.0),
            expected_duration: 1_627.106_057_652_454,
            samples: &[[0.5, 5.0, 45.0, 6.209_613_550_781_651, 0.0, 0.0]],
        },
        // Rotation only: MapLibre's `easeTo` fallback (500 ms) along the short arc.
        RecordedFlight {
            start: (0.0, 0.0, 4.0, 170.0, 0.0),
            target: (0.0, 0.0, 4.0, -170.0, 0.0),
            duration: None,
            size: (800.0, 600.0),
            expected_duration: 500.0,
            samples: &[
                [0.5, 0.0, 0.0, 4.0, -173.951_932_246_091_67, 0.0],
                [1.0, 0.0, 0.0, 4.0, -170.0, 0.0],
            ],
        },
        // An explicit `duration`.
        RecordedFlight {
            start: (10.0, 20.0, 4.0, 0.0, 0.0),
            target: (30.0, -10.0, 6.0, 0.0, 0.0),
            duration: Some(1000.0),
            size: (800.0, 600.0),
            expected_duration: 1000.0,
            samples: &[[
                0.5,
                29.463_620_840_894_237,
                -9.194_266_416_963_643,
                5.154_858_893_542_825_4,
                0.0,
                0.0,
            ]],
        },
    ];

    fn wrapped_degrees(value: f64) -> f64 {
        (value + 180.0).rem_euclid(360.0) - 180.0
    }

    #[test]
    fn reproduces_recorded_maplibre_flights() {
        for recorded in RECORDED_FLIGHTS {
            let (lng, lat, zoom, bearing, pitch) = recorded.start;
            let start = MapCamera::new(
                lng,
                lat,
                zoom,
                bearing,
                pitch,
                ViewportSize::new(recorded.size.0, recorded.size.1).unwrap(),
            )
            .unwrap();
            let (lng, lat, zoom, bearing, pitch) = recorded.target;
            let flight = CameraFlight::new(
                start,
                pose(lng, lat, zoom, bearing, pitch),
                recorded.duration,
                0.0,
                22.0,
                true,
            )
            .unwrap();
            assert_close(
                flight.duration_ms(),
                recorded.expected_duration,
                1e-6,
                "duration",
            );
            for [fraction, lng, lat, zoom, bearing, pitch] in recorded.samples {
                let actual = flight.pose_at(fraction * flight.duration_ms());
                assert_close(actual.longitude, *lng, 1e-7, "longitude");
                assert_close(actual.latitude, *lat, 1e-7, "latitude");
                assert_close(actual.zoom, *zoom, 1e-9, "zoom");
                assert_close(
                    wrapped_degrees(actual.bearing - bearing),
                    0.0,
                    1e-9,
                    "bearing",
                );
                assert_close(actual.pitch, *pitch, 1e-9, "pitch");
            }
        }
    }

    #[test]
    fn flies_out_and_back_in() {
        let flight = CameraFlight::new(
            camera(-74.006, 40.7128, 9.0, 0.0, 0.0),
            pose(13.405, 52.52, 11.0, 40.0, 30.0),
            None,
            0.0,
            22.0,
            true,
        )
        .unwrap();
        let lowest = (0..=200)
            .map(|step| {
                flight
                    .pose_at(flight.duration_ms() * f64::from(step) / 200.0)
                    .zoom
            })
            .fold(f64::INFINITY, f64::min);
        assert!(lowest < 9.0 - 5.0, "flight zooms out: {lowest}");
    }

    #[test]
    fn endpoints_are_exact() {
        let flight = CameraFlight::new(
            camera(10.0, 20.0, 4.0, 10.0, 5.0),
            pose(30.0, -10.0, 6.0, -20.0, 25.0),
            Some(1000.0),
            0.0,
            22.0,
            true,
        )
        .unwrap();

        assert_eq!(flight.pose_at(0.0), pose(10.0, 20.0, 4.0, 10.0, 5.0));
        assert_eq!(flight.pose_at(-5.0), pose(10.0, 20.0, 4.0, 10.0, 5.0));
        assert_eq!(flight.pose_at(f64::NAN), pose(10.0, 20.0, 4.0, 10.0, 5.0));
        assert_eq!(flight.pose_at(1000.0), pose(30.0, -10.0, 6.0, -20.0, 25.0));
        assert_eq!(flight.pose_at(5000.0), pose(30.0, -10.0, 6.0, -20.0, 25.0));
        assert!(!flight.is_finished_at(999.0));
        assert!(flight.is_finished_at(1000.0));
    }

    #[test]
    fn honours_an_explicit_duration_and_zero_is_a_jump() {
        let fast = CameraFlight::new(
            camera(0.0, 0.0, 3.0, 0.0, 0.0),
            pose(20.0, 10.0, 5.0, 0.0, 0.0),
            Some(250.0),
            0.0,
            22.0,
            true,
        )
        .unwrap();
        assert_eq!(fast.duration_ms(), 250.0);
        let quarter = fast.pose_at(62.5);
        assert!(quarter.longitude > 0.0 && quarter.longitude < 20.0);

        let jump = CameraFlight::new(
            camera(0.0, 0.0, 3.0, 0.0, 0.0),
            pose(20.0, 10.0, 5.0, 0.0, 0.0),
            Some(0.0),
            0.0,
            22.0,
            true,
        )
        .unwrap();
        assert!(jump.is_finished_at(0.0));
        assert_eq!(jump.pose_at(0.0), pose(20.0, 10.0, 5.0, 0.0, 0.0));
    }

    #[test]
    fn rejects_nonfinite_and_invalid_inputs() {
        let start = camera(0.0, 0.0, 3.0, 0.0, 0.0);
        let valid = pose(10.0, 10.0, 4.0, 0.0, 0.0);
        for target in [
            pose(f64::NAN, 10.0, 4.0, 0.0, 0.0),
            pose(10.0, f64::INFINITY, 4.0, 0.0, 0.0),
            pose(10.0, 10.0, f64::NAN, 0.0, 0.0),
            pose(10.0, 10.0, 4.0, f64::NEG_INFINITY, 0.0),
            pose(10.0, 10.0, 4.0, 0.0, f64::NAN),
        ] {
            assert_eq!(
                CameraFlight::new(start, target, None, 0.0, 22.0, true),
                Err(CameraFlightError::InvalidInput)
            );
        }
        for duration in [f64::NAN, f64::INFINITY, -1.0] {
            assert_eq!(
                CameraFlight::new(start, valid, Some(duration), 0.0, 22.0, true),
                Err(CameraFlightError::InvalidInput)
            );
        }
        assert_eq!(
            CameraFlight::new(start, valid, None, 5.0, 4.0, true),
            Err(CameraFlightError::InvalidInput)
        );
        assert_eq!(
            CameraFlight::new(start, valid, None, f64::NAN, 22.0, true),
            Err(CameraFlightError::InvalidInput)
        );
    }

    #[test]
    fn crosses_the_antimeridian_along_the_shortest_path() {
        let flight = CameraFlight::new(
            camera(170.0, 0.0, 4.0, 0.0, 0.0),
            pose(-170.0, 0.0, 4.0, 0.0, 0.0),
            Some(1000.0),
            0.0,
            22.0,
            true,
        )
        .unwrap();
        for step in 1..10 {
            let sample = flight.pose_at(f64::from(step) * 100.0);
            assert!(
                sample.longitude >= 170.0 || sample.longitude <= -170.0,
                "stays on the dateline side: {}",
                sample.longitude
            );
            assert!((-180.0..180.0).contains(&sample.longitude));
        }
        assert_close(flight.pose_at(1000.0).longitude, -170.0, 1e-9, "target");

        // Without world copies (a bounded camera), the path is direct.
        let direct = CameraFlight::new(
            camera(170.0, 0.0, 4.0, 0.0, 0.0),
            pose(-170.0, 0.0, 4.0, 0.0, 0.0),
            Some(1000.0),
            0.0,
            22.0,
            false,
        )
        .unwrap();
        let middle = direct.pose_at(500.0);
        assert!(middle.longitude.abs() < 170.0, "{}", middle.longitude);
    }

    #[test]
    fn rotates_along_the_shortest_arc() {
        let flight = CameraFlight::new(
            camera(0.0, 0.0, 4.0, 170.0, 0.0),
            pose(0.0, 0.0, 4.0, -170.0, 0.0),
            None,
            0.0,
            22.0,
            true,
        )
        .unwrap();
        // Same ground point and zoom: MapLibre's easeTo fallback with its 500 ms default.
        assert_eq!(flight.duration_ms(), CAMERA_EASE_DEFAULT_DURATION_MS);
        let middle = flight.pose_at(250.0);
        assert!(
            middle.bearing > 170.0 || middle.bearing < -170.0,
            "{}",
            middle.bearing
        );
        assert_eq!(flight.pose_at(500.0).bearing, -170.0);
        assert_eq!(flight.pose_at(250.0).zoom, 4.0);
    }

    #[test]
    fn clamps_the_target_zoom_and_limits_the_zoom_out_to_the_minimum_zoom() {
        let flight = CameraFlight::new(
            camera(-120.0, 30.0, 3.0, 0.0, 0.0),
            pose(120.0, -30.0, 30.0, 0.0, 0.0),
            None,
            2.0,
            8.0,
            true,
        )
        .unwrap();
        assert_eq!(flight.target().zoom, 8.0);
        let lowest = (0..=100)
            .map(|step| {
                flight
                    .pose_at(flight.duration_ms() * f64::from(step) / 100.0)
                    .zoom
            })
            .fold(f64::INFINITY, f64::min);
        assert!(lowest >= 2.0 - 1e-9, "{lowest}");
    }

    #[test]
    fn zooms_in_place_without_moving_the_center() {
        let flight = CameraFlight::new(
            camera(5.0, 45.0, 3.0, 0.0, 0.0),
            pose(5.0, 45.0, 7.0, 0.0, 0.0),
            None,
            0.0,
            22.0,
            true,
        )
        .unwrap();
        assert!(flight.duration_ms() > 0.0);
        let middle = flight.pose_at(flight.duration_ms() / 2.0);
        assert_close(middle.longitude, 5.0, 1e-9, "longitude");
        assert_close(middle.latitude, 45.0, 1e-9, "latitude");
        assert!(middle.zoom > 3.0 && middle.zoom < 7.0);
    }

    #[test]
    fn easing_matches_the_unit_bezier_reference() {
        assert_eq!(maplibre_default_easing(0.0), 0.0);
        assert_eq!(maplibre_default_easing(1.0), 1.0);
        // `@mapbox/unitbezier(0.25, 0.1, 0.25, 1)` reference values.
        assert_close(maplibre_default_easing(0.5), 0.802_403_4, 1e-6, "ease(0.5)");
        assert_close(
            maplibre_default_easing(0.25),
            0.408_510_6,
            1e-6,
            "ease(0.25)",
        );
    }
}
