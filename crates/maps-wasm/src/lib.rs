//! Thin WebAssembly transport for `maps-core`.
//!
//! Map semantics belong in `maps-core`. This crate only translates JavaScript
//! values to and from that domain contract.

mod engine_scenario;
#[cfg(all(
    target_arch = "wasm32",
    target_os = "unknown",
    feature = "wgpu-base-map"
))]
mod wgpu_base_map;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmPointAggregationOptions {
    #[serde(default)]
    min_zoom: Option<u8>,
    #[serde(default)]
    max_zoom: Option<u8>,
    #[serde(default)]
    radius: Option<f64>,
    #[serde(default)]
    extent: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmViewportAggregationQuery {
    bounds: [f64; 4],
    zoom: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmMapPoint {
    id: String,
    label: String,
    latitude: f64,
    longitude: f64,
    metrics: BTreeMap<String, f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmClusteredMapPoint {
    kind: &'static str,
    point_id: String,
    coordinates: [f64; 2],
    metrics: BTreeMap<String, f64>,
    point: WasmMapPoint,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmClusteredMapCluster {
    kind: &'static str,
    cluster_id: u64,
    point_count: usize,
    coordinates: [f64; 2],
    expansion_zoom: f64,
    metrics: BTreeMap<String, f64>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum WasmAggregatedMapFeature {
    Point(WasmClusteredMapPoint),
    Cluster(WasmClusteredMapCluster),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmViewportAggregationSummary {
    bounds: [f64; 4],
    zoom: f64,
    visible_point_count: usize,
    visible_cluster_count: usize,
    visible_unclustered_count: usize,
    metrics: BTreeMap<String, f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmViewportAggregation {
    features: Vec<WasmAggregatedMapFeature>,
    summary: WasmViewportAggregationSummary,
}

impl From<WasmPointAggregationOptions> for PointAggregationOptions {
    fn from(options: WasmPointAggregationOptions) -> Self {
        let defaults = PointAggregationOptions::default();
        Self {
            min_zoom: options.min_zoom.unwrap_or(defaults.min_zoom),
            max_zoom: options.max_zoom.unwrap_or(defaults.max_zoom),
            radius: options.radius.unwrap_or(defaults.radius),
            extent: options.extent.unwrap_or(defaults.extent),
        }
    }
}

impl From<WasmViewportAggregationQuery> for ViewportAggregationQuery {
    fn from(query: WasmViewportAggregationQuery) -> Self {
        Self {
            bounds: query.bounds,
            zoom: query.zoom,
        }
    }
}

impl From<&IndexedMapPoint> for WasmMapPoint {
    fn from(point: &IndexedMapPoint) -> Self {
        Self {
            id: point.id.clone(),
            label: point.label.clone(),
            latitude: point.latitude,
            longitude: point.longitude,
            metrics: point.metrics.clone(),
        }
    }
}

impl From<ViewportAggregation> for WasmViewportAggregation {
    fn from(aggregation: ViewportAggregation) -> Self {
        Self {
            features: aggregation
                .features
                .into_iter()
                .map(|feature| match feature {
                    AggregatedMapFeature::Point(feature) => {
                        WasmAggregatedMapFeature::Point(WasmClusteredMapPoint {
                            kind: "point",
                            point_id: feature.point_id,
                            coordinates: feature.coordinates,
                            metrics: feature.metrics,
                            point: WasmMapPoint::from(&feature.point),
                        })
                    }
                    AggregatedMapFeature::Cluster(feature) => {
                        WasmAggregatedMapFeature::Cluster(WasmClusteredMapCluster {
                            kind: "cluster",
                            cluster_id: feature.cluster_id,
                            point_count: feature.point_count,
                            coordinates: feature.coordinates,
                            expansion_zoom: feature.expansion_zoom,
                            metrics: feature.metrics,
                        })
                    }
                })
                .collect(),
            summary: WasmViewportAggregationSummary {
                bounds: aggregation.summary.bounds,
                zoom: aggregation.summary.zoom,
                visible_point_count: aggregation.summary.visible_point_count,
                visible_cluster_count: aggregation.summary.visible_cluster_count,
                visible_unclustered_count: aggregation.summary.visible_unclustered_count,
                metrics: aggregation.summary.metrics,
            },
        }
    }
}

#[wasm_bindgen(js_name = normalizeMapPoints)]
pub fn normalize_map_points_wasm(points: JsValue) -> Result<JsValue, JsValue> {
    let inputs = serde_wasm_bindgen::from_value::<Vec<WasmMapPointInput>>(points)
        .map_err(|error| js_error("invalid map point input", error))?;
    let normalized = normalize_map_points(inputs.into_iter().map(|point| MapPoint {
        id: point.id,
        label: point.label,
        latitude: point.latitude,
        longitude: point.longitude,
        metrics: point.metrics,
    }));

    serde_wasm_bindgen::to_value(
        &normalized
            .iter()
            .map(WasmMapPoint::from)
            .collect::<Vec<_>>(),
    )
    .map_err(|error| js_error("could not serialize normalized map points", error))
}

#[wasm_bindgen(js_name = getBoundsFromPoints)]
pub fn get_bounds_from_points_wasm(points: JsValue) -> Result<JsValue, JsValue> {
    let points = serde_wasm_bindgen::from_value::<Vec<WasmMapPointInput>>(points)
        .map_err(|error| js_error("invalid map point input", error))?;
    let normalized = normalize_map_points(points.into_iter().map(|point| MapPoint {
        id: point.id,
        label: point.label,
        latitude: point.latitude,
        longitude: point.longitude,
        metrics: point.metrics,
    }));
    serde_wasm_bindgen::to_value(&get_bounds_from_points(&normalized))
        .map_err(|error| js_error("could not serialize point bounds", error))
}

#[wasm_bindgen]
pub struct MapsPointAggregationIndex {
    index: CorePointAggregationIndex,
}

#[wasm_bindgen]
impl MapsPointAggregationIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(points: JsValue, options: JsValue) -> Result<MapsPointAggregationIndex, JsValue> {
        let points = serde_wasm_bindgen::from_value::<Vec<WasmMapPointInput>>(points)
            .map_err(|error| js_error("invalid aggregation point input", error))?;
        let options = serde_wasm_bindgen::from_value::<WasmPointAggregationOptions>(options)
            .map_err(|error| js_error("invalid aggregation options", error))?;
        let normalized = normalize_map_points(points.into_iter().map(|point| MapPoint {
            id: point.id,
            label: point.label,
            latitude: point.latitude,
            longitude: point.longitude,
            metrics: point.metrics,
        }));
        let index = CorePointAggregationIndex::new(normalized, options.into())
            .map_err(|error| js_error("could not build aggregation index", error))?;

        Ok(Self { index })
    }

    #[wasm_bindgen(js_name = getViewportAggregation)]
    pub fn get_viewport_aggregation(&self, query: JsValue) -> Result<JsValue, JsValue> {
        let query = serde_wasm_bindgen::from_value::<WasmViewportAggregationQuery>(query)
            .map_err(|error| js_error("invalid viewport aggregation query", error))?;
        let aggregation = self
            .index
            .get_viewport_aggregation(query.into())
            .map_err(|error| js_error("could not query aggregation index", error))?;
        serde_wasm_bindgen::to_value(&WasmViewportAggregation::from(aggregation))
            .map_err(|error| js_error("could not serialize viewport aggregation", error))
    }

    #[wasm_bindgen(js_name = getClusterExpansionZoom)]
    pub fn get_cluster_expansion_zoom(&self, cluster_id: u64) -> Result<f64, JsValue> {
        self.index
            .get_cluster_expansion_zoom(cluster_id)
            .map_err(|error| js_error("could not query cluster expansion zoom", error))
    }

    #[wasm_bindgen(js_name = getClusterLeaves)]
    pub fn get_cluster_leaves(
        &self,
        cluster_id: u64,
        limit: usize,
        offset: usize,
    ) -> Result<JsValue, JsValue> {
        let leaves = self
            .index
            .get_cluster_leaves(cluster_id, limit, offset)
            .map_err(|error| js_error("could not query cluster leaves", error))?;
        serde_wasm_bindgen::to_value(
            &leaves.iter().map(WasmMapPoint::from).collect::<Vec<_>>(),
        )
        .map_err(|error| js_error("could not serialize cluster leaves", error))
    }

    #[wasm_bindgen(js_name = getPointById)]
    pub fn get_point_by_id(&self, point_id: &str) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.index.get_point_by_id(point_id).map(WasmMapPoint::from))
            .map_err(|error| js_error("could not serialize point lookup", error))
    }
}

fn js_error(context: &str, error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> JsValue {
        serde_wasm_bindgen::to_value(&serde_json::json!({
            "minZoom": 0,
            "maxZoom": 16,
            "radius": 72,
            "extent": 512,
        }))
        .unwrap()
    }

    fn points() -> JsValue {
        serde_wasm_bindgen::to_value(&serde_json::json!([
            {
                "id": "berlin-a",
                "label": "Berlin A",
                "latitude": 52.52,
                "longitude": 13.405,
                "metrics": { "demand": 8, "revenue": 1200 }
            },
            {
                "id": "berlin-b",
                "label": "Berlin B",
                "latitude": 52.5204,
                "longitude": 13.4054,
                "metrics": { "demand": 5, "revenue": 900 }
            }
        ]))
        .unwrap()
    }

    #[test]
    fn aggregates_points() {
        let index = MapsPointAggregationIndex::new(points(), options()).unwrap();
        let query = serde_wasm_bindgen::to_value(&serde_json::json!({
            "bounds": [-180, -85, 180, 85],
            "zoom": 4,
        }))
        .unwrap();

        let result = index.get_viewport_aggregation(query).unwrap();
        let aggregation: serde_json::Value = serde_wasm_bindgen::from_value(result).unwrap();
        assert_eq!(aggregation["summary"]["visiblePointCount"], 2);
    }
}
