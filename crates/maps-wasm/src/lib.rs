//! Thin WebAssembly transport for `maps-core`.
//!
//! Map semantics belong in `maps-core`. This crate only translates JavaScript
//! values to and from that domain contract.

use std::collections::BTreeMap;

use maps_core::{
    AggregatedMapFeature, IndexedMapPoint, MapPoint,
    PointAggregationIndex as CorePointAggregationIndex, PointAggregationOptions,
    ViewportAggregation, ViewportAggregationQuery, get_bounds_from_points, normalize_map_points,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmMapPointInput {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    label: Option<String>,
    latitude: f64,
    longitude: f64,
    #[serde(default)]
    metrics: BTreeMap<String, f64>,
}

impl From<WasmMapPointInput> for MapPoint {
    fn from(point: WasmMapPointInput) -> Self {
        Self {
            id: point.id,
            label: point.label,
            latitude: point.latitude,
            longitude: point.longitude,
            metrics: point.metrics,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmIndexedMapPoint {
    id: String,
    label: String,
    latitude: f64,
    longitude: f64,
    metrics: BTreeMap<String, f64>,
}

impl From<IndexedMapPoint> for WasmIndexedMapPoint {
    fn from(point: IndexedMapPoint) -> Self {
        Self {
            id: point.id,
            label: point.label,
            latitude: point.latitude,
            longitude: point.longitude,
            metrics: point.metrics,
        }
    }
}

impl From<WasmIndexedMapPoint> for IndexedMapPoint {
    fn from(point: WasmIndexedMapPoint) -> Self {
        Self {
            id: point.id,
            label: point.label,
            latitude: point.latitude,
            longitude: point.longitude,
            metrics: point.metrics,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmPointAggregationOptions {
    extent: Option<f64>,
    max_zoom: Option<f64>,
    min_zoom: Option<f64>,
    radius: Option<f64>,
}

impl WasmPointAggregationOptions {
    fn into_core(self) -> Result<PointAggregationOptions, JsValue> {
        let defaults = PointAggregationOptions::default();
        Ok(PointAggregationOptions {
            extent: self.extent.unwrap_or(defaults.extent),
            max_zoom: decode_zoom(self.max_zoom, defaults.max_zoom, "maxZoom")?,
            min_zoom: decode_zoom(self.min_zoom, defaults.min_zoom, "minZoom")?,
            radius: self.radius.unwrap_or(defaults.radius),
        })
    }
}

#[derive(Debug, Deserialize)]
struct WasmViewportAggregationQuery {
    bounds: [f64; 4],
    zoom: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmVisibleAggregationSummary {
    bounds: [f64; 4],
    metrics: BTreeMap<String, f64>,
    visible_cluster_count: usize,
    visible_point_count: usize,
    visible_unclustered_count: usize,
    zoom: f64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WasmAggregatedMapFeature {
    Cluster {
        #[serde(rename = "clusterId")]
        cluster_id: usize,
        coordinates: [f64; 2],
        #[serde(rename = "expansionZoom")]
        expansion_zoom: usize,
        metrics: BTreeMap<String, f64>,
        #[serde(rename = "pointCount")]
        point_count: usize,
        #[serde(rename = "pointCountAbbreviated")]
        point_count_abbreviated: String,
    },
    Point {
        coordinates: [f64; 2],
        metrics: BTreeMap<String, f64>,
        #[serde(rename = "pointId")]
        point_id: String,
    },
}

#[derive(Debug, Serialize)]
struct WasmViewportAggregation {
    features: Vec<WasmAggregatedMapFeature>,
    summary: WasmVisibleAggregationSummary,
}

impl From<ViewportAggregation> for WasmViewportAggregation {
    fn from(aggregation: ViewportAggregation) -> Self {
        let features = aggregation
            .features
            .into_iter()
            .map(|feature| match feature {
                AggregatedMapFeature::Cluster(cluster) => WasmAggregatedMapFeature::Cluster {
                    cluster_id: cluster.cluster_id,
                    coordinates: cluster.coordinates,
                    expansion_zoom: cluster.expansion_zoom,
                    metrics: cluster.metrics,
                    point_count: cluster.point_count,
                    point_count_abbreviated: cluster.point_count_abbreviated,
                },
                AggregatedMapFeature::Point(point) => WasmAggregatedMapFeature::Point {
                    coordinates: point.coordinates,
                    metrics: point.metrics,
                    point_id: point.point.id,
                },
            })
            .collect();

        Self {
            features,
            summary: WasmVisibleAggregationSummary {
                bounds: aggregation.summary.bounds,
                metrics: aggregation.summary.metrics,
                visible_cluster_count: aggregation.summary.visible_cluster_count,
                visible_point_count: aggregation.summary.visible_point_count,
                visible_unclustered_count: aggregation.summary.visible_unclustered_count,
                zoom: aggregation.summary.zoom,
            },
        }
    }
}

/// Direct WASM handle over the Maps-owned Rust point aggregation index.
#[wasm_bindgen]
pub struct MapsPointAggregationIndex {
    inner: CorePointAggregationIndex,
}

#[wasm_bindgen]
impl MapsPointAggregationIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(points: JsValue, options: JsValue) -> Result<MapsPointAggregationIndex, JsValue> {
        let points = serde_wasm_bindgen::from_value::<Vec<WasmIndexedMapPoint>>(points)
            .map_err(to_js_error)?
            .into_iter()
            .map(IndexedMapPoint::from)
            .collect();
        let options = if options.is_null() || options.is_undefined() {
            PointAggregationOptions::default()
        } else {
            serde_wasm_bindgen::from_value::<WasmPointAggregationOptions>(options)
                .map_err(to_js_error)?
                .into_core()?
        };
        let inner = CorePointAggregationIndex::new(points, options).map_err(to_js_error)?;

        Ok(Self { inner })
    }

    #[wasm_bindgen(js_name = getViewportAggregation)]
    pub fn get_viewport_aggregation(&mut self, query: JsValue) -> Result<JsValue, JsValue> {
        let query = serde_wasm_bindgen::from_value::<WasmViewportAggregationQuery>(query)
            .map_err(to_js_error)?;
        let aggregation = self
            .inner
            .get_viewport_aggregation(ViewportAggregationQuery {
                bounds: query.bounds,
                zoom: query.zoom,
            })
            .map_err(to_js_error)?;

        encode_json_compatible(&WasmViewportAggregation::from(aggregation))
    }

    #[wasm_bindgen(js_name = getClusterLeaves)]
    pub fn get_cluster_leaves(
        &self,
        cluster_id: f64,
        limit: usize,
        offset: usize,
    ) -> Result<JsValue, JsValue> {
        let cluster_id = decode_identifier(cluster_id, "clusterId")?;
        let leaves = self
            .inner
            .get_cluster_leaves(cluster_id, limit, offset)
            .map_err(to_js_error)?
            .into_iter()
            .map(WasmIndexedMapPoint::from)
            .collect::<Vec<_>>();

        encode_json_compatible(&leaves)
    }

    #[wasm_bindgen(js_name = getClusterExpansionZoom)]
    pub fn get_cluster_expansion_zoom(&self, cluster_id: f64) -> Result<usize, JsValue> {
        self.inner
            .get_cluster_expansion_zoom(decode_identifier(cluster_id, "clusterId")?)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getPointById)]
    pub fn get_point_by_id(&self, point_id: &str) -> Result<JsValue, JsValue> {
        encode_json_compatible(
            &self
                .inner
                .get_point_by_id(point_id)
                .map(WasmIndexedMapPoint::from),
        )
    }
}

/// Normalizes native map points using the Maps-owned Rust contract.
#[wasm_bindgen(js_name = normalizeMapPoints)]
pub fn normalize_map_points_for_js(points: JsValue) -> Result<JsValue, JsValue> {
    let points = decode_points(points)?;
    let normalized = normalize_map_points(points)
        .into_iter()
        .map(WasmIndexedMapPoint::from)
        .collect::<Vec<_>>();

    encode_json_compatible(&normalized)
}

/// Computes `[west, south, east, north]` bounds from finite native map points.
#[wasm_bindgen(js_name = boundsFromMapPoints)]
pub fn bounds_from_map_points_for_js(points: JsValue) -> Result<JsValue, JsValue> {
    let points = decode_points(points)?;
    let bounds = get_bounds_from_points(&points).map(maps_core::MapBounds::as_array);

    encode_json_compatible(&bounds)
}

fn decode_points(points: JsValue) -> Result<Vec<MapPoint>, JsValue> {
    serde_wasm_bindgen::from_value::<Vec<WasmMapPointInput>>(points)
        .map(|points| points.into_iter().map(MapPoint::from).collect())
        .map_err(to_js_error)
}

fn decode_zoom(value: Option<f64>, default: u8, name: &str) -> Result<u8, JsValue> {
    let Some(value) = value else {
        return Ok(default);
    };
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=254.0).contains(&value) {
        return Err(JsValue::from_str(&format!(
            "{name} must be an integer between 0 and 254"
        )));
    }

    Ok(value as u8)
}

fn decode_identifier(value: f64, name: &str) -> Result<usize, JsValue> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > usize::MAX as f64 {
        return Err(JsValue::from_str(&format!(
            "{name} must be a non-negative integer"
        )));
    }

    Ok(value as usize)
}

fn encode_json_compatible<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(to_js_error)
}

fn to_js_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_conversion_does_not_own_map_semantics() {
        let point = WasmMapPointInput {
            id: Some("point-1".to_owned()),
            label: Some("Point 1".to_owned()),
            latitude: 49.0,
            longitude: 8.0,
            metrics: BTreeMap::from([("demand".to_owned(), 42.0)]),
        };

        let point = MapPoint::from(point);

        assert_eq!(point.id.as_deref(), Some("point-1"));
        assert_eq!(point.label.as_deref(), Some("Point 1"));
        assert_eq!(point.metrics.get("demand"), Some(&42.0));
    }
}
