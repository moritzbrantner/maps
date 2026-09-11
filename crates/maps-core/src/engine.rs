//! First-party map-engine contracts shared by native and WASM hosts.
//!
//! This module deliberately owns map-domain state only. It contains no browser,
//! React, MapLibre, WebGPU, Canvas, or JavaScript runtime concerns.

use std::f64::consts::PI;

const MAX_MERCATOR_LATITUDE: f64 = 85.051_128_779_806_6;
const DEFAULT_TILE_SIZE: f64 = 512.0;

/// CSS-pixel viewport dimensions used by camera/projection calculations.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewportSize {
    pub width: f64,
    pub height: f64,
}

impl ViewportSize {
    /// Creates a finite, strictly-positive viewport.
    #[must_use]
    pub fn new(width: f64, height: f64) -> Option<Self> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return None;
        }

        Some(Self { width, height })
    }
}

/// Canonical flat-map camera state.
///
/// Bearing and pitch are part of the long-term engine contract even though the
/// initial Mercator projection helpers in this module intentionally implement
/// north-up, zero-pitch screen projection only. That keeps the semantic state
/// stable while the matrix-backed camera implementation is built on top.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapCamera {
    pub longitude: f64,
    pub latitude: f64,
    pub zoom: f64,
    pub bearing: f64,
    pub pitch: f64,
    pub viewport: ViewportSize,
}

impl MapCamera {
    /// Creates a normalized camera.
    #[must_use]
    pub fn new(
        longitude: f64,
        latitude: f64,
        zoom: f64,
        bearing: f64,
        pitch: f64,
        viewport: ViewportSize,
    ) -> Option<Self> {
        if !longitude.is_finite()
            || !latitude.is_finite()
            || !zoom.is_finite()
            || !bearing.is_finite()
            || !pitch.is_finite()
        {
            return None;
        }

        Some(Self {
            longitude: wrap_longitude(longitude),
            latitude: clamp_mercator_latitude(latitude),
            zoom,
            bearing: normalize_bearing(bearing),
            pitch: pitch.clamp(0.0, 85.0),
            viewport,
        })
    }

    /// World size in CSS pixels for the current zoom.
    #[must_use]
    pub fn world_size(self) -> f64 {
        world_size(self.zoom, DEFAULT_TILE_SIZE)
    }

    /// Projects a geographic coordinate into the normalized Mercator world.
    #[must_use]
    pub fn project_world(self, longitude: f64, latitude: f64) -> Option<WorldCoordinate> {
        project_web_mercator(longitude, latitude)
    }

    /// Projects a coordinate into screen pixels for a north-up, zero-pitch camera.
    ///
    /// Returns `None` until bearing/pitch-aware projection is requested through a
    /// future matrix-backed camera path rather than silently applying incorrect math.
    #[must_use]
    pub fn project_screen(self, longitude: f64, latitude: f64) -> Option<ScreenCoordinate> {
        if self.bearing != 0.0 || self.pitch != 0.0 {
            return None;
        }

        let target = project_web_mercator(longitude, latitude)?;
        let center = project_web_mercator(self.longitude, self.latitude)?;
        let size = self.world_size();
        let dx = shortest_wrapped_delta(target.x - center.x) * size;
        let dy = (target.y - center.y) * size;

        Some(ScreenCoordinate {
            x: self.viewport.width / 2.0 + dx,
            y: self.viewport.height / 2.0 + dy,
        })
    }

    /// Unprojects screen pixels for a north-up, zero-pitch camera.
    #[must_use]
    pub fn unproject_screen(self, screen: ScreenCoordinate) -> Option<GeographicCoordinate> {
        if self.bearing != 0.0 || self.pitch != 0.0 {
            return None;
        }

        let center = project_web_mercator(self.longitude, self.latitude)?;
        let size = self.world_size();
        let world = WorldCoordinate {
            x: wrap_world_x(center.x + (screen.x - self.viewport.width / 2.0) / size),
            y: center.y + (screen.y - self.viewport.height / 2.0) / size,
        };

        unproject_web_mercator(world)
    }
}

/// A geographic coordinate in degrees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeographicCoordinate {
    pub longitude: f64,
    pub latitude: f64,
}

/// A normalized Web Mercator world coordinate.
///
/// `x` wraps horizontally with one world per unit. `y=0` is the northern
/// Mercator limit and `y=1` is the southern limit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorldCoordinate {
    pub x: f64,
    pub y: f64,
}

/// A coordinate in viewport CSS pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenCoordinate {
    pub x: f64,
    pub y: f64,
}

/// Canonical XYZ tile coordinate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TileId {
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

impl TileId {
    /// Creates a canonical tile identity when x/y fit the zoom pyramid.
    #[must_use]
    pub fn new(z: u8, x: u32, y: u32) -> Option<Self> {
        let dimension = tile_dimension(z)?;
        if u64::from(x) >= dimension || u64::from(y) >= dimension {
            return None;
        }

        Some(Self { z, x, y })
    }

    /// Returns the parent tile, or `None` for the root tile.
    #[must_use]
    pub fn parent(self) -> Option<Self> {
        let z = self.z.checked_sub(1)?;
        Some(Self {
            z,
            x: self.x / 2,
            y: self.y / 2,
        })
    }

    /// Returns the four child tiles when the zoom can be represented.
    #[must_use]
    pub fn children(self) -> Option<[Self; 4]> {
        let z = self.z.checked_add(1)?;
        tile_dimension(z)?;
        let x = self.x.checked_mul(2)?;
        let y = self.y.checked_mul(2)?;

        Some([
            Self { z, x, y },
            Self { z, x: x + 1, y },
            Self { z, x, y: y + 1 },
            Self {
                z,
                x: x + 1,
                y: y + 1,
            },
        ])
    }
}

/// Projects degrees into normalized spherical Web Mercator coordinates.
#[must_use]
pub fn project_web_mercator(longitude: f64, latitude: f64) -> Option<WorldCoordinate> {
    if !longitude.is_finite() || !latitude.is_finite() {
        return None;
    }

    let longitude = wrap_longitude(longitude);
    let latitude = clamp_mercator_latitude(latitude);
    let x = (longitude + 180.0) / 360.0;
    let latitude_radians = latitude.to_radians();
    let y = (1.0 - (latitude_radians.tan() + 1.0 / latitude_radians.cos()).ln() / PI) / 2.0;

    Some(WorldCoordinate { x, y })
}

/// Unprojects normalized spherical Web Mercator coordinates into degrees.
#[must_use]
pub fn unproject_web_mercator(world: WorldCoordinate) -> Option<GeographicCoordinate> {
    if !world.x.is_finite() || !world.y.is_finite() {
        return None;
    }

    let x = wrap_world_x(world.x);
    let longitude = x * 360.0 - 180.0;
    let mercator_y = PI * (1.0 - 2.0 * world.y);
    let latitude = mercator_y.sinh().atan().to_degrees();

    Some(GeographicCoordinate {
        longitude: wrap_longitude(longitude),
        latitude: clamp_mercator_latitude(latitude),
    })
}

/// Returns the CSS-pixel world size for a zoom and tile size.
#[must_use]
pub fn world_size(zoom: f64, tile_size: f64) -> f64 {
    tile_size * 2.0_f64.powf(zoom)
}

/// Wraps longitude into `[-180, 180)`.
#[must_use]
pub fn wrap_longitude(longitude: f64) -> f64 {
    (longitude + 180.0).rem_euclid(360.0) - 180.0
}

/// Clamps latitude to the finite Web Mercator domain.
#[must_use]
pub fn clamp_mercator_latitude(latitude: f64) -> f64 {
    latitude.clamp(-MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE)
}

fn normalize_bearing(bearing: f64) -> f64 {
    let normalized = bearing.rem_euclid(360.0);
    if normalized >= 180.0 {
        normalized - 360.0
    } else {
        normalized
    }
}

fn wrap_world_x(x: f64) -> f64 {
    x.rem_euclid(1.0)
}

fn shortest_wrapped_delta(delta: f64) -> f64 {
    (delta + 0.5).rem_euclid(1.0) - 0.5
}

fn tile_dimension(z: u8) -> Option<u64> {
    1_u64.checked_shl(u32::from(z))
}
