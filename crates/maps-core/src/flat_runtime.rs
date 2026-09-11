//! Stateful first-party flat raster runtime.
//!
//! The runtime owns map-domain camera, tile-cover, request scheduling, and
//! bounded cache policy. Browser hosts remain responsible for network/image
//! objects and pixels, but consume these deterministic decisions rather than
//! reimplementing map semantics.

use std::collections::{BTreeSet, VecDeque};
use std::fmt;

use crate::{
    GeographicCoordinate, MapCamera, MapViewportBounds, ScreenCoordinate, TileId, ViewportSize,
    WorldCoordinate, project_web_mercator, unproject_web_mercator, world_size,
};

const CAMERA_TILE_SIZE: f64 = 512.0;
const DEFAULT_MAX_VISIBLE_TILES: usize = 256;
const DEFAULT_CACHE_CAPACITY: usize = 512;
const DEFAULT_LOAD_CONCURRENCY: usize = 8;

/// Raster pyramid metadata that affects deterministic tile selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RasterSourceSpec {
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub tile_size: u16,
}

impl RasterSourceSpec {
    #[must_use]
    pub fn new(min_zoom: u8, max_zoom: u8, tile_size: u16) -> Option<Self> {
        if min_zoom > max_zoom || tile_size == 0 || max_zoom > 31 {
            return None;
        }

        Some(Self {
            min_zoom,
            max_zoom,
            tile_size,
        })
    }
}

/// Runtime capacity policy. All limits are explicit and deterministic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlatRasterRuntimeLimits {
    pub max_visible_tiles: usize,
    pub cache_capacity: usize,
    pub load_concurrency: usize,
}

impl Default for FlatRasterRuntimeLimits {
    fn default() -> Self {
        Self {
            max_visible_tiles: DEFAULT_MAX_VISIBLE_TILES,
            cache_capacity: DEFAULT_CACHE_CAPACITY,
            load_concurrency: DEFAULT_LOAD_CONCURRENCY,
        }
    }
}

impl FlatRasterRuntimeLimits {
    #[must_use]
    pub fn new(
        max_visible_tiles: usize,
        cache_capacity: usize,
        load_concurrency: usize,
    ) -> Option<Self> {
        if max_visible_tiles == 0
            || cache_capacity == 0
            || load_concurrency == 0
            || cache_capacity < max_visible_tiles
        {
            return None;
        }

        Some(Self {
            max_visible_tiles,
            cache_capacity,
            load_concurrency,
        })
    }
}

/// One screen placement of a canonical XYZ tile.
///
/// A canonical tile may appear more than once when the viewport spans world
/// copies. `world_copy` distinguishes placement while `tile` remains the single
/// request/cache identity.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RasterTilePlacement {
    pub tile: TileId,
    pub world_copy: i32,
    pub screen_x: f64,
    pub screen_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
}

/// Deterministic browser work produced by one runtime frame.
#[derive(Clone, Debug, PartialEq)]
pub struct RasterFramePlan {
    pub visible_bounds: MapViewportBounds,
    pub placements: Vec<RasterTilePlacement>,
    pub requests: Vec<TileId>,
    pub cancellations: Vec<TileId>,
    pub evictions: Vec<TileId>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FlatRasterRuntimeError {
    InvalidCamera,
    InvalidLimits,
    InvalidSource,
    InvalidBounds,
    UnsupportedCamera,
    TileCoverOverflow { required: usize, limit: usize },
}

impl fmt::Display for FlatRasterRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCamera => write!(formatter, "invalid flat raster camera"),
            Self::InvalidLimits => write!(formatter, "invalid flat raster runtime limits"),
            Self::InvalidSource => write!(formatter, "invalid flat raster source"),
            Self::InvalidBounds => write!(formatter, "invalid flat raster fit bounds"),
            Self::UnsupportedCamera => write!(
                formatter,
                "flat raster runtime currently requires a north-up zero-pitch camera",
            ),
            Self::TileCoverOverflow { required, limit } => write!(
                formatter,
                "visible tile cover requires {required} placements but limit is {limit}",
            ),
        }
    }
}

impl std::error::Error for FlatRasterRuntimeError {}

/// Stateful first-party raster runtime.
#[derive(Debug)]
pub struct FlatRasterRuntime {
    camera: MapCamera,
    source: RasterSourceSpec,
    limits: FlatRasterRuntimeLimits,
    pending: BTreeSet<TileId>,
    ready_lru: VecDeque<TileId>,
}

impl FlatRasterRuntime {
    pub fn new(
        camera: MapCamera,
        source: RasterSourceSpec,
        limits: FlatRasterRuntimeLimits,
    ) -> Result<Self, FlatRasterRuntimeError> {
        validate_camera(camera)?;
        RasterSourceSpec::new(source.min_zoom, source.max_zoom, source.tile_size)
            .ok_or(FlatRasterRuntimeError::InvalidSource)?;
        FlatRasterRuntimeLimits::new(
            limits.max_visible_tiles,
            limits.cache_capacity,
            limits.load_concurrency,
        )
        .ok_or(FlatRasterRuntimeError::InvalidLimits)?;

        Ok(Self {
            camera,
            source,
            limits,
            pending: BTreeSet::new(),
            ready_lru: VecDeque::new(),
        })
    }

    #[must_use]
    pub const fn camera(&self) -> MapCamera {
        self.camera
    }

    #[must_use]
    pub const fn source(&self) -> RasterSourceSpec {
        self.source
    }

    pub fn set_view_state(
        &mut self,
        longitude: f64,
        latitude: f64,
        zoom: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.camera = MapCamera::new(
            longitude,
            latitude,
            zoom,
            self.camera.bearing,
            self.camera.pitch,
            self.camera.viewport,
        )
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        validate_camera(self.camera)
    }

    pub fn resize(&mut self, width: f64, height: f64) -> Result<(), FlatRasterRuntimeError> {
        let viewport =
            ViewportSize::new(width, height).ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        self.camera = self
            .camera
            .with_viewport(viewport)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        Ok(())
    }

    /// Pans by pointer delta in CSS pixels. Positive x/y means the pointer moved
    /// right/down, so the geographic camera center moves left/up respectively.
    pub fn pan_by_pixels(
        &mut self,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        if !delta_x.is_finite() || !delta_y.is_finite() {
            return Err(FlatRasterRuntimeError::InvalidCamera);
        }

        validate_camera(self.camera)?;
        let center = project_web_mercator(self.camera.longitude, self.camera.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let size = self
            .camera
            .world_size()
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let next = unproject_web_mercator(WorldCoordinate {
            x: center.x - delta_x / size,
            y: center.y - delta_y / size,
        })
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;

        self.set_view_state(next.longitude, next.latitude, self.camera.zoom)
    }

    /// Applies a zoom delta while keeping the geographic coordinate under the
    /// supplied screen point stable.
    pub fn zoom_about(
        &mut self,
        delta_zoom: f64,
        screen: ScreenCoordinate,
        min_zoom: f64,
        max_zoom: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        if !delta_zoom.is_finite()
            || !screen.x.is_finite()
            || !screen.y.is_finite()
            || !min_zoom.is_finite()
            || !max_zoom.is_finite()
            || min_zoom > max_zoom
        {
            return Err(FlatRasterRuntimeError::InvalidCamera);
        }

        validate_camera(self.camera)?;
        let anchor = self
            .camera
            .unproject_screen(screen)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
        let anchor_world = project_web_mercator(anchor.longitude, anchor.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let zoom = (self.camera.zoom + delta_zoom).clamp(min_zoom, max_zoom);
        let next_size =
            world_size(zoom, CAMERA_TILE_SIZE).ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let center_world = WorldCoordinate {
            x: anchor_world.x - (screen.x - self.camera.viewport.width / 2.0) / next_size,
            y: anchor_world.y - (screen.y - self.camera.viewport.height / 2.0) / next_size,
        };
        let center =
            unproject_web_mercator(center_world).ok_or(FlatRasterRuntimeError::InvalidCamera)?;

        self.set_view_state(center.longitude, center.latitude, zoom)
    }

    pub fn fit_bounds(
        &mut self,
        west: f64,
        south: f64,
        east: f64,
        north: f64,
        padding: f64,
        max_zoom: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        if !west.is_finite()
            || !south.is_finite()
            || !east.is_finite()
            || !north.is_finite()
            || !padding.is_finite()
            || padding < 0.0
            || !max_zoom.is_finite()
            || south > north
        {
            return Err(FlatRasterRuntimeError::InvalidBounds);
        }

        validate_camera(self.camera)?;
        let north_west =
            project_web_mercator(west, north).ok_or(FlatRasterRuntimeError::InvalidBounds)?;
        let south_east =
            project_web_mercator(east, south).ok_or(FlatRasterRuntimeError::InvalidBounds)?;
        let mut east_x = south_east.x;
        if west > east || east_x < north_west.x {
            east_x += 1.0;
        }
        let span_x = (east_x - north_west.x).max(0.0);
        let span_y = (south_east.y - north_west.y).abs();
        let available_width = self.camera.viewport.width - padding * 2.0;
        let available_height = self.camera.viewport.height - padding * 2.0;

        if available_width <= 0.0 || available_height <= 0.0 {
            return Err(FlatRasterRuntimeError::InvalidBounds);
        }

        let zoom_x = fit_zoom_for_span(available_width, span_x);
        let zoom_y = fit_zoom_for_span(available_height, span_y);
        let zoom = zoom_x.min(zoom_y).min(max_zoom).max(0.0);
        let center_world = WorldCoordinate {
            x: north_west.x + span_x / 2.0,
            y: (north_west.y + south_east.y) / 2.0,
        };
        let center =
            unproject_web_mercator(center_world).ok_or(FlatRasterRuntimeError::InvalidBounds)?;

        self.set_view_state(center.longitude, center.latitude, zoom)
    }

    #[must_use]
    pub fn unproject_screen(
        &self,
        screen: ScreenCoordinate,
    ) -> Result<GeographicCoordinate, FlatRasterRuntimeError> {
        validate_camera(self.camera)?;
        self.camera
            .unproject_screen(screen)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)
    }

    /// Marks a browser-fetched tile ready and updates deterministic recency.
    pub fn mark_loaded(&mut self, tile: TileId) {
        self.pending.remove(&tile);
        touch_ready(&mut self.ready_lru, tile);
    }

    /// Marks a browser fetch failed/aborted. Failed tiles remain eligible for a
    /// later deterministic request when visible again.
    pub fn mark_failed(&mut self, tile: TileId) {
        self.pending.remove(&tile);
    }

    pub fn frame_plan(&mut self) -> Result<RasterFramePlan, FlatRasterRuntimeError> {
        validate_camera(self.camera)?;
        let placements =
            visible_tile_placements(self.camera, self.source, self.limits.max_visible_tiles)?;
        let visible_bounds = self
            .camera
            .visible_bounds()
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
        let visible_tiles = placements
            .iter()
            .map(|placement| placement.tile)
            .collect::<BTreeSet<_>>();

        let cancellations = self
            .pending
            .iter()
            .copied()
            .filter(|tile| !visible_tiles.contains(tile))
            .collect::<Vec<_>>();
        for tile in &cancellations {
            self.pending.remove(tile);
        }

        let evictions = self.prune_cache(&visible_tiles);
        let available_slots = self
            .limits
            .load_concurrency
            .saturating_sub(self.pending.len());
        let mut request_candidates = visible_tiles
            .iter()
            .copied()
            .filter(|tile| !self.pending.contains(tile) && !self.ready_lru.contains(tile))
            .collect::<Vec<_>>();
        let center = project_web_mercator(self.camera.longitude, self.camera.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        request_candidates.sort_by(|left, right| {
            tile_center_distance_squared(*left, center)
                .total_cmp(&tile_center_distance_squared(*right, center))
                .then_with(|| left.cmp(right))
        });
        request_candidates.truncate(available_slots);

        for tile in &request_candidates {
            self.pending.insert(*tile);
        }
        for tile in &visible_tiles {
            if self.ready_lru.contains(tile) {
                touch_ready(&mut self.ready_lru, *tile);
            }
        }

        Ok(RasterFramePlan {
            visible_bounds,
            placements,
            requests: request_candidates,
            cancellations,
            evictions,
        })
    }

    fn prune_cache(&mut self, visible: &BTreeSet<TileId>) -> Vec<TileId> {
        let mut evictions = Vec::new();

        while self.ready_lru.len() > self.limits.cache_capacity {
            let candidate_index = self
                .ready_lru
                .iter()
                .position(|tile| !visible.contains(tile))
                .unwrap_or(0);
            if let Some(tile) = self.ready_lru.remove(candidate_index) {
                evictions.push(tile);
            }
        }

        evictions
    }
}

fn validate_camera(camera: MapCamera) -> Result<(), FlatRasterRuntimeError> {
    if camera.bearing != 0.0 || camera.pitch != 0.0 {
        return Err(FlatRasterRuntimeError::UnsupportedCamera);
    }
    camera
        .world_size()
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
    Ok(())
}

fn fit_zoom_for_span(available_pixels: f64, normalized_span: f64) -> f64 {
    if normalized_span <= f64::EPSILON {
        return f64::INFINITY;
    }

    (available_pixels / (CAMERA_TILE_SIZE * normalized_span)).log2()
}

fn visible_tile_placements(
    camera: MapCamera,
    source: RasterSourceSpec,
    limit: usize,
) -> Result<Vec<RasterTilePlacement>, FlatRasterRuntimeError> {
    let center = project_web_mercator(camera.longitude, camera.latitude)
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
    let size = camera
        .world_size()
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
    let tile_zoom = (camera.zoom.floor() as i32)
        .clamp(i32::from(source.min_zoom), i32::from(source.max_zoom)) as u8;
    let dimension = 1_i64
        .checked_shl(u32::from(tile_zoom))
        .ok_or(FlatRasterRuntimeError::InvalidSource)?;
    let half_width_world = camera.viewport.width / size / 2.0;
    let half_height_world = camera.viewport.height / size / 2.0;
    let west = center.x - half_width_world;
    let east = center.x + half_width_world;
    let north = (center.y - half_height_world).clamp(0.0, 1.0);
    let south = (center.y + half_height_world).clamp(0.0, 1.0);
    let min_x = (west * dimension as f64).floor() as i64;
    let max_x = ((east * dimension as f64).ceil() as i64 - 1).max(min_x);
    let min_y = ((north * dimension as f64).floor() as i64).clamp(0, dimension - 1);
    let max_y = ((south * dimension as f64).ceil() as i64 - 1).clamp(min_y, dimension - 1);
    let columns =
        usize::try_from(max_x - min_x + 1).map_err(|_| FlatRasterRuntimeError::InvalidCamera)?;
    let rows =
        usize::try_from(max_y - min_y + 1).map_err(|_| FlatRasterRuntimeError::InvalidCamera)?;
    let required = columns
        .checked_mul(rows)
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;

    if required > limit {
        return Err(FlatRasterRuntimeError::TileCoverOverflow { required, limit });
    }

    let tile_screen_size = size / dimension as f64;
    let mut placements = Vec::with_capacity(required);

    for y in min_y..=max_y {
        for unwrapped_x in min_x..=max_x {
            let canonical_x = unwrapped_x.rem_euclid(dimension);
            let world_copy = i32::try_from(unwrapped_x.div_euclid(dimension))
                .map_err(|_| FlatRasterRuntimeError::InvalidCamera)?;
            let tile = TileId::new(
                tile_zoom,
                u32::try_from(canonical_x).map_err(|_| FlatRasterRuntimeError::InvalidSource)?,
                u32::try_from(y).map_err(|_| FlatRasterRuntimeError::InvalidSource)?,
            )
            .ok_or(FlatRasterRuntimeError::InvalidSource)?;
            let tile_world_x = unwrapped_x as f64 / dimension as f64;
            let tile_world_y = y as f64 / dimension as f64;

            placements.push(RasterTilePlacement {
                tile,
                world_copy,
                screen_x: camera.viewport.width / 2.0 + (tile_world_x - center.x) * size,
                screen_y: camera.viewport.height / 2.0 + (tile_world_y - center.y) * size,
                screen_width: tile_screen_size,
                screen_height: tile_screen_size,
            });
        }
    }

    Ok(placements)
}

fn tile_center_distance_squared(tile: TileId, camera_center: WorldCoordinate) -> f64 {
    let dimension = 2.0_f64.powi(i32::from(tile.z));
    let tile_x = (f64::from(tile.x) + 0.5) / dimension;
    let tile_y = (f64::from(tile.y) + 0.5) / dimension;
    let raw_x_delta = (tile_x - camera_center.x).abs();
    let x_delta = raw_x_delta.min(1.0 - raw_x_delta);
    let y_delta = tile_y - camera_center.y;

    x_delta * x_delta + y_delta * y_delta
}

fn touch_ready(ready: &mut VecDeque<TileId>, tile: TileId) {
    if let Some(index) = ready.iter().position(|candidate| *candidate == tile) {
        ready.remove(index);
    }
    ready.push_back(tile);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(center: [f64; 2], zoom: f64, width: f64, height: f64) -> FlatRasterRuntime {
        let camera = MapCamera::new(
            center[0],
            center[1],
            zoom,
            0.0,
            0.0,
            ViewportSize::new(width, height).unwrap(),
        )
        .unwrap();
        FlatRasterRuntime::new(
            camera,
            RasterSourceSpec::new(0, 19, 256).unwrap(),
            FlatRasterRuntimeLimits::default(),
        )
        .unwrap()
    }

    #[test]
    fn antimeridian_world_copies_share_one_canonical_request() {
        let mut runtime = runtime([179.9, 0.0], 0.0, 800.0, 400.0);
        let plan = runtime.frame_plan().unwrap();

        assert!(plan.placements.iter().any(|tile| tile.world_copy == 0));
        assert!(plan.placements.iter().any(|tile| tile.world_copy == 1));
        assert_eq!(plan.requests.len(), 1);
        assert_eq!(plan.requests[0], TileId::new(0, 0, 0).unwrap());
    }

    #[test]
    fn moving_view_cancels_pending_tiles_that_are_no_longer_visible() {
        let mut runtime = runtime([-120.0, 20.0], 4.0, 320.0, 240.0);
        let first = runtime.frame_plan().unwrap();
        assert!(!first.requests.is_empty());

        runtime.set_view_state(80.0, -20.0, 4.0).unwrap();
        let second = runtime.frame_plan().unwrap();

        assert!(!second.cancellations.is_empty());
        assert!(
            second
                .cancellations
                .iter()
                .all(|tile| first.requests.contains(tile))
        );
    }

    #[test]
    fn loaded_tiles_are_not_requested_again() {
        let mut runtime = runtime([13.405, 52.52], 5.0, 640.0, 480.0);
        let first = runtime.frame_plan().unwrap();
        let tile = first.requests[0];
        runtime.mark_loaded(tile);

        let second = runtime.frame_plan().unwrap();

        assert!(!second.requests.contains(&tile));
    }

    #[test]
    fn tile_cover_overflow_fails_closed() {
        let camera = MapCamera::new(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            ViewportSize::new(2000.0, 1000.0).unwrap(),
        )
        .unwrap();
        let limits = FlatRasterRuntimeLimits::new(1, 1, 1).unwrap();
        let mut runtime =
            FlatRasterRuntime::new(camera, RasterSourceSpec::new(0, 19, 256).unwrap(), limits)
                .unwrap();

        assert!(matches!(
            runtime.frame_plan(),
            Err(FlatRasterRuntimeError::TileCoverOverflow { .. })
        ));
    }

    #[test]
    fn fit_bounds_centers_and_scales_camera() {
        let mut runtime = runtime([0.0, 0.0], 1.0, 1024.0, 768.0);

        runtime
            .fit_bounds(-10.0, 40.0, 10.0, 50.0, 32.0, 12.0)
            .unwrap();
        let camera = runtime.camera();

        assert!(camera.longitude.abs() < 1e-9);
        assert!((40.0..50.0).contains(&camera.latitude));
        assert!(camera.zoom > 4.0);
        assert!(camera.zoom <= 12.0);
    }

    #[test]
    fn zoom_about_preserves_screen_anchor() {
        let mut runtime = runtime([13.405, 52.52], 5.0, 800.0, 600.0);
        let screen = ScreenCoordinate { x: 620.0, y: 240.0 };
        let before = runtime.unproject_screen(screen).unwrap();

        runtime.zoom_about(1.25, screen, 0.0, 20.0).unwrap();
        let after = runtime.unproject_screen(screen).unwrap();

        assert!((before.longitude - after.longitude).abs() < 1e-9);
        assert!((before.latitude - after.latitude).abs() < 1e-9);
    }
}
