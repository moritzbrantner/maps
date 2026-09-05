//! Maps-owned deterministic geographic computation primitives.
//!
//! This crate owns map-domain contracts while reusing lower-level geospatial
//! primitives where they fit. It deliberately contains no browser, rendering,
//! React, MapLibre, or JavaScript runtime concerns.

use std::collections::BTreeMap;

use geo_core::{BBox, Coordinate};

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
    pub latitude: f64,
    pub longitude: f64,
    pub metrics: MapMetricRecord,
}

impl MapPoint {
    /// Creates a point with no id, label, or metrics.
    #[must_use]
    pub fn new(latitude: f64, longitude: f64) -> Self {
        Self {
            id: None,
            label: None,
            latitude,
            longitude,
            metrics: MapMetricRecord::new(),
        }
    }

    /// Sets an explicit stable point id.
    #[must_use]
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    /// Sets an optional display label.
    #[must_use]
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Adds a numeric metric. Non-finite metrics are removed during normalization.
    #[must_use]
    pub fn with_metric(mut self, key: impl Into<String>, value: f64) -> Self {
        self.metrics.insert(key.into(), value);
        self
    }
}

/// Normalized native map data with a stable string id and finite metrics.
#[derive(Clone, Debug, PartialEq)]
pub struct IndexedMapPoint {
    pub id: String,
    pub label: String,
    pub latitude: f64,
    pub longitude: f64,
    pub metrics: MapMetricRecord,
}

/// Normalizes one point without deciding whether its coordinates are usable.
///
/// The generated id uses the original input index. This preserves stable ids
/// even when an earlier point is later rejected for non-finite coordinates.
#[must_use]
pub fn normalize_map_point(mut point: MapPoint, input_index: usize) -> IndexedMapPoint {
    point.metrics.retain(|_, value| value.is_finite());

    IndexedMapPoint {
        id: point.id.unwrap_or_else(|| input_index.to_string()),
        label: point.label.unwrap_or_default(),
        latitude: point.latitude,
        longitude: point.longitude,
        metrics: point.metrics,
    }
}

/// Normalizes native map points and rejects non-finite coordinates.
#[must_use]
pub fn normalize_map_points(points: impl IntoIterator<Item = MapPoint>) -> Vec<IndexedMapPoint> {
    points
        .into_iter()
        .enumerate()
        .map(|(input_index, point)| normalize_map_point(point, input_index))
        .filter(is_finite_indexed_map_point)
        .collect()
}

/// Computes bounds from finite input points and ignores non-finite points.
#[must_use]
pub fn get_bounds_from_points(points: &[MapPoint]) -> Option<MapBounds> {
    get_bounds_from_coordinates(
        points
            .iter()
            .filter_map(|point| MapCoordinate::new(point.longitude, point.latitude)),
    )
}

/// Computes bounds from finite normalized points.
#[must_use]
pub fn get_bounds_from_indexed_points(points: &[IndexedMapPoint]) -> Option<MapBounds> {
    get_bounds_from_coordinates(
        points
            .iter()
            .filter_map(|point| MapCoordinate::new(point.longitude, point.latitude)),
    )
}

fn is_finite_indexed_map_point(point: &IndexedMapPoint) -> bool {
    MapCoordinate::new(point.longitude, point.latitude).is_some()
}

fn get_bounds_from_coordinates(
    coordinates: impl IntoIterator<Item = MapCoordinate>,
) -> Option<MapBounds> {
    let mut coordinates = coordinates.into_iter();
    let first = coordinates.next()?;
    let mut west = first.longitude;
    let mut south = first.latitude;
    let mut east = first.longitude;
    let mut north = first.latitude;

    for coordinate in coordinates {
        west = west.min(coordinate.longitude);
        south = south.min(coordinate.latitude);
        east = east.max(coordinate.longitude);
        north = north.max(coordinate.latitude);
    }

    MapBounds::new([west, south, east, north])
}
