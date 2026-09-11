//! Canonical scenario execution for deterministic engine/reference evidence.
//!
//! Scenario identity and map-domain observations are Maps-owned. Profiling and
//! pass/fail evaluation deliberately remain outside this module.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{MapCamera, MapViewportBounds, ViewportSize, WorldCoordinate, wrap_longitude};

const SCENARIO_SCHEMA_VERSION: &str = "maps.engine-scenario/v1";
const OBSERVATION_SCHEMA_VERSION: &str = "maps.engine-observation/v1";
const CAMERA_WORLD_PAN_V1: &str = "camera-world-pan-v1";

/// Identity of the implementation that produced an observation envelope.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineImplementationIdentity {
    pub name: String,
    pub protocol: String,
}

impl EngineImplementationIdentity {
    #[must_use]
    pub fn maps_rust() -> Self {
        Self {
            name: "maps-rust".to_owned(),
            protocol: "maps-core/camera-v1".to_owned(),
        }
    }
}

/// Normalized observation envelope shared by native/WASM Maps execution and
/// browser reference adapters.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineScenarioObservation {
    pub schema_version: String,
    pub scenario_id: String,
    pub implementation: EngineImplementationIdentity,
    pub declared_observations: Vec<String>,
    pub runtime_phases: Vec<String>,
    pub states: Vec<CameraStateObservation>,
}

/// One camera state in deterministic operation order.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraStateObservation {
    pub sequence: usize,
    pub operation: String,
    pub camera: CameraObservation,
    pub visible_bounds: VisibleBoundsObservation,
    pub projections: Vec<ProjectionObservation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraObservation {
    pub longitude: f64,
    pub latitude: f64,
    pub zoom: f64,
    pub bearing: f64,
    pub pitch: f64,
    pub viewport: ViewportObservation,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportObservation {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleBoundsObservation {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    pub crosses_antimeridian: bool,
    pub spans_full_world: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionObservation {
    pub input: [f64; 2],
    pub wrapped_longitude: f64,
    pub world: [f64; 2],
    pub screen: [f64; 2],
    pub unprojected: [f64; 2],
}

/// Failure to decode or execute a canonical engine scenario.
#[derive(Debug)]
pub enum EngineScenarioError {
    Decode(serde_json::Error),
    Encode(serde_json::Error),
    Invalid(String),
    Unsupported(String),
}

impl fmt::Display for EngineScenarioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(error) => write!(formatter, "invalid engine scenario JSON: {error}"),
            Self::Encode(error) => {
                write!(formatter, "failed to encode engine observation: {error}")
            }
            Self::Invalid(message) => write!(formatter, "invalid engine scenario: {message}"),
            Self::Unsupported(message) => {
                write!(formatter, "unsupported engine scenario: {message}")
            }
        }
    }
}

impl std::error::Error for EngineScenarioError {}

/// Executes one supported canonical scenario and returns normalized semantic
/// observations. This function never profiles or decides whether a candidate
/// should ship.
pub fn execute_engine_scenario(
    scenario_json: &str,
    implementation: EngineImplementationIdentity,
) -> Result<EngineScenarioObservation, EngineScenarioError> {
    let scenario: CameraWorldScenario =
        serde_json::from_str(scenario_json).map_err(EngineScenarioError::Decode)?;

    if scenario.schema_version != SCENARIO_SCHEMA_VERSION {
        return Err(EngineScenarioError::Unsupported(format!(
            "schema version {}",
            scenario.schema_version
        )));
    }
    if scenario.id != CAMERA_WORLD_PAN_V1 {
        return Err(EngineScenarioError::Unsupported(format!(
            "scenario id {}",
            scenario.id
        )));
    }

    execute_camera_world_scenario(scenario, implementation)
}

/// Convenience JSON transport for CLI and non-WASM consumers.
pub fn execute_engine_scenario_json(
    scenario_json: &str,
    implementation: EngineImplementationIdentity,
) -> Result<String, EngineScenarioError> {
    let observation = execute_engine_scenario(scenario_json, implementation)?;
    serde_json::to_string(&observation).map_err(EngineScenarioError::Encode)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraWorldScenario {
    schema_version: String,
    id: String,
    viewport: ViewportInput,
    initial_camera: CameraInput,
    operations: Vec<CameraOperation>,
    coordinates: Vec<[f64; 2]>,
    observations: Vec<String>,
    runtime_phases: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct ViewportInput {
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct CameraInput {
    longitude: f64,
    latitude: f64,
    zoom: f64,
    bearing: f64,
    pitch: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum CameraOperation {
    SetCenter { longitude: f64, latitude: f64 },
    SetZoom { zoom: f64 },
    Resize { width: f64, height: f64 },
}

impl CameraOperation {
    const fn name(self) -> &'static str {
        match self {
            Self::SetCenter { .. } => "set-center",
            Self::SetZoom { .. } => "set-zoom",
            Self::Resize { .. } => "resize",
        }
    }
}

fn execute_camera_world_scenario(
    scenario: CameraWorldScenario,
    implementation: EngineImplementationIdentity,
) -> Result<EngineScenarioObservation, EngineScenarioError> {
    if scenario.coordinates.is_empty() {
        return Err(EngineScenarioError::Invalid(
            "camera scenario must contain projection coordinates".to_owned(),
        ));
    }
    if scenario.observations.is_empty() || scenario.runtime_phases.is_empty() {
        return Err(EngineScenarioError::Invalid(
            "camera scenario must declare observations and runtime phases".to_owned(),
        ));
    }

    let viewport = ViewportSize::new(scenario.viewport.width, scenario.viewport.height)
        .ok_or_else(|| EngineScenarioError::Invalid("invalid initial viewport".to_owned()))?;
    let mut camera = MapCamera::new(
        scenario.initial_camera.longitude,
        scenario.initial_camera.latitude,
        scenario.initial_camera.zoom,
        scenario.initial_camera.bearing,
        scenario.initial_camera.pitch,
        viewport,
    )
    .ok_or_else(|| EngineScenarioError::Invalid("invalid initial camera".to_owned()))?;

    let mut states = vec![capture_state(0, "initial", camera, &scenario.coordinates)?];

    for (index, operation) in scenario.operations.iter().copied().enumerate() {
        camera = apply_operation(camera, operation)?;
        states.push(capture_state(
            index + 1,
            operation.name(),
            camera,
            &scenario.coordinates,
        )?);
    }

    Ok(EngineScenarioObservation {
        schema_version: OBSERVATION_SCHEMA_VERSION.to_owned(),
        scenario_id: scenario.id,
        implementation,
        declared_observations: scenario.observations,
        runtime_phases: scenario.runtime_phases,
        states,
    })
}

fn apply_operation(
    camera: MapCamera,
    operation: CameraOperation,
) -> Result<MapCamera, EngineScenarioError> {
    let next = match operation {
        CameraOperation::SetCenter {
            longitude,
            latitude,
        } => camera.with_center(longitude, latitude),
        CameraOperation::SetZoom { zoom } => camera.with_zoom(zoom),
        CameraOperation::Resize { width, height } => {
            ViewportSize::new(width, height).and_then(|viewport| camera.with_viewport(viewport))
        }
    };

    next.ok_or_else(|| {
        EngineScenarioError::Invalid(format!(
            "operation {} produced an invalid camera",
            operation.name()
        ))
    })
}

fn capture_state(
    sequence: usize,
    operation: &str,
    camera: MapCamera,
    coordinates: &[[f64; 2]],
) -> Result<CameraStateObservation, EngineScenarioError> {
    let visible_bounds = camera.visible_bounds().ok_or_else(|| {
        EngineScenarioError::Unsupported(
            "camera scenario requires north-up zero-pitch visible bounds".to_owned(),
        )
    })?;
    let projections = coordinates
        .iter()
        .copied()
        .map(|coordinate| capture_projection(camera, coordinate))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(CameraStateObservation {
        sequence,
        operation: operation.to_owned(),
        camera: camera_observation(camera),
        visible_bounds: bounds_observation(visible_bounds),
        projections,
    })
}

fn capture_projection(
    camera: MapCamera,
    input: [f64; 2],
) -> Result<ProjectionObservation, EngineScenarioError> {
    let world = camera.project_world(input[0], input[1]).ok_or_else(|| {
        EngineScenarioError::Invalid(format!("invalid projection coordinate {input:?}"))
    })?;
    let screen = camera.project_screen(input[0], input[1]).ok_or_else(|| {
        EngineScenarioError::Unsupported("screen projection is unavailable".to_owned())
    })?;
    let unprojected = camera.unproject_screen(screen).ok_or_else(|| {
        EngineScenarioError::Unsupported("screen unprojection is unavailable".to_owned())
    })?;

    Ok(ProjectionObservation {
        input: input.map(canonical_zero),
        wrapped_longitude: canonical_zero(wrap_longitude(input[0])),
        world: world_array(world),
        screen: [canonical_zero(screen.x), canonical_zero(screen.y)],
        unprojected: [
            canonical_zero(unprojected.longitude),
            canonical_zero(unprojected.latitude),
        ],
    })
}

fn camera_observation(camera: MapCamera) -> CameraObservation {
    CameraObservation {
        longitude: canonical_zero(camera.longitude),
        latitude: canonical_zero(camera.latitude),
        zoom: canonical_zero(camera.zoom),
        bearing: canonical_zero(camera.bearing),
        pitch: canonical_zero(camera.pitch),
        viewport: ViewportObservation {
            width: canonical_zero(camera.viewport.width),
            height: canonical_zero(camera.viewport.height),
        },
    }
}

fn bounds_observation(bounds: MapViewportBounds) -> VisibleBoundsObservation {
    VisibleBoundsObservation {
        west: canonical_zero(bounds.west),
        south: canonical_zero(bounds.south),
        east: canonical_zero(bounds.east),
        north: canonical_zero(bounds.north),
        crosses_antimeridian: bounds.crosses_antimeridian,
        spans_full_world: bounds.spans_full_world,
    }
}

fn world_array(world: WorldCoordinate) -> [f64; 2] {
    [canonical_zero(world.x), canonical_zero(world.y)]
}

fn canonical_zero(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAMERA_SCENARIO: &str =
        include_str!("../../../engine-scenarios/camera-world-pan-v1.json");

    #[test]
    fn canonical_camera_scenario_executes_all_declared_operations() {
        let result = execute_engine_scenario(
            CAMERA_SCENARIO,
            EngineImplementationIdentity::maps_rust(),
        )
        .expect("canonical camera scenario");

        assert_eq!(result.schema_version, OBSERVATION_SCHEMA_VERSION);
        assert_eq!(result.scenario_id, CAMERA_WORLD_PAN_V1);
        assert_eq!(result.states.len(), 6);
        assert_eq!(result.states[1].camera.longitude, 179.75);
        assert_eq!(result.states[2].camera.longitude, -179.75);
        assert_eq!(result.states[4].camera.zoom, 3.5);
        assert_eq!(result.states[5].camera.viewport.width, 800.0);
        assert_eq!(result.states[5].camera.viewport.height, 600.0);
    }

    #[test]
    fn camera_scenario_observes_antimeridian_wrapping() {
        let result = execute_engine_scenario(
            CAMERA_SCENARIO,
            EngineImplementationIdentity::maps_rust(),
        )
        .expect("canonical camera scenario");
        let east_state = &result.states[1];

        assert!(east_state.visible_bounds.crosses_antimeridian);
        let west_point = east_state
            .projections
            .iter()
            .find(|projection| projection.input == [-179.9, -10.0])
            .expect("west-side coordinate");
        assert!(west_point.screen[0] > east_state.camera.viewport.width / 2.0);
        assert!((west_point.unprojected[0] + 179.9).abs() < 1e-9);
    }

    #[test]
    fn scenario_executor_rejects_unknown_scenario_identity() {
        let scenario = CAMERA_SCENARIO.replace(CAMERA_WORLD_PAN_V1, "camera-other-v1");
        let error = execute_engine_scenario(&scenario, EngineImplementationIdentity::maps_rust())
            .expect_err("unknown scenario must fail closed");

        assert!(error.to_string().contains("unsupported engine scenario"));
    }
}
