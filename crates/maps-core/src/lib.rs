//! Maps-owned deterministic geographic computation primitives.
//!
//! This crate owns map-domain contracts while reusing lower-level geospatial
//! primitives where they fit. It deliberately contains no browser, rendering,
//! React, MapLibre, or JavaScript runtime concerns.

mod aggregation;
mod bounded_runtime;
mod engine;
mod flat_runtime;
mod matrix_camera;
mod scenario;

use std::collections::BTreeMap;

pub use aggregation::{
    AggregatedMapCluster, AggregatedMapFeature, AggregatedMapPoint, PointAggregationError,
    PointAggregationIndex, PointAggregationOptions, ViewportAggregation, ViewportAggregationQuery,
    VisibleAggregationSummary,
};
pub use bounded_runtime::BoundedFlatRasterRuntime;
pub use engine::{
    GeographicCoordinate, MapCamera, MapViewportBounds, ScreenCoordinate, TileId, ViewportSize,
    WorldCoordinate, clamp_mercator_latitude, project_web_mercator, unproject_web_mercator,
    world_size, wrap_longitude,
};
pub use flat_runtime::{
    FlatRasterRuntime, FlatRasterRuntimeError, FlatRasterRuntimeLimits, RasterFramePlan,
    RasterRenderCamera, RasterSourceSpec, RasterTilePlacement,
};
use geo_core::{BBox, Coordinate};
pub use matrix_camera::{MapLocalRenderFrame, MapLocalViewportBounds};
pub use scenario::{
    CameraObservation, CameraStateObservation, EngineImplementationIdentity, EngineScenarioError,
    EngineScenarioObservation, ProjectionObservation, ViewportObservation,
    VisibleBoundsObservation, execute_engine_scenario, execute_engine_scenario_json,
};

/// Numeric metrics attached to native map points.
pub type MapMetricRecord = BTreeMap<String, f64>;

/// A finite map coordinate in `[longitude, latitude]` order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapCoordinate {
    pub longitude: f64,
    pub latitude: f64,
}

impl MapCoordinate {
    /// Creates a coordinate when both values are finite.
    #[must_use]
    pub fn new(longitude: f64, latitude: f64) -> Option<Self> {
        Coordinate::new(longitude, latitude).ok()?;
        Some(Self {
            longitude,
            latitude,
        })
    }

    /// Returns this coordinate in `[longitude, latitude]` order.
    #[must_use]
    pub const fn as_array(self) -> [f64; 2] {
        [self.longitude, self.latitude]
    }
}

/// Map viewport bounds in `[west, south, east, north]` order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

impl MapBounds {
    /// Creates bounds when every value is finite and the extents are ordered.
    #[must_use]
    pub fn new(values: [f64; 4]) -> Option<Self> {
        let bbox = BBox::new(values).ok()?;
        Some(Self {
            west: bbox.min_lon,
            south: bbox.min_lat,
            east: bbox.max_lon,
            north: bbox.max_lat,
        })
    }

    /// Returns this value in `[west, south, east, north]` order.
    #[must_use]
    pub const fn as_array(self) -> [f64; 4] {
        [self.west, self.south, self.east, self.north]
    }
}

/// Native map data used as input to deterministic map computation.
#[derive(Clone, Debug, PartialEq)]
pub struct MapPoint {
    pub id: Option<String>,
    pub label: Option<String>,
    pub coordinates: MapCoordinate,
    pub metrics: MapMetricRecord,
}

impl MapPoint {
    #[must_use]
    pub fn new(
        id: Option<String>,
        label: Option<String>,
        longitude: f64,
        latitude: f64,
        metrics: MapMetricRecord,
    ) -> Option<Self> {
        Some(Self {
            id,
            label,
            coordinates: MapCoordinate::new(longitude, latitude)?,
            metrics,
        })
    }
}

/// Computes geographic bounds for a set of map points.
#[must_use]
pub fn bounds(points: &[MapPoint]) -> Option<MapBounds> {
    let mut iter = points.iter();
    let first = iter.next()?;
    let mut west = first.coordinates.longitude;
    let mut south = first.coordinates.latitude;
    let mut east = west;
    let mut north = south;

    for point in iter {
        west = west.min(point.coordinates.longitude);
        south = south.min(point.coordinates.latitude);
        east = east.max(point.coordinates.longitude);
        north = north.max(point.coordinates.latitude);
    }

    MapBounds::new([west, south, east, north])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_bounds_for_points() {
        let points = vec![
            MapPoint::new(None, None, 8.0, 48.0, MapMetricRecord::new()).unwrap(),
            MapPoint::new(None, None, 10.0, 50.0, MapMetricRecord::new()).unwrap(),
        ];

        assert_eq!(bounds(&points).unwrap().as_array(), [8.0, 48.0, 10.0, 50.0]);
    }

    #[test]
    fn rejects_non_finite_coordinates() {
        assert!(MapCoordinate::new(f64::NAN, 48.0).is_none());
    }
}