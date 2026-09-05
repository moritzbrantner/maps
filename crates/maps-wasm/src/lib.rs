use maps_core::{normalize_points_with_bounds, MapBounds, MapPoint, MapPointInput};
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
