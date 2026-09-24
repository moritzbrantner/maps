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
    WorldCoordinate, project_web_mercator, unproject_web_mercator,
};

const CAMERA_TILE_SIZE: f64 = 512.0;
const DEFAULT_MAX_VISIBLE_TILES: usize = 256;
const DEFAULT_CACHE_CAPACITY: usize = 512;
const DEFAULT_LOAD_CONCURRENCY: usize = 8;
const REQUEST_PREFETCH_RADIUS_TILES: i64 = 1;
const WORLD_EPSILON: f64 = 1.0e-12;

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

/// Renderer-neutral camera data derived from the authoritative `MapCamera`.
///
/// Local raster geometry uses CSS-pixel units around the viewport center and is transformed by
/// this column-major matrix. Renderers consume this derived state; they never own geographic
/// longitude/latitude/zoom/bearing/pitch truth.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RasterRenderCamera {
    pub view_projection: [f32; 16],
}

/// One placement of a canonical XYZ tile.
///
/// A canonical tile may appear more than once when the viewport spans world copies. `world_copy`
/// distinguishes placement while `tile` remains the single request/cache identity. The local
/// map-plane fields are the durable renderer-neutral geometry: origin at the map center, +x east,
/// +y north, with `local_west`/`local_north` naming the north-west corner. The screen rectangle is
/// retained during renderer migration and remains exactly equivalent at bearing=0/pitch=0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RasterTilePlacement {
    pub tile: TileId,
    pub world_copy: i32,
    pub local_west: f64,
    pub local_north: f64,
    pub local_size: f64,
    pub screen_x: f64,
    pub screen_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
}

/// Deterministic browser work produced by one runtime frame.
#[derive(Clone, Debug, PartialEq)]
pub struct RasterFramePlan {
    pub render_camera: RasterRenderCamera,
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
                "flat raster camera configuration is unsupported for this operation",
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
    failed: BTreeSet<TileId>,
    ready: BTreeSet<TileId>,
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
            failed: BTreeSet::new(),
            ready: BTreeSet::new(),
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
        self.set_camera_state(
            longitude,
            latitude,
            zoom,
            self.camera.bearing,
            self.camera.pitch,
        )
    }

    pub fn set_camera_state(
        &mut self,
        longitude: f64,
        latitude: f64,
        zoom: f64,
        bearing: f64,
        pitch: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        let next = MapCamera::new(
            longitude,
            latitude,
            zoom,
            bearing,
            pitch,
            self.camera.viewport,
        )
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        validate_camera(next)?;
        self.camera = next;
        Ok(())
    }

    pub fn resize(&mut self, width: f64, height: f64) -> Result<(), FlatRasterRuntimeError> {
        let viewport =
            ViewportSize::new(width, height).ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let next = self
            .camera
            .with_viewport(viewport)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        validate_camera(next)?;
        self.camera = next;
        Ok(())
    }

    /// Pans a north-up zero-pitch camera by a pointer delta in CSS pixels.
    /// Oriented cameras require explicit screen anchors via `pan_between_screen_points`.
    pub fn pan_by_pixels(
        &mut self,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        if !delta_x.is_finite() || !delta_y.is_finite() {
            return Err(FlatRasterRuntimeError::InvalidCamera);
        }

        validate_camera(self.camera)?;
        if !is_flat_camera(self.camera) {
            return Err(FlatRasterRuntimeError::UnsupportedCamera);
        }

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

    /// Pans by moving the geographic ground point under `previous` to `current`.
    /// This explicit anchor contract is required for perspective cameras because
    /// screen-space translation is not geographically translation-invariant.
    pub fn pan_between_screen_points(
        &mut self,
        previous: ScreenCoordinate,
        current: ScreenCoordinate,
    ) -> Result<(), FlatRasterRuntimeError> {
        if !previous.x.is_finite()
            || !previous.y.is_finite()
            || !current.x.is_finite()
            || !current.y.is_finite()
        {
            return Err(FlatRasterRuntimeError::InvalidCamera);
        }

        validate_camera(self.camera)?;
        if is_flat_camera(self.camera) {
            return self.pan_by_pixels(current.x - previous.x, current.y - previous.y);
        }

        let previous_ground = self
            .camera
            .unproject_screen_matrix(previous)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
        let current_ground = self
            .camera
            .unproject_screen_matrix(current)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
        let previous_world =
            project_web_mercator(previous_ground.longitude, previous_ground.latitude)
                .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let current_world = project_web_mercator(current_ground.longitude, current_ground.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let center_world = project_web_mercator(self.camera.longitude, self.camera.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let next_center = unproject_web_mercator(WorldCoordinate {
            x: center_world.x + shortest_world_delta(previous_world.x - current_world.x),
            y: center_world.y + previous_world.y - current_world.y,
        })
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;

        self.set_camera_state(
            next_center.longitude,
            next_center.latitude,
            self.camera.zoom,
            self.camera.bearing,
            self.camera.pitch,
        )
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
        if is_flat_camera(self.camera) {
            let anchor = self
                .camera
                .unproject_screen(screen)
                .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
            let anchor_world = project_web_mercator(anchor.longitude, anchor.latitude)
                .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
            let zoom = (self.camera.zoom + delta_zoom).clamp(min_zoom, max_zoom);
            let next_size = CAMERA_TILE_SIZE * 2.0_f64.powf(zoom);
            if !next_size.is_finite() || next_size <= 0.0 {
                return Err(FlatRasterRuntimeError::InvalidCamera);
            }
            let center_world = WorldCoordinate {
                x: anchor_world.x - (screen.x - self.camera.viewport.width / 2.0) / next_size,
                y: anchor_world.y - (screen.y - self.camera.viewport.height / 2.0) / next_size,
            };
            let center = unproject_web_mercator(center_world)
                .ok_or(FlatRasterRuntimeError::InvalidCamera)?;

            return self.set_view_state(center.longitude, center.latitude, zoom);
        }

        let anchor = self
            .camera
            .unproject_screen_matrix(screen)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
        let zoom = (self.camera.zoom + delta_zoom).clamp(min_zoom, max_zoom);
        let provisional = MapCamera::new(
            self.camera.longitude,
            self.camera.latitude,
            zoom,
            self.camera.bearing,
            self.camera.pitch,
            self.camera.viewport,
        )
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        validate_camera(provisional)?;
        let provisional_anchor = provisional
            .unproject_screen_matrix(screen)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
        let anchor_world = project_web_mercator(anchor.longitude, anchor.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let provisional_anchor_world =
            project_web_mercator(provisional_anchor.longitude, provisional_anchor.latitude)
                .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let center_world = project_web_mercator(self.camera.longitude, self.camera.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let next_center = unproject_web_mercator(WorldCoordinate {
            x: center_world.x + shortest_world_delta(anchor_world.x - provisional_anchor_world.x),
            y: center_world.y + anchor_world.y - provisional_anchor_world.y,
        })
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;

        self.set_camera_state(
            next_center.longitude,
            next_center.latitude,
            zoom,
            self.camera.bearing,
            self.camera.pitch,
        )
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
        if !is_flat_camera(self.camera) {
            return Err(FlatRasterRuntimeError::UnsupportedCamera);
        }

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

    pub fn project_screen(
        &self,
        longitude: f64,
        latitude: f64,
    ) -> Result<ScreenCoordinate, FlatRasterRuntimeError> {
        validate_camera(self.camera)?;
        if is_flat_camera(self.camera) {
            return self
                .camera
                .project_screen(longitude, latitude)
                .ok_or(FlatRasterRuntimeError::UnsupportedCamera);
        }
        self.camera
            .project_screen_matrix(longitude, latitude)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)
    }

    pub fn unproject_screen(
        &self,
        screen: ScreenCoordinate,
    ) -> Result<GeographicCoordinate, FlatRasterRuntimeError> {
        validate_camera(self.camera)?;
        if is_flat_camera(self.camera) {
            return self
                .camera
                .unproject_screen(screen)
                .ok_or(FlatRasterRuntimeError::UnsupportedCamera);
        }
        self.camera
            .unproject_screen_matrix(screen)
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera)
    }

    /// Marks a browser-fetched tile ready and updates deterministic recency.
    /// Completions for cancelled or already completed requests are ignored.
    pub fn mark_loaded(&mut self, tile: TileId) {
        if self.pending.remove(&tile) && self.ready.insert(tile) {
            self.ready_lru.push_back(tile);
        }
    }

    /// Marks an active browser fetch failed. Suppress automatic retries while
    /// the tile remains visible so failures cannot starve the rest of the cover.
    /// A tile becomes eligible again after leaving and reentering the cover.
    pub fn mark_failed(&mut self, tile: TileId) {
        if self.pending.remove(&tile) {
            self.failed.insert(tile);
        }
    }

    /// Advances scheduling and returns work the host must dispatch exactly once.
    /// Retain the returned plan for redraws and queries; this is not a read-only snapshot.
    pub fn frame_plan(&mut self) -> Result<RasterFramePlan, FlatRasterRuntimeError> {
        validate_camera(self.camera)?;
        let local_render_frame = self
            .camera
            .local_render_frame()
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let render_camera = RasterRenderCamera {
            view_projection: local_render_frame.view_projection_elements(),
        };
        let placements =
            visible_tile_placements(self.camera, self.source, self.limits.max_visible_tiles)?;
        let visible_bounds = visible_bounds_for_camera(self.camera)?;
        let visible_tiles = placements
            .iter()
            .map(|placement| placement.tile)
            .collect::<BTreeSet<_>>();
        let center = project_web_mercator(self.camera.longitude, self.camera.latitude)
            .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        let request_tiles = buffered_request_cover(
            &visible_tiles,
            center,
            self.limits.cache_capacity,
            REQUEST_PREFETCH_RADIUS_TILES,
        );

        let mut cancellations = self
            .pending
            .iter()
            .copied()
            .filter(|tile| !request_tiles.contains(tile))
            .collect::<Vec<_>>();
        for tile in &cancellations {
            self.pending.remove(tile);
        }
        self.failed.retain(|tile| request_tiles.contains(tile));

        let evictions = self.prune_cache(&visible_tiles);
        let missing_visible = visible_tiles
            .iter()
            .filter(|tile| {
                !self.pending.contains(tile)
                    && !self.failed.contains(tile)
                    && !self.ready.contains(tile)
            })
            .count();
        let available_slots = self
            .limits
            .load_concurrency
            .saturating_sub(self.pending.len());
        let preemptions_needed = missing_visible.saturating_sub(available_slots);
        if preemptions_needed > 0 {
            let mut pending_prefetch = self
                .pending
                .iter()
                .copied()
                .filter(|tile| !visible_tiles.contains(tile))
                .collect::<Vec<_>>();
            pending_prefetch.sort_by(|left, right| {
                tile_center_distance_squared(*right, center)
                    .total_cmp(&tile_center_distance_squared(*left, center))
                    .then_with(|| right.cmp(left))
            });
            for tile in pending_prefetch.into_iter().take(preemptions_needed) {
                if self.pending.remove(&tile) {
                    cancellations.push(tile);
                }
            }
            cancellations.sort_unstable();
        }
        let available_slots = self
            .limits
            .load_concurrency
            .saturating_sub(self.pending.len());
        let mut request_candidates = request_tiles
            .iter()
            .copied()
            .filter(|tile| {
                !self.pending.contains(tile)
                    && !self.failed.contains(tile)
                    && !self.ready.contains(tile)
            })
            .collect::<Vec<_>>();
        request_candidates.sort_by(|left, right| {
            (!visible_tiles.contains(left))
                .cmp(&(!visible_tiles.contains(right)))
                .then_with(|| {
                    tile_center_distance_squared(*left, center)
                        .total_cmp(&tile_center_distance_squared(*right, center))
                })
                .then_with(|| left.cmp(right))
        });
        request_candidates.truncate(available_slots);

        for tile in &request_candidates {
            self.pending.insert(*tile);
        }
        touch_ready_tiles(&mut self.ready_lru, &self.ready, &visible_tiles);

        Ok(RasterFramePlan {
            render_camera,
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
                self.ready.remove(&tile);
                evictions.push(tile);
            }
        }

        evictions
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct CameraGroundWorldBounds {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
}

fn is_flat_camera(camera: MapCamera) -> bool {
    camera.bearing == 0.0 && camera.pitch == 0.0
}

fn validate_camera(camera: MapCamera) -> Result<(), FlatRasterRuntimeError> {
    camera
        .world_size()
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
    if !is_flat_camera(camera) && camera.local_viewport_bounds_matrix().is_none() {
        return Err(FlatRasterRuntimeError::UnsupportedCamera);
    }
    Ok(())
}

fn camera_ground_world_bounds(
    camera: MapCamera,
) -> Result<CameraGroundWorldBounds, FlatRasterRuntimeError> {
    let center = project_web_mercator(camera.longitude, camera.latitude)
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
    let size = camera
        .world_size()
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;

    if is_flat_camera(camera) {
        let half_width_world = camera.viewport.width / size / 2.0;
        let half_height_world = camera.viewport.height / size / 2.0;
        return Ok(CameraGroundWorldBounds {
            west: center.x - half_width_world,
            east: center.x + half_width_world,
            north: (center.y - half_height_world).clamp(0.0, 1.0),
            south: (center.y + half_height_world).clamp(0.0, 1.0),
        });
    }

    let local = camera
        .local_viewport_bounds_matrix()
        .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?;
    let west = center.x + local.west / size;
    let east = center.x + local.east / size;
    let north = (center.y - local.north / size).clamp(0.0, 1.0);
    let south = (center.y - local.south / size).clamp(0.0, 1.0);
    if ![west, south, east, north].into_iter().all(f64::is_finite) || west > east || north > south {
        return Err(FlatRasterRuntimeError::UnsupportedCamera);
    }

    Ok(CameraGroundWorldBounds {
        west,
        south,
        east,
        north,
    })
}

fn visible_bounds_for_camera(
    camera: MapCamera,
) -> Result<MapViewportBounds, FlatRasterRuntimeError> {
    if is_flat_camera(camera) {
        return camera
            .visible_bounds()
            .ok_or(FlatRasterRuntimeError::UnsupportedCamera);
    }

    let bounds = camera_ground_world_bounds(camera)?;
    let north = unproject_web_mercator(WorldCoordinate {
        x: 0.5,
        y: bounds.north,
    })
    .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?
    .latitude;
    let south = unproject_web_mercator(WorldCoordinate {
        x: 0.5,
        y: bounds.south,
    })
    .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?
    .latitude;
    let longitude_span = bounds.east - bounds.west;

    if longitude_span >= 1.0 - WORLD_EPSILON {
        return Ok(MapViewportBounds {
            west: -180.0,
            south: south.min(north),
            east: 180.0,
            north: south.max(north),
            crosses_antimeridian: false,
            spans_full_world: true,
        });
    }

    let west = unproject_web_mercator(WorldCoordinate {
        x: bounds.west,
        y: 0.5,
    })
    .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?
    .longitude;
    let east = unproject_web_mercator(WorldCoordinate {
        x: bounds.east,
        y: 0.5,
    })
    .ok_or(FlatRasterRuntimeError::UnsupportedCamera)?
    .longitude;

    Ok(MapViewportBounds {
        west,
        south: south.min(north),
        east,
        north: south.max(north),
        crosses_antimeridian: west > east,
        spans_full_world: false,
    })
}

fn shortest_world_delta(delta: f64) -> f64 {
    if delta >= 0.5 {
        delta - 1.0
    } else if delta < -0.5 {
        delta + 1.0
    } else {
        delta
    }
}

fn fit_zoom_for_span(available_pixels: f64, normalized_span: f64) -> f64 {
    if normalized_span <= f64::EPSILON {
        return f64::INFINITY;
    }

    (available_pixels / (CAMERA_TILE_SIZE * normalized_span)).log2()
}

fn source_covering_zoom(
    camera_zoom: f64,
    source: RasterSourceSpec,
) -> Result<u8, FlatRasterRuntimeError> {
    let source_zoom_offset = (CAMERA_TILE_SIZE / f64::from(source.tile_size)).log2();
    if !source_zoom_offset.is_finite() {
        return Err(FlatRasterRuntimeError::InvalidSource);
    }

    let covering_zoom = (camera_zoom + source_zoom_offset).floor();
    if !covering_zoom.is_finite() {
        return Err(FlatRasterRuntimeError::InvalidCamera);
    }

    Ok(covering_zoom.clamp(f64::from(source.min_zoom), f64::from(source.max_zoom)) as u8)
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
    let tile_zoom = source_covering_zoom(camera.zoom, source)?;
    let dimension = 1_i64
        .checked_shl(u32::from(tile_zoom))
        .ok_or(FlatRasterRuntimeError::InvalidSource)?;
    let ground_bounds = camera_ground_world_bounds(camera)?;
    let min_x = (ground_bounds.west * dimension as f64).floor() as i64;
    let max_x = ((ground_bounds.east * dimension as f64).ceil() as i64 - 1).max(min_x);
    let min_y = ((ground_bounds.north * dimension as f64).floor() as i64).clamp(0, dimension - 1);
    let max_y =
        ((ground_bounds.south * dimension as f64).ceil() as i64 - 1).clamp(min_y, dimension - 1);
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
            let local_west = (tile_world_x - center.x) * size;
            let local_north = (center.y - tile_world_y) * size;

            placements.push(RasterTilePlacement {
                tile,
                world_copy,
                local_west,
                local_north,
                local_size: tile_screen_size,
                screen_x: camera.viewport.width / 2.0 + local_west,
                screen_y: camera.viewport.height / 2.0 - local_north,
                screen_width: tile_screen_size,
                screen_height: tile_screen_size,
            });
        }
    }

    Ok(placements)
}

fn buffered_request_cover(
    visible: &BTreeSet<TileId>,
    camera_center: WorldCoordinate,
    cache_capacity: usize,
    radius: i64,
) -> BTreeSet<TileId> {
    if radius <= 0 || visible.len() >= cache_capacity {
        return visible.clone();
    }

    let mut buffered = visible.clone();
    for tile in visible {
        let dimension = 1_i64 << u32::from(tile.z);
        let tile_x = i64::from(tile.x);
        let tile_y = i64::from(tile.y);

        for delta_y in -radius..=radius {
            let y = tile_y + delta_y;
            if y < 0 || y >= dimension {
                continue;
            }
            let Ok(y) = u32::try_from(y) else {
                continue;
            };

            for delta_x in -radius..=radius {
                let x = (tile_x + delta_x).rem_euclid(dimension);
                let Ok(x) = u32::try_from(x) else {
                    continue;
                };
                if let Some(neighbor) = TileId::new(tile.z, x, y) {
                    buffered.insert(neighbor);
                }
            }
        }
    }

    if buffered.len() <= cache_capacity {
        return buffered;
    }

    let mut prefetch = buffered.difference(visible).copied().collect::<Vec<_>>();
    prefetch.sort_by(|left, right| {
        tile_center_distance_squared(*left, camera_center)
            .total_cmp(&tile_center_distance_squared(*right, camera_center))
            .then_with(|| left.cmp(right))
    });

    let mut bounded = visible.clone();
    bounded.extend(
        prefetch
            .into_iter()
            .take(cache_capacity.saturating_sub(visible.len())),
    );
    bounded
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

fn touch_ready_tiles(
    ready_lru: &mut VecDeque<TileId>,
    ready: &BTreeSet<TileId>,
    visible: &BTreeSet<TileId>,
) {
    ready_lru.retain(|tile| !visible.contains(tile));
    ready_lru.extend(visible.intersection(ready).copied());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(center: [f64; 2], zoom: f64, width: f64, height: f64) -> FlatRasterRuntime {
        runtime_with_camera(center, zoom, 0.0, 0.0, width, height)
    }

    fn runtime_with_camera(
        center: [f64; 2],
        zoom: f64,
        bearing: f64,
        pitch: f64,
        width: f64,
        height: f64,
    ) -> FlatRasterRuntime {
        let camera = MapCamera::new(
            center[0],
            center[1],
            zoom,
            bearing,
            pitch,
            ViewportSize::new(width, height).unwrap(),
        )
        .unwrap();
        FlatRasterRuntime::new(
            camera,
            RasterSourceSpec::new(0, 19, 512).unwrap(),
            FlatRasterRuntimeLimits::default(),
        )
        .unwrap()
    }

    #[test]
    fn source_tile_size_offsets_covering_zoom() {
        let camera = MapCamera::new(
            0.0,
            0.0,
            5.0,
            0.0,
            0.0,
            ViewportSize::new(256.0, 256.0).unwrap(),
        )
        .unwrap();
        let mut runtime = FlatRasterRuntime::new(
            camera,
            RasterSourceSpec::new(0, 19, 256).unwrap(),
            FlatRasterRuntimeLimits::default(),
        )
        .unwrap();
        let plan = runtime.frame_plan().unwrap();

        assert!(
            plan.placements
                .iter()
                .all(|placement| placement.tile.z == 6)
        );
        assert!(
            plan.placements
                .iter()
                .all(|placement| (placement.screen_width - 256.0).abs() < 1e-9)
        );
        assert!(
            plan.placements
                .iter()
                .all(|placement| (placement.screen_height - 256.0).abs() < 1e-9)
        );
    }

    #[test]
    fn raster_frame_exposes_local_plane_without_changing_flat_alignment() {
        let width = 800.0;
        let height = 600.0;
        let mut runtime = runtime([13.405, 52.52], 5.0, width, height);
        let plan = runtime.frame_plan().unwrap();

        assert!(
            plan.render_camera
                .view_projection
                .into_iter()
                .all(f32::is_finite)
        );
        assert!(!plan.placements.is_empty());
        for placement in plan.placements {
            assert!((placement.screen_x - (width * 0.5 + placement.local_west)).abs() < 1e-9);
            assert!((placement.screen_y - (height * 0.5 - placement.local_north)).abs() < 1e-9);
            assert!((placement.screen_width - placement.local_size).abs() < 1e-9);
            assert!((placement.screen_height - placement.local_size).abs() < 1e-9);
        }
    }

    #[test]
    fn oriented_camera_produces_a_finite_conservative_frame() {
        let mut runtime = runtime_with_camera([13.405, 52.52], 8.0, 30.0, 60.0, 800.0, 600.0);
        let plan = runtime.frame_plan().unwrap();

        assert!(!plan.placements.is_empty());
        assert!(
            plan.render_camera
                .view_projection
                .into_iter()
                .all(f32::is_finite)
        );
        assert!(plan.visible_bounds.west.is_finite());
        assert!(plan.visible_bounds.east.is_finite());
        assert!(plan.visible_bounds.south.is_finite());
        assert!(plan.visible_bounds.north.is_finite());
    }

    #[test]
    fn camera_crossing_ground_horizon_is_rejected() {
        let camera = MapCamera::new(
            13.405,
            52.52,
            8.0,
            0.0,
            85.0,
            ViewportSize::new(800.0, 600.0).unwrap(),
        )
        .unwrap();

        assert!(matches!(
            FlatRasterRuntime::new(
                camera,
                RasterSourceSpec::new(0, 19, 512).unwrap(),
                FlatRasterRuntimeLimits::default(),
            ),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        ));
    }

    #[test]
    fn oriented_pan_preserves_off_center_ground_anchor() {
        let mut runtime = runtime_with_camera([13.405, 52.52], 8.0, 45.0, 35.0, 800.0, 600.0);
        let previous = ScreenCoordinate { x: 640.0, y: 170.0 };
        let current = ScreenCoordinate { x: 710.0, y: 225.0 };
        let before = runtime.unproject_screen(previous).unwrap();

        runtime
            .pan_between_screen_points(previous, current)
            .unwrap();
        let after = runtime.unproject_screen(current).unwrap();

        assert!((before.longitude - after.longitude).abs() < 1.0e-5);
        assert!((before.latitude - after.latitude).abs() < 1.0e-5);
        assert_eq!(runtime.camera().bearing, 45.0);
        assert_eq!(runtime.camera().pitch, 35.0);
    }

    #[test]
    fn oriented_delta_only_pan_fails_closed() {
        let mut runtime = runtime_with_camera([13.405, 52.52], 8.0, 45.0, 35.0, 800.0, 600.0);

        assert!(matches!(
            runtime.pan_by_pixels(70.0, 55.0),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        ));
    }

    #[test]
    fn oriented_zoom_preserves_screen_anchor() {
        let mut runtime = runtime_with_camera([13.405, 52.52], 8.0, 25.0, 45.0, 800.0, 600.0);
        let screen = ScreenCoordinate { x: 620.0, y: 240.0 };
        let before = runtime.unproject_screen(screen).unwrap();

        runtime.zoom_about(1.25, screen, 0.0, 20.0).unwrap();
        let after = runtime.unproject_screen(screen).unwrap();

        assert!((before.longitude - after.longitude).abs() < 1.0e-5);
        assert!((before.latitude - after.latitude).abs() < 1.0e-5);
        assert_eq!(runtime.camera().bearing, 25.0);
        assert_eq!(runtime.camera().pitch, 45.0);
    }

    #[test]
    fn fit_bounds_fails_closed_for_oriented_camera() {
        let mut runtime = runtime_with_camera([0.0, 0.0], 5.0, 30.0, 30.0, 800.0, 600.0);

        assert!(matches!(
            runtime.fit_bounds(-10.0, 40.0, 10.0, 50.0, 32.0, 12.0),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        ));
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
    fn visible_tiles_are_scheduled_before_buffered_prefetch() {
        let mut runtime = runtime([13.405, 52.52], 5.0, 640.0, 480.0);
        let plan = runtime.frame_plan().unwrap();
        let visible = plan
            .placements
            .iter()
            .map(|placement| placement.tile)
            .collect::<BTreeSet<_>>();

        assert!(visible.len() < plan.requests.len());
        assert!(
            plan.requests
                .iter()
                .take(visible.len())
                .all(|tile| visible.contains(tile))
        );
        assert!(
            plan.requests
                .iter()
                .skip(visible.len())
                .any(|tile| !visible.contains(tile))
        );
    }

    #[test]
    fn visible_tiles_preempt_pending_prefetch() {
        let camera = MapCamera::new(
            0.0,
            0.0,
            5.0,
            0.0,
            0.0,
            ViewportSize::new(640.0, 480.0).unwrap(),
        )
        .unwrap();
        let limits = FlatRasterRuntimeLimits::new(64, 64, 4).unwrap();
        let mut runtime =
            FlatRasterRuntime::new(camera, RasterSourceSpec::new(0, 19, 512).unwrap(), limits)
                .unwrap();

        let first = runtime.frame_plan().unwrap();
        let initial_visible = first
            .placements
            .iter()
            .map(|placement| placement.tile)
            .collect::<BTreeSet<_>>();
        assert_eq!(first.requests.len(), 4);
        assert!(
            first
                .requests
                .iter()
                .all(|tile| initial_visible.contains(tile))
        );
        for tile in first.requests {
            runtime.mark_loaded(tile);
        }

        let prefetch = runtime.frame_plan().unwrap();
        assert_eq!(prefetch.requests.len(), 4);
        assert!(
            prefetch
                .requests
                .iter()
                .all(|tile| !initial_visible.contains(tile))
        );

        runtime.set_view_state(6.0, 0.0, 5.0).unwrap();
        let shifted = runtime.frame_plan().unwrap();
        let newly_visible = shifted
            .placements
            .iter()
            .map(|placement| placement.tile)
            .filter(|tile| !initial_visible.contains(tile))
            .collect::<BTreeSet<_>>();

        assert!(!newly_visible.is_empty());
        assert!(
            shifted
                .cancellations
                .iter()
                .any(|tile| prefetch.requests.contains(tile))
        );
        assert!(
            shifted
                .requests
                .iter()
                .all(|tile| newly_visible.contains(tile))
        );
    }

    #[test]
    fn prefetched_tile_is_reused_when_it_becomes_visible() {
        let mut runtime = runtime([13.405, 52.52], 5.0, 640.0, 480.0);
        let first = runtime.frame_plan().unwrap();
        let visible = first
            .placements
            .iter()
            .map(|placement| placement.tile)
            .collect::<BTreeSet<_>>();
        let prefetched = *first
            .requests
            .iter()
            .find(|tile| !visible.contains(tile))
            .expect("buffered prefetch request");
        runtime.mark_loaded(prefetched);

        let dimension = 2.0_f64.powi(i32::from(prefetched.z));
        let center = unproject_web_mercator(WorldCoordinate {
            x: (f64::from(prefetched.x) + 0.5) / dimension,
            y: (f64::from(prefetched.y) + 0.5) / dimension,
        })
        .expect("prefetched tile center");
        runtime
            .set_view_state(center.longitude, center.latitude, f64::from(prefetched.z))
            .unwrap();

        let next = runtime.frame_plan().unwrap();

        assert!(
            next.placements
                .iter()
                .any(|placement| placement.tile == prefetched)
        );
        assert!(!next.requests.contains(&prefetched));
    }

    #[test]
    fn prefetch_is_bounded_by_cache_capacity() {
        let camera = MapCamera::new(
            13.405,
            52.52,
            5.0,
            0.0,
            0.0,
            ViewportSize::new(640.0, 480.0).unwrap(),
        )
        .unwrap();
        let visible_count = visible_tile_placements(
            camera,
            RasterSourceSpec::new(0, 19, 512).unwrap(),
            DEFAULT_MAX_VISIBLE_TILES,
        )
        .unwrap()
        .into_iter()
        .map(|placement| placement.tile)
        .collect::<BTreeSet<_>>()
        .len();
        let limits =
            FlatRasterRuntimeLimits::new(visible_count, visible_count, DEFAULT_LOAD_CONCURRENCY)
                .unwrap();
        let mut runtime =
            FlatRasterRuntime::new(camera, RasterSourceSpec::new(0, 19, 512).unwrap(), limits)
                .unwrap();

        let plan = runtime.frame_plan().unwrap();

        assert_eq!(
            plan.requests.len(),
            visible_count.min(DEFAULT_LOAD_CONCURRENCY)
        );
        assert!(plan.requests.iter().all(|tile| {
            plan.placements
                .iter()
                .any(|placement| placement.tile == *tile)
        }));
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
