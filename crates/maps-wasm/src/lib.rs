use maps_core::{
    MapBounds, MapClusterPoint, MapClusteringOptions, MapPoint, MapPointInput, MapViewportQuery,
    aggregate_viewport as aggregate_viewport_core, normalize_points_with_bounds,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct NormalizePointsResponse {
    bounds: Option<MapBounds>,
    points: Vec<MapPoint>,
}

#[wasm_bindgen(js_name = normalizePoints)]
pub fn normalize_points(points: JsValue) -> Result<JsValue, JsValue> {
    let points: Vec<MapPointInput> = serde_wasm_bindgen::from_value(points)
        .map_err(|error| JsValue::from_str(&format!("invalid map points: {error}")))?;
    let (points, bounds) = normalize_points_with_bounds(&points);

    serde_wasm_bindgen::to_value(&NormalizePointsResponse { bounds, points })
        .map_err(|error| JsValue::from_str(&format!("failed to serialize map points: {error}")))
}

#[wasm_bindgen(js_name = aggregateViewport)]
pub fn aggregate_viewport(
    points: JsValue,
    query: JsValue,
    options: JsValue,
) -> Result<JsValue, JsValue> {
    let points: Vec<MapClusterPoint> = serde_wasm_bindgen::from_value(points)
        .map_err(|error| JsValue::from_str(&format!("invalid cluster points: {error}")))?;
    let query: MapViewportQuery = serde_wasm_bindgen::from_value(query)
        .map_err(|error| JsValue::from_str(&format!("invalid viewport query: {error}")))?;
    let options: MapClusteringOptions = serde_wasm_bindgen::from_value(options)
        .map_err(|error| JsValue::from_str(&format!("invalid clustering options: {error}")))?;
    let result = aggregate_viewport_core(&points, query, options);

    serde_wasm_bindgen::to_value(&result)
        .map_err(|error| JsValue::from_str(&format!("failed to serialize viewport: {error}")))
}
