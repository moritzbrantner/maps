use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub type MapMetricRecord = BTreeMap<String, f64>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapClusterPoint {
    pub id: String,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default)]
    pub metrics: MapMetricRecord,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapViewportQuery {
    pub bounds: [f64; 4],
    pub zoom: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MapClusteringOptions {
    pub extent: u32,
    pub max_zoom: u8,
    pub min_zoom: u8,
    pub radius: f64,
}

impl Default for MapClusteringOptions {
    fn default() -> Self {
        Self {
            extent: 512,
            max_zoom: 16,
            min_zoom: 0,
            radius: 72.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum MapViewportFeature {
    Point {
        coordinates: [f64; 2],
        metrics: MapMetricRecord,
        point_id: String,
    },
    Cluster {
        cluster_id: u32,
        coordinates: [f64; 2],
        expansion_zoom: u8,
        metrics: MapMetricRecord,
        point_count: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapViewportAggregation {
    pub features: Vec<MapViewportFeature>,
}

pub fn aggregate_viewport(
    points: &[MapClusterPoint],
    query: MapViewportQuery,
    options: MapClusteringOptions,
) -> MapViewportAggregation {
    if !is_valid_query(query) {
        return MapViewportAggregation {
            features: Vec::new(),
        };
    }

    let options = normalize_options(options);
    let rounded_zoom = query.zoom.round().max(0.0) as u32;
    let min_zoom = u32::from(options.min_zoom);
    let max_zoom = u32::from(options.max_zoom);
    let zoom = rounded_zoom.clamp(min_zoom, max_zoom.saturating_add(1));
    let visible = points
        .iter()
        .filter(|point| is_finite_point(point) && point_in_bounds(point, query.bounds))
        .collect::<Vec<_>>();

    if zoom > max_zoom {
        return MapViewportAggregation {
            features: visible.into_iter().map(point_feature).collect(),
        };
    }

    let mut groups = BTreeMap::<(i64, i64), Vec<&MapClusterPoint>>::new();
    let cell_scale = cell_scale(zoom, options);

    for point in visible {
        let (x, y) = project(point.longitude, point.latitude);
        let key = (
            (x * cell_scale).floor() as i64,
            (y * cell_scale).floor() as i64,
        );
        groups.entry(key).or_default().push(point);
    }

    let features = groups
        .into_iter()
        .map(|((cell_x, cell_y), group)| {
            if group.len() == 1 {
                point_feature(group[0])
            } else {
                cluster_feature(zoom, cell_x, cell_y, &group, options)
            }
        })
        .collect();

    MapViewportAggregation { features }
}

fn normalize_options(options: MapClusteringOptions) -> MapClusteringOptions {
    let defaults = MapClusteringOptions::default();
    MapClusteringOptions {
        extent: if options.extent == 0 {
            defaults.extent
        } else {
            options.extent
        },
        max_zoom: options.max_zoom.max(options.min_zoom),
        min_zoom: options.min_zoom,
        radius: if options.radius.is_finite() && options.radius > 0.0 {
            options.radius
        } else {
            defaults.radius
        },
    }
}

fn is_valid_query(query: MapViewportQuery) -> bool {
    query.zoom.is_finite()
        && query.bounds.iter().all(|value| value.is_finite())
        && query.bounds[1] <= query.bounds[3]
}

fn is_finite_point(point: &MapClusterPoint) -> bool {
    point.latitude.is_finite() && point.longitude.is_finite()
}

fn point_in_bounds(point: &MapClusterPoint, bounds: [f64; 4]) -> bool {
    let longitude_visible = if bounds[0] <= bounds[2] {
        point.longitude >= bounds[0] && point.longitude <= bounds[2]
    } else {
        point.longitude >= bounds[0] || point.longitude <= bounds[2]
    };

    longitude_visible && point.latitude >= bounds[1] && point.latitude <= bounds[3]
}

fn point_feature(point: &MapClusterPoint) -> MapViewportFeature {
    MapViewportFeature::Point {
        coordinates: [point.longitude, point.latitude],
        metrics: finite_metrics(&point.metrics),
        point_id: point.id.clone(),
    }
}

fn cluster_feature(
    zoom: u32,
    cell_x: i64,
    cell_y: i64,
    points: &[&MapClusterPoint],
    options: MapClusteringOptions,
) -> MapViewportFeature {
    let point_count = points.len();
    let mut projected_x = 0.0;
    let mut projected_y = 0.0;
    let mut metrics = MapMetricRecord::new();

    for point in points {
        let (x, y) = project(point.longitude, point.latitude);
        projected_x += x;
        projected_y += y;

        for (key, value) in &point.metrics {
            if value.is_finite() {
                *metrics.entry(key.clone()).or_default() += value;
            }
        }
    }

    let count = point_count as f64;
    let coordinates = unproject(projected_x / count, projected_y / count);
    let max_expansion_zoom = options.max_zoom.saturating_add(1);

    MapViewportFeature::Cluster {
        cluster_id: stable_cluster_id(zoom, cell_x, cell_y),
        coordinates,
        expansion_zoom: u8::try_from(zoom.saturating_add(1))
            .unwrap_or(max_expansion_zoom)
            .min(max_expansion_zoom),
        metrics,
        point_count,
    }
}

fn finite_metrics(metrics: &MapMetricRecord) -> MapMetricRecord {
    metrics
        .iter()
        .filter(|(_, value)| value.is_finite())
        .map(|(key, value)| (key.clone(), *value))
        .collect()
}

fn cell_scale(zoom: u32, options: MapClusteringOptions) -> f64 {
    let world_size = f64::from(options.extent) * 2.0_f64.powi(zoom as i32);
    world_size / options.radius
}

fn project(longitude: f64, latitude: f64) -> (f64, f64) {
    let x = (longitude + 180.0) / 360.0;
    let latitude = latitude.clamp(-85.051_128_779_806_6, 85.051_128_779_806_6);
    let sin = latitude.to_radians().sin();
    let y = 0.5 - ((1.0 + sin) / (1.0 - sin)).ln() / (4.0 * std::f64::consts::PI);
    (x, y)
}

fn unproject(x: f64, y: f64) -> [f64; 2] {
    let longitude = x * 360.0 - 180.0;
    let latitude = (std::f64::consts::PI * (1.0 - 2.0 * y))
        .sinh()
        .atan()
        .to_degrees();
    [longitude, latitude]
}

fn stable_cluster_id(zoom: u32, cell_x: i64, cell_y: i64) -> u32 {
    let mut hash = 2_166_136_261_u32;
    hash = fnv1a(hash, &zoom.to_le_bytes());
    hash = fnv1a(hash, &cell_x.to_le_bytes());
    fnv1a(hash, &cell_y.to_le_bytes())
}

fn fnv1a(mut hash: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(id: &str, longitude: f64, latitude: f64, demand: f64) -> MapClusterPoint {
        MapClusterPoint {
            id: id.to_string(),
            latitude,
            longitude,
            metrics: BTreeMap::from([("demand".to_string(), demand)]),
        }
    }

    #[test]
    fn clusters_visible_points_and_sums_metrics() {
        let result = aggregate_viewport(
            &[
                point("a", 13.405, 52.52, 2.0),
                point("b", 13.405, 52.52, 3.0),
                point("far", 80.0, 0.0, 7.0),
            ],
            MapViewportQuery {
                bounds: [12.0, 51.0, 14.0, 53.0],
                zoom: 8.0,
            },
            MapClusteringOptions::default(),
        );

        assert_eq!(result.features.len(), 1);
        let MapViewportFeature::Cluster {
            metrics,
            point_count,
            ..
        } = &result.features[0]
        else {
            panic!("expected a cluster");
        };
        assert_eq!(*point_count, 2);
        assert_eq!(metrics.get("demand"), Some(&5.0));
    }

    #[test]
    fn supports_antimeridian_viewports() {
        let result = aggregate_viewport(
            &[
                point("east", 179.5, 0.0, 1.0),
                point("west", -179.5, 0.0, 1.0),
                point("middle", 0.0, 0.0, 1.0),
            ],
            MapViewportQuery {
                bounds: [170.0, -10.0, -170.0, 10.0],
                zoom: 17.0,
            },
            MapClusteringOptions::default(),
        );

        let ids = result
            .features
            .iter()
            .filter_map(|feature| match feature {
                MapViewportFeature::Point { point_id, .. } => Some(point_id.as_str()),
                MapViewportFeature::Cluster { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["east", "west"]);
    }

    #[test]
    fn returns_points_above_max_zoom() {
        let result = aggregate_viewport(
            &[
                point("a", 13.405, 52.52, 1.0),
                point("b", 13.405, 52.52, 1.0),
            ],
            MapViewportQuery {
                bounds: [12.0, 51.0, 14.0, 53.0],
                zoom: 17.0,
            },
            MapClusteringOptions::default(),
        );

        assert!(
            result
                .features
                .iter()
                .all(|feature| matches!(feature, MapViewportFeature::Point { .. }))
        );
    }

    #[test]
    fn cluster_ids_are_stable_for_the_same_cell() {
        assert_eq!(
            stable_cluster_id(8, 100, 200),
            stable_cluster_id(8, 100, 200)
        );
        assert_ne!(
            stable_cluster_id(8, 100, 200),
            stable_cluster_id(9, 100, 200)
        );
    }
}
