use maps_core::{EngineImplementationIdentity, execute_engine_scenario};
use wasm_bindgen::prelude::*;

use crate::{encode_json_compatible, to_js_error};

/// Executes a canonical Maps engine scenario through the same Rust semantics
/// used by native consumers and returns the normalized observation envelope.
#[wasm_bindgen(js_name = executeEngineScenario)]
pub fn execute_engine_scenario_for_js(scenario: JsValue) -> Result<JsValue, JsValue> {
    let scenario =
        serde_wasm_bindgen::from_value::<serde_json::Value>(scenario).map_err(to_js_error)?;
    let scenario_json = serde_json::to_string(&scenario).map_err(to_js_error)?;
    let observation =
        execute_engine_scenario(&scenario_json, EngineImplementationIdentity::maps_rust())
            .map_err(to_js_error)?;

    encode_json_compatible(&observation)
}
