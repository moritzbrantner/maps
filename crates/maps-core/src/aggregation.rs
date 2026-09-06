use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
};

use geojson::{Feature, Geometry, JsonObject, Value as GeoJsonValue, feature::Id};
use serde_json::{Value as JsonValue, json};
use supercluster::{CoordinateSystem, Supercluster};

use crate::{IndexedMapPoint, MapCoordinate, MapMetricRecord};

const DEFAULT_EXTENT: f64 = 512.0;
const DEFAULT_MAX_ZOOM: u8 = 16;
const DEFAULT_MIN_ZOOM: u8 = 0;
const DEFAULT_RADIUS: f64 = 72.0;
const MIN_POINTS_PER_CLUSTER: u8 = 2;

/// Configuration for the Maps-owned point aggregation contract.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointAggregationOptions {
    pub extent: f64,
    pub max_zoom: u8,
    pub min_zoom: u8,
    pub radius: f64,
}

impl Default for PointAggregationOptions {
    fn default() -> Self {
        Self {
            extent: DEFAULT_EXTENT,
            max_zoom: DEFAULT_MAX_ZOOM,
            min_zoom: DEFAULT_MIN_ZOOM,
            radius: DEFAULT_RADIUS,
        }
    }
}

/// A viewport aggregation query using `[west, south, east, north]` bounds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewportAggregationQuery {
    pub bounds: [f64; 4],
    pub zoom: f64,
}

/// One unclustered map point visible in a viewport.
#[derive(Clone, Debug, PartialEq)]
pub struct AggregatedMapPoint {
    pub coordinates: [f64; 2],
    pub metrics: MapMetricRecord,
    pub point: IndexedMapPoint,
}

/// One map cluster visible in a viewport.
#[derive(Clone, Debug, PartialEq)]
pub struct AggregatedMapCluster {
    pub cluster_id: usize,
    pub coordinates: [f64; 2],
    pub expansion_zoom: usize,
    pub metrics: MapMetricRecord,
    pub point_count: usize,
    pub point_count_abbreviated: String,
}

/// A renderer-independent map feature returned by viewport aggregation.
#[derive(Clone, Debug, PartialEq)]
pub enum AggregatedMapFeature {
    Cluster(AggregatedMapCluster),
    Point(AggregatedMapPoint),
}

/// Summary of the points represented by the visible map features.
#[derive(Clone, Debug, PartialEq)]
pub struct VisibleAggregationSummary {
    pub bounds: [f64; 4],
    pub metrics: MapMetricRecord,
    pub visible_cluster_count: usize,
    pub visible_point_count: usize,
    pub visible_unclustered_count: usize,
    pub zoom: f64,
}

/// Renderer-independent viewport aggregation result.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewportAggregation {
    pub features: Vec<AggregatedMapFeature>,
    pub summary: VisibleAggregationSummary,
}

/// Error produced when the Maps aggregation contract cannot be satisfied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PointAggregationError {
    message: String,
}

impl PointAggregationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for PointAggregationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for PointAggregationError {}

/// Maps-owned point aggregation index.
///
/// The internal spatial hierarchy is an implementation detail. Maps owns all
/// public types, metric reduction, point lookup, antimeridian de-duplication,
/// and validation semantics around that hierarchy.
pub struct PointAggregationIndex {
    cluster_metric_cache: BTreeMap<usize, MapMetricRecord>,
    index: Supercluster,
    metric_keys: Vec<String>,
    point_lookup: BTreeMap<String, IndexedMapPoint>,
    source_point_count: usize,
}

impl PointAggregationIndex {
    /// Builds an immutable spatial hierarchy from normalized native map points.
    pub fn new(
        points: Vec<IndexedMapPoint>,
        options: PointAggregationOptions,
    ) -> Result<Self, PointAggregationError> {
        validate_options(options)?;

        let points = points
            .into_iter()
            .filter(|point| MapCoordinate::new(point.longitude, point.latitude).is_some())
            .map(sanitize_indexed_point)
            .collect::<Vec<_>>();
        let metric_keys = collect_metric_keys(&points);
        let point_lookup = points
            .iter()
            .cloned()
            .map(|point| (point.id.clone(), point))
            .collect::<BTreeMap<_, _>>();
        let features = points.iter().map(to_geojson_feature).collect::<Vec<_>>();
        let cluster_options = Supercluster::builder()
            .coordinate_system(CoordinateSystem::LatLng)
            .extent(options.extent)
            .max_zoom(options.max_zoom)
            .min_points(MIN_POINTS_PER_CLUSTER)
            .min_zoom(options.min_zoom)
            .radius(options.radius)
            .build();
        let mut index = Supercluster::new(cluster_options);
        index
            .load(features)
            .map_err(|error| PointAggregationError::new(error.to_string()))?;

        Ok(Self {
            cluster_metric_cache: BTreeMap::new(),
            index,
            metric_keys,
            point_lookup,
            source_point_count: points.len(),
        })
    }

    /// Returns a normalized point by stable id.
    #[must_use]
    pub fn get_point_by_id(&self, point_id: &str) -> Option<IndexedMapPoint> {
        self.point_lookup.get(point_id).cloned()
    }

    /// Returns leaf points for a cluster with pagination.
    pub fn get_cluster_leaves(
        &self,
        cluster_id: usize,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<IndexedMapPoint>, PointAggregationError> {
        self.validate_cluster_id(cluster_id)?;

        Ok(self
            .index
            .get_leaves(cluster_id, limit, offset)
            .into_iter()
            .filter_map(|feature| point_id_from_feature(&feature))
            .filter_map(|point_id| self.point_lookup.get(&point_id).cloned())
            .collect())
    }

    /// Returns the zoom at which a cluster expands into multiple children.
    pub fn get_cluster_expansion_zoom(
        &self,
        cluster_id: usize,
    ) -> Result<usize, PointAggregationError> {
        self.validate_cluster_id(cluster_id)?;
        Ok(self.index.get_cluster_expansion_zoom(cluster_id))
    }

    /// Aggregates visible points and clusters for one viewport query.
    pub fn get_viewport_aggregation(
        &mut self,
        query: ViewportAggregationQuery,
    ) -> Result<ViewportAggregation, PointAggregationError> {
        validate_query(query)?;
        let zoom = rounded_zoom(query.zoom);
        let raw_features = self
            .index
            .get_clusters(query.bounds, zoom)
            .map_err(|error| PointAggregationError::new(error.to_string()))?;
        let mut seen = BTreeSet::new();
        let mut features = Vec::with_capacity(raw_features.len());

        for feature in raw_features {
            let Some(key) = feature_identity(&feature) else {
                continue;
            };
            if !seen.insert(key) {
                continue;
            }
            if let Some(feature) = self.resolve_aggregated_feature(&feature)? {
                features.push(feature);
            }
        }

        let summary = summarize_features(query, &features, &self.metric_keys);

        Ok(ViewportAggregation { features, summary })
    }

    fn resolve_aggregated_feature(
        &mut self,
        feature: &Feature,
    ) -> Result<Option<AggregatedMapFeature>, PointAggregationError> {
        let Some(coordinates) = coordinate_from_feature(feature) else {
            return Ok(None);
        };

        if is_cluster_feature(feature) {
            let Some(cluster_id) = cluster_id_from_feature(feature) else {
                return Ok(None);
            };
            let Some(point_count) = point_count_from_feature(feature) else {
                return Ok(None);
            };
            let expansion_zoom = self.get_cluster_expansion_zoom(cluster_id)?;
            let metrics = self.metrics_for_cluster(cluster_id)?;
            let point_count_abbreviated = feature
                .property("point_count_abbreviated")
                .map(json_value_to_string)
                .unwrap_or_else(|| point_count.to_string());

            return Ok(Some(AggregatedMapFeature::Cluster(AggregatedMapCluster {
                cluster_id,
                coordinates,
                expansion_zoom,
                metrics,
                point_count,
                point_count_abbreviated,
            })));
        }

        let Some(point_id) = point_id_from_feature(feature) else {
            return Ok(None);
        };
        let Some(point) = self.point_lookup.get(&point_id).cloned() else {
            return Ok(None);
        };

        Ok(Some(AggregatedMapFeature::Point(AggregatedMapPoint {
            coordinates: [point.longitude, point.latitude],
            metrics: point.metrics.clone(),
            point,
        })))
    }

    fn metrics_for_cluster(
        &mut self,
        cluster_id: usize,
    ) -> Result<MapMetricRecord, PointAggregationError> {
        if let Some(metrics) = self.cluster_metric_cache.get(&cluster_id) {
            return Ok(metrics.clone());
        }

        self.validate_cluster_id(cluster_id)?;
        let children = self
            .index
            .get_children(cluster_id)
            .map_err(|error| PointAggregationError::new(error.to_string()))?;
        let mut metrics = zero_metrics(&self.metric_keys);

        for child in children {
            if is_cluster_feature(&child) {
                let child_cluster_id = cluster_id_from_feature(&child).ok_or_else(|| {
                    PointAggregationError::new("cluster child is missing a numeric cluster id")
                })?;
                let child_metrics = self.metrics_for_cluster(child_cluster_id)?;
                add_metrics(&mut metrics, &child_metrics, &self.metric_keys);
            } else if let Some(point_id) = point_id_from_feature(&child)
                && let Some(point) = self.point_lookup.get(&point_id)
            {
                add_metrics(&mut metrics, &point.metrics, &self.metric_keys);
            }
        }

        self.cluster_metric_cache
            .insert(cluster_id, metrics.clone());
        Ok(metrics)
    }

    fn validate_cluster_id(&self, cluster_id: usize) -> Result<(), PointAggregationError> {
        if cluster_id < self.source_point_count {
            return Err(PointAggregationError::new(format!(
                "invalid cluster id {cluster_id}"
            )));
        }

        Ok(())
    }
}

fn validate_options(options: PointAggregationOptions) -> Result<(), PointAggregationError> {
    if !options.extent.is_finite() || options.extent <= 0.0 {
        return Err(PointAggregationError::new(
            "aggregation extent must be finite and greater than zero",
        ));
    }
    if !options.radius.is_finite() || options.radius < 0.0 {
        return Err(PointAggregationError::new(
            "aggregation radius must be finite and non-negative",
        ));
    }
    if options.min_zoom > options.max_zoom {
        return Err(PointAggregationError::new(
            "aggregation min zoom must not exceed max zoom",
        ));
    }
    if options.max_zoom == u8::MAX {
        return Err(PointAggregationError::new(
            "aggregation max zoom must be below 255",
        ));
    }

    Ok(())
}

fn validate_query(query: ViewportAggregationQuery) -> Result<(), PointAggregationError> {
    if !query.zoom.is_finite() || query.bounds.iter().any(|value| !value.is_finite()) {
        return Err(PointAggregationError::new(
            "viewport aggregation query must contain only finite values",
        ));
    }
    if query.bounds[1] > query.bounds[3] {
        return Err(PointAggregationError::new(
            "viewport south bound must not exceed north bound",
        ));
    }

    Ok(())
}

fn sanitize_indexed_point(mut point: IndexedMapPoint) -> IndexedMapPoint {
    point.metrics.retain(|_, value| value.is_finite());
    point
}

fn collect_metric_keys(points: &[IndexedMapPoint]) -> Vec<String> {
    points
        .iter()
        .flat_map(|point| point.metrics.keys().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn to_geojson_feature(point: &IndexedMapPoint) -> Feature {
    let mut properties = JsonObject::new();
    properties.insert("pointId".to_owned(), json!(point.id));
    let [longitude, latitude] = javascript_supercluster_coordinate(point.longitude, point.latitude);

    Feature {
        bbox: None,
        geometry: Some(Geometry::new(GeoJsonValue::Point(vec![longitude, latitude]))),
        id: Some(Id::String(point.id.clone())),
        properties: Some(properties),
        foreign_members: None,
    }
}

/// Reproduces Supercluster v8's Float32 storage precision for projected input points.
///
/// The JavaScript implementation rounds initial Web Mercator x/y values through
/// `Math.fround` before clustering. The Rust dependency stores f64 values, so we
/// inverse-project the rounded values before loading them. This keeps the internal
/// hierarchy numerically compatible while source point coordinates remain exact in
/// `point_lookup` and in public unclustered-point results.
fn javascript_supercluster_coordinate(longitude: f64, latitude: f64) -> [f64; 2] {
    let projected_x = f64::from((longitude / 360.0 + 0.5) as f32);
    let sin = latitude.to_radians().sin();
    let projected_y =
        (0.5 - (0.25 * ((1.0 + sin) / (1.0 - sin)).ln()) / std::f64::consts::PI).clamp(0.0, 1.0);
    let projected_y = f64::from(projected_y as f32);
    let longitude = (projected_x - 0.5) * 360.0;
    let mercator_y = ((180.0 - projected_y * 360.0) * std::f64::consts::PI) / 180.0;
    let latitude = (360.0 * mercator_y.exp().atan()) / std::f64::consts::PI - 90.0;

    [longitude, latitude]
}

fn is_cluster_feature(feature: &Feature) -> bool {
    feature
        .property("cluster")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
}

fn cluster_id_from_feature(feature: &Feature) -> Option<usize> {
    feature
        .property("cluster_id")
        .and_then(JsonValue::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn point_count_from_feature(feature: &Feature) -> Option<usize> {
    feature
        .property("point_count")
        .and_then(JsonValue::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn point_id_from_feature(feature: &Feature) -> Option<String> {
    match feature.id.as_ref()? {
        Id::String(value) => Some(value.clone()),
        Id::Number(value) => Some(value.to_string()),
    }
}

fn coordinate_from_feature(feature: &Feature) -> Option<[f64; 2]> {
    let geometry = feature.geometry.as_ref()?;
    let GeoJsonValue::Point(coordinates) = &geometry.value else {
        return None;
    };
    if coordinates.len() < 2 {
        return None;
    }

    MapCoordinate::new(coordinates[0], coordinates[1]).map(MapCoordinate::as_array)
}

fn feature_identity(feature: &Feature) -> Option<String> {
    if is_cluster_feature(feature) {
        return cluster_id_from_feature(feature).map(|cluster_id| format!("cluster:{cluster_id}"));
    }

    point_id_from_feature(feature).map(|point_id| format!("point:{point_id}"))
}

fn rounded_zoom(zoom: f64) -> u8 {
    zoom.round().clamp(0.0, f64::from(u8::MAX)) as u8
}

fn json_value_to_string(value: &JsonValue) -> String {
    match value {
        JsonValue::String(value) => value.clone(),
        JsonValue::Number(value) => value.to_string(),
        _ => value.to_string(),
    }
}

fn zero_metrics(metric_keys: &[String]) -> MapMetricRecord {
    metric_keys
        .iter()
        .cloned()
        .map(|metric_key| (metric_key, 0.0))
        .collect()
}

fn add_metrics(target: &mut MapMetricRecord, source: &MapMetricRecord, metric_keys: &[String]) {
    for metric_key in metric_keys {
        *target.entry(metric_key.clone()).or_insert(0.0) +=
            source.get(metric_key).copied().unwrap_or(0.0);
    }
}

fn summarize_features(
    query: ViewportAggregationQuery,
    features: &[AggregatedMapFeature],
    metric_keys: &[String],
) -> VisibleAggregationSummary {
    let mut metrics = zero_metrics(metric_keys);
    let mut visible_cluster_count = 0;
    let mut visible_point_count = 0;
    let mut visible_unclustered_count = 0;

    for feature in features {
        match feature {
            AggregatedMapFeature::Cluster(cluster) => {
                visible_cluster_count += 1;
                visible_point_count += cluster.point_count;
                add_metrics(&mut metrics, &cluster.metrics, metric_keys);
            }
            AggregatedMapFeature::Point(point) => {
                visible_point_count += 1;
                visible_unclustered_count += 1;
                add_metrics(&mut metrics, &point.metrics, metric_keys);
            }
        }
    }

    VisibleAggregationSummary {
        bounds: query.bounds,
        metrics,
        visible_cluster_count,
        visible_point_count,
        visible_unclustered_count,
        zoom: query.zoom,
    }
}
