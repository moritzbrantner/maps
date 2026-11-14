//! Geographic camera constraints for the first-party flat raster runtime.
//!
//! This wrapper keeps the existing tile/cache runtime unchanged while making
//! bounded-camera semantics reusable by native and WASM hosts. The constraint
//! is applied after every camera mutation so browser hosts never become the
//! authority for geographic clamping or minimum-zoom derivation.

use crate::camera_flight::{CameraFlight, CameraPose};
use crate::flat_runtime::validate_camera;
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
    /// The in-flight animated `flyTo`. Every other camera command supersedes it.
    flight: Option<CameraFlight>,
}

impl BoundedFlatRasterRuntime {
    pub fn new(
        inner: FlatRasterRuntime,
        max_bounds: Option<MapBounds>,
    ) -> Result<Self, FlatRasterRuntimeError> {
        validate_max_bounds(max_bounds)?;
        validate_bounded_camera(inner.camera(), max_bounds)?;
        let mut runtime = Self {
            inner,
            max_bounds,
            flight: None,
        };
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
        self.flight = None;
        validate_max_bounds(max_bounds)?;
        validate_bounded_camera(self.inner.camera(), max_bounds)?;
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
        self.flight = None;
        self.inner.set_view_state(longitude, latitude, zoom)?;
        self.apply_camera_constraint()
    }

    pub fn set_camera_state(
        &mut self,
        longitude: f64,
        latitude: f64,
        zoom: f64,
        bearing: f64,
        pitch: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.flight = None;
        self.present_camera_state(longitude, latitude, zoom, bearing, pitch)
    }

    /// Starts an animated `flyTo` from the current camera (#433), superseding any flight.
    ///
    /// The target is validated and constrained as a camera command would be: an invalid or
    /// unsupported target (nonfinite input, a rotated or pitched bounded camera, a pitch the
    /// renderer cannot plan) fails closed and leaves the camera and any flight untouched.
    /// Returns the flight duration; `0` jumps to the target at once. Advance it with
    /// [`Self::advance_flight`]; any other camera command supersedes it.
    pub fn fly_to(
        &mut self,
        target: CameraPose,
        duration_ms: Option<f64>,
        min_zoom: f64,
        max_zoom: f64,
    ) -> Result<f64, FlatRasterRuntimeError> {
        let finite_target = [
            target.longitude,
            target.latitude,
            target.zoom,
            target.bearing,
            target.pitch,
        ]
        .iter()
        .all(|value| value.is_finite());
        if !finite_target || !min_zoom.is_finite() || !max_zoom.is_finite() || min_zoom > max_zoom {
            return Err(FlatRasterRuntimeError::InvalidCamera);
        }
        let viewport = self.inner.camera().viewport;
        let candidate = MapCamera::new(
            target.longitude,
            target.latitude,
            target.zoom.clamp(min_zoom, max_zoom),
            target.bearing,
            target.pitch,
            viewport,
        )
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        validate_bounded_camera(candidate, self.max_bounds)?;
        validate_camera(candidate)?;

        let (target, min_zoom) = match self.max_bounds {
            Some(bounds) => {
                let constrained = constrain_camera_to_bounds(candidate, bounds)?;
                // MapLibre limits the zoom-out to the constrained minimum zoom.
                let lowest = MapCamera::new(
                    constrained.longitude,
                    constrained.latitude,
                    min_zoom.min(self.inner.camera().zoom).min(constrained.zoom),
                    0.0,
                    0.0,
                    viewport,
                )
                .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
                let lowest = constrain_camera_to_bounds(lowest, bounds)?;
                (
                    CameraPose {
                        longitude: constrained.longitude,
                        latitude: constrained.latitude,
                        zoom: constrained.zoom,
                        bearing: 0.0,
                        pitch: 0.0,
                    },
                    min_zoom.max(lowest.zoom).min(max_zoom),
                )
            }
            None => (
                CameraPose {
                    latitude: candidate.latitude,
                    zoom: candidate.zoom,
                    pitch: candidate.pitch,
                    ..target
                },
                min_zoom,
            ),
        };
        let flight = CameraFlight::new(
            self.inner.camera(),
            target,
            duration_ms,
            min_zoom,
            max_zoom,
            // A bounded camera has no world copies to wrap through (MapLibre `lngRange`).
            self.max_bounds.is_none(),
        )
        .map_err(|_| FlatRasterRuntimeError::InvalidCamera)?;

        self.flight = None;
        if flight.duration_ms() <= 0.0 {
            self.present_pose(flight.target())?;
            return Ok(0.0);
        }
        self.flight = Some(flight);
        Ok(flight.duration_ms())
    }

    /// Presents the in-flight `flyTo` at `elapsed_ms` since it started. Returns whether the
    /// flight continues; the final frame presents the exact target. A camera state the
    /// runtime cannot present ends the flight on the last presented camera.
    pub fn advance_flight(&mut self, elapsed_ms: f64) -> Result<bool, FlatRasterRuntimeError> {
        let Some(flight) = self.flight else {
            return Ok(false);
        };
        if !elapsed_ms.is_finite() {
            self.flight = None;
            return Err(FlatRasterRuntimeError::InvalidCamera);
        }
        let finished = flight.is_finished_at(elapsed_ms);
        if let Err(error) = self.present_pose(flight.pose_at(elapsed_ms)) {
            self.flight = None;
            return Err(error);
        }
        if finished {
            self.flight = None;
        }
        Ok(!finished)
    }

    /// Ends the in-flight `flyTo` where it is, if any.
    pub fn cancel_flight(&mut self) {
        self.flight = None;
    }

    #[must_use]
    pub const fn is_flying(&self) -> bool {
        self.flight.is_some()
    }

    fn present_pose(&mut self, pose: CameraPose) -> Result<(), FlatRasterRuntimeError> {
        self.present_camera_state(
            pose.longitude,
            pose.latitude,
            pose.zoom,
            pose.bearing,
            pose.pitch,
        )
    }

    fn present_camera_state(
        &mut self,
        longitude: f64,
        latitude: f64,
        zoom: f64,
        bearing: f64,
        pitch: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        let candidate = MapCamera::new(
            longitude,
            latitude,
            zoom,
            bearing,
            pitch,
            self.inner.camera().viewport,
        )
        .ok_or(FlatRasterRuntimeError::InvalidCamera)?;
        validate_bounded_camera(candidate, self.max_bounds)?;
        self.inner
            .set_camera_state(longitude, latitude, zoom, bearing, pitch)?;
        self.apply_camera_constraint()
    }

    /// Presentation-only surface margin; see [`FlatRasterRuntime::set_render_margin`].
    pub fn set_render_margin(&mut self, margin: f64) -> Result<(), FlatRasterRuntimeError> {
        self.inner.set_render_margin(margin)
    }

    /// The constant background; see [`FlatRasterRuntime::set_background_style`].
    pub fn set_background_style(&mut self, json: &str) -> Result<(), String> {
        self.inner.set_background_style(json)
    }

    /// The style's sky; see [`FlatRasterRuntime::set_sky_style`].
    pub fn set_sky_style(&mut self, json: &str) -> Result<(), String> {
        self.inner.set_sky_style(json)
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
        self.flight = None;
        self.inner.pan_by_pixels(delta_x, delta_y)?;
        self.apply_camera_constraint()
    }

    pub fn pan_between_screen_points(
        &mut self,
        previous: ScreenCoordinate,
        current: ScreenCoordinate,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.flight = None;
        self.inner.pan_between_screen_points(previous, current)?;
        self.apply_camera_constraint()
    }

    pub fn zoom_about(
        &mut self,
        delta_zoom: f64,
        screen: ScreenCoordinate,
        min_zoom: f64,
        max_zoom: f64,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.flight = None;
        self.inner
            .zoom_about(delta_zoom, screen, min_zoom, max_zoom)?;
        self.apply_camera_constraint()
    }

    /// Bounded cameras are north-up/zero-pitch, so rotation is rejected there.
    pub fn rotate_about(
        &mut self,
        delta_bearing: f64,
        screen: ScreenCoordinate,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.flight = None;
        if self.max_bounds.is_some() && delta_bearing != 0.0 {
            return Err(FlatRasterRuntimeError::UnsupportedCamera);
        }
        self.inner.rotate_about(delta_bearing, screen)?;
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
        self.flight = None;
        self.inner
            .fit_bounds(west, south, east, north, padding, max_zoom)?;
        self.apply_camera_constraint()
    }

    pub fn project_screen(
        &self,
        longitude: f64,
        latitude: f64,
    ) -> Result<ScreenCoordinate, FlatRasterRuntimeError> {
        self.inner.project_screen(longitude, latitude)
    }

    pub fn project_screen_batch<'a>(
        &'a self,
        coordinates: &'a [[f64; 2]],
    ) -> impl Iterator<Item = Option<ScreenCoordinate>> + 'a {
        self.inner.project_screen_batch(coordinates)
    }

    pub fn unproject_screen(
        &self,
        screen: ScreenCoordinate,
    ) -> Result<crate::GeographicCoordinate, FlatRasterRuntimeError> {
        self.inner.unproject_screen(screen)
    }

    pub fn map_plane_scale(
        &self,
        screen: ScreenCoordinate,
    ) -> Result<Option<[f64; 4]>, FlatRasterRuntimeError> {
        self.inner.map_plane_scale(screen)
    }

    pub fn activate_tileset(
        &mut self,
        source: crate::MapsTileset,
    ) -> Result<(), FlatRasterRuntimeError> {
        self.inner.activate_tileset(source)
    }
    pub fn source_identity(&self) -> Option<String> {
        self.inner.source_identity()
    }
    pub fn take_source_evictions(&mut self) -> Vec<(String, TileId)> {
        self.inner.take_source_evictions()
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
        validate_bounded_camera(self.inner.camera(), self.max_bounds)?;
        let constrained = constrain_camera_to_bounds(self.inner.camera(), bounds)?;
        self.inner.set_view_state(
            constrained.longitude,
            constrained.latitude,
            constrained.zoom,
        )
    }
}

fn validate_bounded_camera(
    camera: MapCamera,
    max_bounds: Option<MapBounds>,
) -> Result<(), FlatRasterRuntimeError> {
    if max_bounds.is_some() && (camera.bearing != 0.0 || camera.pitch != 0.0) {
        return Err(FlatRasterRuntimeError::UnsupportedCamera);
    }
    Ok(())
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

    fn oriented_runtime(
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
    fn oriented_camera_with_max_bounds_fails_closed() {
        let bounds = europe_bounds();
        let inner = oriented_runtime([13.405, 52.52], 6.0, 30.0, 35.0, 960.0, 620.0);

        assert!(matches!(
            BoundedFlatRasterRuntime::new(inner, Some(bounds)),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        ));
    }

    #[test]
    fn oriented_camera_without_max_bounds_remains_supported() {
        let inner = oriented_runtime([13.405, 52.52], 6.0, 30.0, 35.0, 960.0, 620.0);
        let mut runtime = BoundedFlatRasterRuntime::new(inner, None).unwrap();

        assert!(runtime.frame_plan().is_ok());
        assert!(matches!(
            runtime.set_max_bounds(Some(europe_bounds())),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        ));
        assert_eq!(runtime.max_bounds(), None);
    }

    #[test]
    fn bounded_oriented_update_fails_without_mutating_camera() {
        let bounds = europe_bounds();
        let mut runtime = BoundedFlatRasterRuntime::new(
            runtime([13.405, 52.52], 6.0, 960.0, 620.0),
            Some(bounds),
        )
        .unwrap();
        let before = runtime.camera();

        assert!(matches!(
            runtime.set_camera_state(14.0, 53.0, 7.0, 30.0, 35.0),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        ));
        assert!(matches!(
            runtime.rotate_about(15.0, ScreenCoordinate { x: 480.0, y: 310.0 }),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        ));
        assert_eq!(runtime.camera(), before);
        runtime
            .rotate_about(0.0, ScreenCoordinate { x: 480.0, y: 310.0 })
            .unwrap();
        assert_eq!(runtime.camera(), before);
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

    fn pose(longitude: f64, latitude: f64, zoom: f64, bearing: f64, pitch: f64) -> CameraPose {
        CameraPose {
            longitude,
            latitude,
            zoom,
            bearing,
            pitch,
        }
    }

    fn camera_pose(runtime: &BoundedFlatRasterRuntime) -> CameraPose {
        let camera = runtime.camera();
        pose(
            camera.longitude,
            camera.latitude,
            camera.zoom,
            camera.bearing,
            camera.pitch,
        )
    }

    #[test]
    fn flight_presents_the_planned_trajectory_and_ends_exactly_on_target() {
        let mut runtime =
            BoundedFlatRasterRuntime::new(runtime([-74.006, 40.7128], 9.0, 800.0, 600.0), None)
                .unwrap();
        let start = runtime.camera();
        let target = pose(13.405, 52.52, 11.0, 40.0, 30.0);
        let duration = runtime.fly_to(target, None, 0.0, 22.0).unwrap();
        let reference = CameraFlight::new(start, target, None, 0.0, 22.0, true).unwrap();

        assert_eq!(duration, reference.duration_ms());
        assert!(runtime.is_flying());
        // Starting a flight presents nothing until the host advances it.
        assert_eq!(runtime.camera(), start);

        for step in 1..10 {
            let elapsed = duration * f64::from(step) / 10.0;
            assert!(runtime.advance_flight(elapsed).unwrap());
            let expected = reference.pose_at(elapsed);
            let actual = camera_pose(&runtime);
            assert!((actual.longitude - expected.longitude).abs() < 1e-9);
            assert!((actual.latitude - expected.latitude).abs() < 1e-9);
            assert!((actual.zoom - expected.zoom).abs() < 1e-12);
            assert!((actual.bearing - expected.bearing).abs() < 1e-9);
            assert!((actual.pitch - expected.pitch).abs() < 1e-9);
        }

        assert!(!runtime.advance_flight(duration + 16.0).unwrap());
        assert!(!runtime.is_flying());
        let end = camera_pose(&runtime);
        assert!((end.longitude - 13.405).abs() < 1e-12);
        assert!((end.latitude - 52.52).abs() < 1e-12);
        assert_eq!(end.zoom, 11.0);
        assert_eq!(end.bearing, 40.0);
        assert_eq!(end.pitch, 30.0);
        // Advancing a finished flight is a no-op.
        assert!(!runtime.advance_flight(duration * 2.0).unwrap());
        assert_eq!(camera_pose(&runtime), end);
    }

    #[test]
    fn camera_commands_supersede_an_in_flight_flight() {
        type Command = fn(&mut BoundedFlatRasterRuntime);
        let commands: [(&str, Command); 6] = [
            ("set_camera_state", |runtime| {
                runtime.set_camera_state(1.0, 2.0, 5.0, 0.0, 0.0).unwrap();
            }),
            ("pan", |runtime| {
                runtime
                    .pan_between_screen_points(
                        ScreenCoordinate { x: 400.0, y: 300.0 },
                        ScreenCoordinate { x: 420.0, y: 300.0 },
                    )
                    .unwrap();
            }),
            ("zoom", |runtime| {
                runtime
                    .zoom_about(0.5, ScreenCoordinate { x: 400.0, y: 300.0 }, 0.0, 22.0)
                    .unwrap();
            }),
            ("rotate", |runtime| {
                runtime
                    .rotate_about(10.0, ScreenCoordinate { x: 400.0, y: 300.0 })
                    .unwrap();
            }),
            ("fit_bounds", |runtime| {
                runtime.fit_bounds(0.0, 0.0, 10.0, 10.0, 0.0, 22.0).unwrap();
            }),
            ("cancel", |runtime| runtime.cancel_flight()),
        ];
        for (label, command) in commands {
            let mut runtime =
                BoundedFlatRasterRuntime::new(runtime([0.0, 0.0], 4.0, 800.0, 600.0), None)
                    .unwrap();
            runtime
                .fly_to(pose(60.0, 20.0, 6.0, 0.0, 0.0), Some(1000.0), 0.0, 22.0)
                .unwrap();
            runtime.advance_flight(300.0).unwrap();
            command(&mut runtime);
            let after_command = runtime.camera();

            assert!(!runtime.is_flying(), "{label}");
            assert!(!runtime.advance_flight(600.0).unwrap(), "{label}");
            assert_eq!(runtime.camera(), after_command, "{label}: no stale frame");
        }
    }

    #[test]
    fn a_new_flight_starts_from_the_presented_camera() {
        let mut runtime =
            BoundedFlatRasterRuntime::new(runtime([0.0, 0.0], 4.0, 800.0, 600.0), None).unwrap();
        runtime
            .fly_to(pose(60.0, 20.0, 6.0, 0.0, 0.0), Some(1000.0), 0.0, 22.0)
            .unwrap();
        runtime.advance_flight(400.0).unwrap();
        let interrupted = runtime.camera();
        runtime
            .fly_to(pose(-30.0, -10.0, 3.0, 0.0, 0.0), Some(500.0), 0.0, 22.0)
            .unwrap();
        runtime.advance_flight(0.0).unwrap();
        assert_eq!(runtime.camera(), interrupted);
        assert!(!runtime.advance_flight(500.0).unwrap());
        let end = runtime.camera();
        assert!((end.longitude + 30.0).abs() < 1e-12 && (end.latitude + 10.0).abs() < 1e-12);
        assert_eq!(end.zoom, 3.0);
    }

    #[test]
    fn resizing_keeps_the_geographic_flight() {
        let mut runtime =
            BoundedFlatRasterRuntime::new(runtime([0.0, 0.0], 4.0, 800.0, 600.0), None).unwrap();
        runtime
            .fly_to(pose(60.0, 20.0, 6.0, 0.0, 0.0), Some(1000.0), 0.0, 22.0)
            .unwrap();
        runtime.advance_flight(200.0).unwrap();
        runtime.resize(400.0, 300.0).unwrap();
        assert!(runtime.is_flying());
        assert!(!runtime.advance_flight(1000.0).unwrap());
        assert_eq!(runtime.camera().zoom, 6.0);
        assert_eq!(runtime.camera().viewport.width, 400.0);
    }

    #[test]
    fn invalid_or_unsupported_flights_fail_closed() {
        let mut runtime =
            BoundedFlatRasterRuntime::new(runtime([0.0, 0.0], 4.0, 800.0, 600.0), None).unwrap();
        runtime
            .fly_to(pose(60.0, 20.0, 6.0, 0.0, 0.0), Some(1000.0), 0.0, 22.0)
            .unwrap();
        runtime.advance_flight(100.0).unwrap();
        let presented = runtime.camera();

        for (target, duration, min, max) in [
            (pose(f64::NAN, 0.0, 4.0, 0.0, 0.0), None, 0.0, 22.0),
            (pose(0.0, 0.0, f64::INFINITY, 0.0, 0.0), None, 0.0, 22.0),
            (pose(0.0, 0.0, 4.0, f64::NAN, 0.0), None, 0.0, 22.0),
            (pose(0.0, 0.0, 4.0, 0.0, 0.0), Some(f64::NAN), 0.0, 22.0),
            (pose(0.0, 0.0, 4.0, 0.0, 0.0), Some(-1.0), 0.0, 22.0),
            (pose(0.0, 0.0, 4.0, 0.0, 0.0), None, 5.0, 2.0),
        ] {
            assert!(runtime.fly_to(target, duration, min, max).is_err());
            assert_eq!(runtime.camera(), presented);
            // A rejected command does not disturb the running flight.
            assert!(runtime.is_flying());
        }
        assert!(runtime.advance_flight(f64::NAN).is_err());
        assert!(!runtime.is_flying());
        assert_eq!(runtime.camera(), presented);

        // Bounded cameras are north-up and unpitched: a rotated/pitched flight is rejected.
        let mut bounded = BoundedFlatRasterRuntime::new(
            self::runtime([10.0, 50.0], 5.0, 800.0, 600.0),
            Some(europe_bounds()),
        )
        .unwrap();
        let before = bounded.camera();
        assert_eq!(
            bounded.fly_to(pose(12.0, 48.0, 6.0, 20.0, 0.0), None, 0.0, 22.0),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        );
        assert_eq!(
            bounded.fly_to(pose(12.0, 48.0, 6.0, 0.0, 30.0), None, 0.0, 22.0),
            Err(FlatRasterRuntimeError::UnsupportedCamera)
        );
        assert_eq!(bounded.camera(), before);
        assert!(!bounded.is_flying());
    }

    #[test]
    fn bounded_flights_stay_inside_the_bounds_and_clamp_the_zoom() {
        let bounds = europe_bounds();
        let mut runtime =
            BoundedFlatRasterRuntime::new(runtime([-10.0, 40.0], 6.0, 800.0, 600.0), Some(bounds))
                .unwrap();
        let duration = runtime
            .fly_to(pose(30.0, 60.0, 30.0, 0.0, 0.0), None, 0.0, 9.0)
            .unwrap();
        let mut elapsed = 0.0;
        while runtime.advance_flight(elapsed).unwrap() {
            assert_camera_inside_bounds(&runtime, bounds);
            elapsed += 16.0;
        }
        assert!(elapsed >= duration);
        assert_camera_inside_bounds(&runtime, bounds);
        assert_eq!(runtime.camera().zoom, 9.0);
    }

    #[test]
    fn zero_duration_flights_jump_and_dateline_flights_wrap() {
        let mut runtime =
            BoundedFlatRasterRuntime::new(runtime([170.0, 0.0], 4.0, 800.0, 600.0), None).unwrap();
        assert_eq!(
            runtime
                .fly_to(pose(-170.0, 5.0, 5.0, 0.0, 0.0), Some(0.0), 0.0, 22.0)
                .unwrap(),
            0.0
        );
        assert!(!runtime.is_flying());
        assert!((runtime.camera().longitude + 170.0).abs() < 1e-12);

        let mut runtime =
            BoundedFlatRasterRuntime::new(self::runtime([170.0, 0.0], 4.0, 800.0, 600.0), None)
                .unwrap();
        runtime
            .fly_to(pose(-170.0, 0.0, 4.0, 0.0, 0.0), Some(1000.0), 0.0, 22.0)
            .unwrap();
        for step in 1..10 {
            runtime.advance_flight(f64::from(step) * 100.0).unwrap();
            let longitude = runtime.camera().longitude;
            assert!(longitude >= 170.0 || longitude <= -170.0, "{longitude}");
        }
    }

    #[test]
    fn pitched_flights_interpolate_supported_pitch() {
        let mut runtime = BoundedFlatRasterRuntime::new(
            oriented_runtime([13.4, 52.5], 7.0, 30.0, 45.0, 800.0, 600.0),
            None,
        )
        .unwrap();
        runtime
            .fly_to(pose(2.35, 48.85, 8.0, -20.0, 10.0), Some(800.0), 0.0, 22.0)
            .unwrap();
        runtime.advance_flight(400.0).unwrap();
        let middle = runtime.camera();
        assert!(middle.pitch < 45.0 && middle.pitch > 10.0);
        assert!(middle.bearing < 30.0 && middle.bearing > -20.0);
        assert!(!runtime.advance_flight(800.0).unwrap());
        assert_eq!(runtime.camera().pitch, 10.0);
        assert_eq!(runtime.camera().bearing, -20.0);
    }
}
