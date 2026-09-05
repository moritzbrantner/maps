//! Thin WebAssembly transport for `maps-core`.
//!
//! Map semantics belong in `maps-core`. This crate only translates JavaScript
//! values to and from that domain contract.

use std::collections::BTreeMap;

use maps_core::{IndexedMapPoint, MapPoint, get_bounds_from_points, normalize_map_points};
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

#[derive(Debug, Serialize)]
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
