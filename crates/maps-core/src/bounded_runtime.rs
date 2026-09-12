//! Geographic camera constraints for the first-party flat raster runtime.
//!
//! This wrapper keeps the existing tile/cache runtime unchanged while making
//! bounded-camera semantics reusable by native and WASM hosts. The constraint
//! is applied after every camera mutation so browser hosts never become the
//! authority for geographic clamping or minimum-zoom derivation.

use crate::{
    FlatRasterRuntime, FlatRasterRuntimeError, MapBounds, MapCamera, RasterFramePlan,
    RasterSourceSpec, ScreenCoordinate, TileId, WorldCoordinate, project_web_mercator,
    unproject_web_mercator, world_size,
};

const CAMERA_TILE_SIZE: f64 = 512.0;
const WORLD_EPSILON: f64 = 1e-12;

/// Flat raster runtime with an optional geographic camera boundary.
#[derive(Debug)]
pub struct BoundedFlatRasterRuntime {
    inner: FlatRasterRuntime,
    max_bounds: Option<MapBounds>,
}

impl BoundedFlatRasterRuntime {
    pub fn new(
        inner: FlatRasterRuntime,
        max_bounds: Option<MapBounds>,
    ) -> Result<Self, FlatRasterRuntimeError> {
        validate_max_bounds(max_bounds)?;
        let mut runtime = Self { inner, max_bounds };
        runtime.apply_camera_constraint()?;
        Ok(runtime)
    }

    #[must_use]
    pub const fn camera(&self) -> MapCamera {
        self.inner.camera()
    }

    #[must_use]
    pub const fn source(&self) -> RasterSourceSpec {
        self.inner.source()
    }

    #[must_use]
    pub const fn max_bounds(&self) -> Option<MapBounds> {
        self.max_bounds
    }

    pub fn set_max_bounds(
        &mut self,
        max_bounds: Option<MapBounds>,
    ) -> Result<(), FlatRasterRuntimeError> {
        validate_max_bounds(max_bounds)?;
        let previous = self.max_bounds;
        self.max_bounds = max_bounds;

        if let Err(error) = self.apply_camera_constraint() {
            self.max_bounds = previous;
            return Err(error);
        }

        Ok(())
    }

    pub fn set_view_state(
        &mut self,
        longitude: f64,
        latitude: f64,
        zoom: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.inner.set_view_state(longitude, latitude, zoom)?;
        self.apply_camera_constraint()
    }

    pub fn resize(&mut self, width: f64, height: f64) -> Result<(), FlatRasterRuntimeError> {
        self.inner.resize(width, height)?;
        self.apply_camera_constraint()
    }

    pub fn pan_by_pixels(
        &mut self,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.inner.pan_by_pixels(delta_x, delta_y)?;
        self.apply_camera_constraint()
    }

    pub fn zoom_about(
        &mut self,
        delta_zoom: f64,
        screen: ScreenCoordinate,
        min_zoom: f64,
        max_zoom: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.inner
            .zoom_about(delta_zoom, screen, min_zoom, max_zoom)?;
        self.apply_camera_constraint()
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
        self.inner
            .fit_bounds(west, south, east, north, padding, max_zoom)?;
        self.apply_camera_constraint()
    }

    pub fn unproject_screen(
        &self,
        screen: ScreenCoordinate,
    ) -> Result<crate::GeographicCoordinate, FlatRasterRuntimeError> {
        self.inner.unproject_screen(screen)
    }

    pub fn mark_loaded(&mut self, tile: TileId) {
        self.inner.mark_loaded(tile);
    }

    pub fn mark_failed(&mut self, tile: TileId) {
        self.inner.mark_failed(tile);
    }

    pub fn frame_plan(&mut self) -> Result<RasterFramePlan, FlatRasterRuntimeError> {
        self.inner.frame_plan()
    }

    fn apply_camera_constraint(&mut self) -> Result<(), FlatRasterRuntimeError> {
        let Some(bounds) = self.max_bounds else {
            return Ok(());
        };
        let constrained = constrain_camera_to_bounds(self.inner.camera(), bounds)?;
        self.inner.set_view_state(
            constrained.longitude,
            constrained.latitude,
            constrained.zoom,
        )
    }
}

fn validate_max_bounds(max_bounds: Option<MapBounds>) -> Result<(), FlatRasterRuntimeError> {
    let Some(bounds) = max_bounds else {
        return Ok(());
    };

    if !bounds.west.is_finite()
        || !bounds.south.is_finite()
        || !bounds.east.is_finite()
        || !bounds.north.is_finite()
        || bounds.west > bounds.east
        || bounds.south > bounds.north
        || (bounds.east - bounds.west).abs() <= f64::EPSILON
    {
        return Err(FlatRasterRuntimeError::InvalidBounds);
    }

    let north_west = project_web_mercator(bounds.west, bounds.north)
        .ok_or(FlatRasterRuntimeError::InvalidBounds)?;
    let south_east = project_web_mercator(bounds.east, bounds.south)
        .ok_or(FlatRasterRuntimeError::InvalidBounds)?;

    if (south_east.y - north_west.y).abs() <= f64::EPSILON {
        return Err(FlatRasterRuntimeError::InvalidBounds);
    }

    Ok(())
}

fn constrain_camera_to_bounds(
    camera: MapCamera,
    bounds: MapBounds,
) -> Result<MapCamera, FlatRasterRuntimeError> {
    let north_west = project_web_mercator(bounds.west, bounds.north)
        .ok_or(FlatRasterRuntimeError::InvalidBounds)?;
    let south_east = project_web_mercator(bounds.east, bounds.south)
        .ok_or(FlatRasterRuntimeError::InvalidBounds)?;
    let longitude_span = ((bounds.east - bounds.west) / 360.0).clamp(0.0, 1.0);
    let latitude_span = (south_east.y - north_west.y).abs();

    if longitude_span <= f64::EPSILON || latitude_span <= f64::EPSILON {
        return Err(FlatRasterRuntimeError::InvalidBounds);
    }

    let minimum_zoom = minimum_zoom_for_bounds(camera, longitude_span, latitude_span)?;
    let zoom = camera.zoom.max(minimum_zoom);
    let size = world_size(zoom, CAMERA_TILE_SIZE).ok_or(FlatRasterRuntimeError::InvalidCamera)?;
    let center = project_web_mercator(camera.longitude, camera.latitude)
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
    let west_x = north_west.x;
    let east_x = west_x + longitude_span;
    let middle_x = (west_x + east_x) / 2.0;
    let center_x = center.x + (middle_x - center.x).round();
    let half_width = camera.viewport.width / size / 2.0;
    let half_height = camera.viewport.height / size / 2.0;
    let min_center_x = west_x + half_width;
    let max_center_x = east_x - half_width;
    let min_center_y = north_west.y + half_height;
    let max_center_y = south_east.y - half_height;
    let constrained_x = if min_center_x <= max_center_x + WORLD_EPSILON {
        center_x.clamp(min_center_x, max_center_x.max(min_center_x))
    } else {
        middle_x
    };
    let constrained_y = if min_center_y <= max_center_y + WORLD_EPSILON {
        center.y.clamp(min_center_y, max_center_y.max(min_center_y))
    } else {
        (north_west.y + south_east.y) / 2.0
    };
    let geographic = unproject_web_mercator(WorldCoordinate {
        x: constrained_x,
        y: constrained_y,
    })
    .ok_or(FlatRasterRuntimeError::InvalidCamera)?;

    MapCamera::new(
        geographic.longitude,
        geographic.latitude,
        zoom,
        camera.bearing,
        camera.pitch,
        camera.viewport,
    )
    .ok_or(FlatRasterRuntimeError::InvalidCamera)
}

fn minimum_zoom_for_bounds(
    camera: MapCamera,
    longitude_span: f64,
    latitude_span: f64,
) -> Result<f64, FlatRasterRuntimeError> {
    let horizontal_scale = camera.viewport.width / (CAMERA_TILE_SIZE * longitude_span);
    let vertical_scale = camera.viewport.height / (CAMERA_TILE_SIZE * latitude_span);
    let required_scale = horizontal_scale.max(vertical_scale);

    if !required_scale.is_finite() || required_scale <= 0.0 {
        return Err(FlatRasterRuntimeError::InvalidBounds);
    }

    Ok(required_scale.log2().max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FlatRasterRuntimeLimits, RasterSourceSpec, ViewportSize};

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

    fn europe_bounds() -> MapBounds {
        MapBounds::new([-25.0, 34.0, 35.0, 66.0]).unwrap()
    }

    fn assert_camera_inside_bounds(runtime: &BoundedFlatRasterRuntime, bounds: MapBounds) {
        let visible = runtime.camera().visible_bounds().unwrap();
        let epsilon = 1e-8;

        assert!(!visible.crosses_antimeridian);
        assert!(!visible.spans_full_world);
        assert!(
            visible.west >= bounds.west - epsilon,
            "west={}",
            visible.west
        );
        assert!(
            visible.east <= bounds.east + epsilon,
            "east={}",
            visible.east
        );
        assert!(
            visible.south >= bounds.south - epsilon,
            "south={}",
            visible.south
        );
        assert!(
            visible.north <= bounds.north + epsilon,
            "north={}",
            visible.north
        );
    }

    #[test]
    fn initialization_constrains_center_and_minimum_zoom() {
        let bounds = europe_bounds();
        let runtime =
            BoundedFlatRasterRuntime::new(runtime([120.0, 80.0], 1.0, 960.0, 620.0), Some(bounds))
                .unwrap();

        assert!(runtime.camera().zoom > 1.0);
        assert_camera_inside_bounds(&runtime, bounds);
    }

    #[test]
    fn programmatic_state_and_pan_cannot_escape_bounds() {
        let bounds = europe_bounds();
        let mut runtime = BoundedFlatRasterRuntime::new(
            runtime([13.405, 52.52], 6.0, 960.0, 620.0),
            Some(bounds),
        )
        .unwrap();

        runtime.set_view_state(150.0, -70.0, 2.0).unwrap();
        assert_camera_inside_bounds(&runtime, bounds);

        runtime.pan_by_pixels(-20_000.0, -20_000.0).unwrap();
        assert_camera_inside_bounds(&runtime, bounds);
    }

    #[test]
    fn zoom_out_stops_at_bounds_minimum_zoom() {
        let bounds = europe_bounds();
        let mut runtime = BoundedFlatRasterRuntime::new(
            runtime([13.405, 52.52], 6.0, 960.0, 620.0),
            Some(bounds),
        )
        .unwrap();

        runtime
            .zoom_about(-20.0, ScreenCoordinate { x: 480.0, y: 310.0 }, 0.0, 22.0)
            .unwrap();

        assert!(runtime.camera().zoom > 1.0);
        assert_camera_inside_bounds(&runtime, bounds);
    }

    #[test]
    fn resize_recomputes_bounds_minimum_zoom() {
        let bounds = europe_bounds();
        let mut runtime = BoundedFlatRasterRuntime::new(
            runtime([13.405, 52.52], 3.0, 320.0, 240.0),
            Some(bounds),
        )
        .unwrap();
        let before = runtime.camera().zoom;

        runtime.resize(1200.0, 900.0).unwrap();

        assert!(runtime.camera().zoom > before);
        assert_camera_inside_bounds(&runtime, bounds);
    }

    #[test]
    fn antimeridian_adjacent_bounds_choose_the_nearest_world_copy() {
        let bounds = MapBounds::new([170.0, -10.0, 190.0, 10.0]).unwrap();
        let runtime =
            BoundedFlatRasterRuntime::new(runtime([-179.0, 0.0], 5.0, 640.0, 480.0), Some(bounds))
                .unwrap();

        assert!(runtime.camera().longitude.abs() > 170.0);
    }
}
