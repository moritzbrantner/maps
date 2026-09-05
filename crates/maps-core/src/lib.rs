mod clustering;

pub use clustering::{
    MapClusterPoint, MapClusteringOptions, MapMetricRecord, MapViewportAggregation,
    MapViewportFeature, MapViewportQuery, aggregate_viewport,
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapPoint {
    pub id: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapPointInput {
    #[serde(default)]
    pub id: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

pub fn normalize_points(points: &[MapPointInput]) -> Vec<MapPoint> {
    points
        .iter()
        .enumerate()
        .filter_map(|(index, point)| {
            if !point.latitude.is_finite() || !point.longitude.is_finite() {
                return None;
            }

            Some(MapPoint {
                id: point.id.clone().unwrap_or_else(|| index.to_string()),
                latitude: point.latitude,
                longitude: point.longitude,
            })
        })
        .collect()
}

pub fn bounds_from_points(points: &[MapPoint]) -> Option<MapBounds> {
    let first = points.first()?;
    let mut bounds = MapBounds {
        west: first.longitude,
        south: first.latitude,
        east: first.longitude,
        north: first.latitude,
    };

    for point in &points[1..] {
        bounds.west = bounds.west.min(point.longitude);
        bounds.south = bounds.south.min(point.latitude);
        bounds.east = bounds.east.max(point.longitude);
        bounds.north = bounds.north.max(point.latitude);
    }

    Some(bounds)
}

pub fn normalize_points_with_bounds(
    points: &[MapPointInput],
) -> (Vec<MapPoint>, Option<MapBounds>) {
    let normalized = normalize_points(points);
    let bounds = bounds_from_points(&normalized);
    (normalized, bounds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_assigns_stable_fallback_ids_and_rejects_non_finite_points() {
        let points = vec![
            MapPointInput {
                id: Some("berlin".to_string()),
                latitude: 52.52,
                longitude: 13.405,
            },
            MapPointInput {
                id: None,
                latitude: 48.7758,
                longitude: 9.1829,
            },
            MapPointInput {
                id: Some("invalid".to_string()),
                latitude: f64::NAN,
                longitude: 8.0,
            },
        ];

        assert_eq!(
            normalize_points(&points),
            vec![
                MapPoint {
                    id: "berlin".to_string(),
                    latitude: 52.52,
                    longitude: 13.405,
                },
                MapPoint {
                    id: "1".to_string(),
                    latitude: 48.7758,
                    longitude: 9.1829,
                },
            ]
        );
    }

    #[test]
    fn bounds_cover_only_normalized_points() {
        let (points, bounds) = normalize_points_with_bounds(&[
            MapPointInput {
                id: None,
                latitude: 52.52,
                longitude: 13.405,
            },
            MapPointInput {
                id: None,
                latitude: 48.7758,
                longitude: 9.1829,
            },
        ]);

        assert_eq!(points.len(), 2);
        assert_eq!(
            bounds,
            Some(MapBounds {
                west: 9.1829,
                south: 48.7758,
                east: 13.405,
                north: 52.52,
            })
        );
    }

    #[test]
    fn bounds_are_none_for_an_empty_normalized_set() {
        let (points, bounds) = normalize_points_with_bounds(&[MapPointInput {
            id: None,
            latitude: f64::INFINITY,
            longitude: 8.0,
        }]);

        assert!(points.is_empty());
        assert_eq!(bounds, None);
    }
}
