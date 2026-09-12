use std::{
    collections::{BTreeSet, VecDeque},
    env, fs, process,
};

use maps_core::{
    EngineImplementationIdentity, FlatRasterRuntime, FlatRasterRuntimeLimits, MapCamera,
    RasterSourceSpec, TileId, ViewportSize, execute_engine_scenario,
};
use serde::{Deserialize, Serialize};

const RASTER_TILE_CHURN_V1: &str = "raster-tile-churn-v1";
const SCENARIO_SCHEMA_VERSION: &str = "maps.engine-scenario/v1";
const OBSERVATION_SCHEMA_VERSION: &str = "maps.engine-observation/v1";
const MAX_SETTLE_FRAMES: usize = 256;

fn main() {
    if let Err(error) = run() {
        eprintln!("maps-engine-scenario: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args().skip(1);
    let scenario_path = arguments
        .next()
        .ok_or("usage: maps-engine-scenario <scenario.json>")?;
    if arguments.next().is_some() {
        return Err("usage: maps-engine-scenario <scenario.json>".into());
    }

    let scenario_json = fs::read_to_string(&scenario_path)?;
    let identity: ScenarioIdentity = serde_json::from_str(&scenario_json)?;
    let observation = match identity.id.as_str() {
        RASTER_TILE_CHURN_V1 => serde_json::to_value(execute_raster_tile_churn(&scenario_json)?)?,
        _ => serde_json::to_value(execute_engine_scenario(
            &scenario_json,
            EngineImplementationIdentity::maps_rust(),
        )?)?,
    };
    println!("{}", serde_json::to_string_pretty(&observation)?);

    Ok(())
}

#[derive(Debug, Deserialize)]
struct ScenarioIdentity {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RasterTileChurnScenario {
    schema_version: String,
    id: String,
    fixture: RasterFixture,
    viewport: RasterViewport,
    initial_camera: RasterCamera,
    source: RasterSource,
    limits: RasterLimits,
    journey: Vec<RasterJourneyStep>,
    observations: Vec<String>,
    runtime_phases: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RasterFixture {
    source: String,
    network: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RasterViewport {
    width: f64,
    height: f64,
    device_pixel_ratio: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct RasterCamera {
    longitude: f64,
    latitude: f64,
    zoom: f64,
    bearing: f64,
    pitch: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RasterSource {
    min_zoom: u8,
    max_zoom: u8,
    tile_size: u16,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RasterLimits {
    max_visible_tiles: usize,
    cache_capacity: usize,
    load_concurrency: usize,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum RasterJourneyStep {
    Settle,
    PanScreen { dx: f64, dy: f64 },
    CompletePending { count: usize },
    ReverseBeforeIdle,
}

impl RasterJourneyStep {
    const fn name(self) -> &'static str {
        match self {
            Self::Settle => "settle",
            Self::PanScreen { .. } => "pan-screen",
            Self::CompletePending { .. } => "complete-pending",
            Self::ReverseBeforeIdle => "reverse-before-idle",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RasterTileChurnObservation {
    schema_version: String,
    scenario_id: String,
    implementation: EngineImplementationIdentity,
    fixture: RasterFixtureObservation,
    declared_observations: Vec<String>,
    runtime_phases: Vec<String>,
    frames: Vec<RasterFrameObservation>,
    final_visible_tile_set: Vec<TileObservation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RasterFixtureObservation {
    source: String,
    network: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RasterFrameObservation {
    sequence: usize,
    operation: String,
    visible_tile_set: Vec<TileObservation>,
    requested_tile_identities: Vec<TileObservation>,
    request_priority_order: Vec<TileObservation>,
    cancelled_requests: Vec<TileObservation>,
    deduplicated_requests: Vec<TileObservation>,
    cache_hits: Vec<TileObservation>,
    cache_misses: Vec<TileObservation>,
    evictions: Vec<TileObservation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct TileObservation {
    z: u8,
    x: u32,
    y: u32,
}

impl From<TileId> for TileObservation {
    fn from(tile: TileId) -> Self {
        Self {
            z: tile.z,
            x: tile.x,
            y: tile.y,
        }
    }
}

#[derive(Default)]
struct EvidenceState {
    pending: BTreeSet<TileId>,
    pending_order: VecDeque<TileId>,
    ready: BTreeSet<TileId>,
}

fn execute_raster_tile_churn(
    scenario_json: &str,
) -> Result<RasterTileChurnObservation, Box<dyn std::error::Error>> {
    let scenario: RasterTileChurnScenario = serde_json::from_str(scenario_json)?;
    validate_raster_scenario(&scenario)?;

    let viewport = ViewportSize::new(scenario.viewport.width, scenario.viewport.height)
        .ok_or("invalid raster scenario viewport")?;
    let camera = MapCamera::new(
        scenario.initial_camera.longitude,
        scenario.initial_camera.latitude,
        scenario.initial_camera.zoom,
        scenario.initial_camera.bearing,
        scenario.initial_camera.pitch,
        viewport,
    )
    .ok_or("invalid raster scenario camera")?;
    let source = RasterSourceSpec::new(
        scenario.source.min_zoom,
        scenario.source.max_zoom,
        scenario.source.tile_size,
    )
    .ok_or("invalid raster scenario source")?;
    let limits = FlatRasterRuntimeLimits::new(
        scenario.limits.max_visible_tiles,
        scenario.limits.cache_capacity,
        scenario.limits.load_concurrency,
    )
    .ok_or("invalid raster scenario limits")?;
    let mut runtime = FlatRasterRuntime::new(camera, source, limits)?;
    let mut evidence = EvidenceState::default();
    let mut frames = Vec::new();
    let mut sequence = 0;

    for step in scenario.journey.iter().copied() {
        match step {
            RasterJourneyStep::Settle => settle_runtime(
                &mut runtime,
                &mut evidence,
                &mut frames,
                &mut sequence,
                step.name(),
            )?,
            RasterJourneyStep::PanScreen { dx, dy } => {
                runtime.pan_by_pixels(dx, dy)?;
                capture_frame(
                    &mut runtime,
                    &mut evidence,
                    &mut frames,
                    &mut sequence,
                    step.name(),
                )?;
            }
            RasterJourneyStep::CompletePending { count } => {
                complete_pending(&mut runtime, &mut evidence, count);
                capture_frame(
                    &mut runtime,
                    &mut evidence,
                    &mut frames,
                    &mut sequence,
                    step.name(),
                )?;
            }
            RasterJourneyStep::ReverseBeforeIdle => {
                capture_frame(
                    &mut runtime,
                    &mut evidence,
                    &mut frames,
                    &mut sequence,
                    step.name(),
                )?;
            }
        }
    }

    let final_visible_tile_set = frames
        .last()
        .map(|frame| frame.visible_tile_set.clone())
        .ok_or("raster scenario produced no frames")?;

    Ok(RasterTileChurnObservation {
        schema_version: OBSERVATION_SCHEMA_VERSION.to_owned(),
        scenario_id: scenario.id,
        implementation: EngineImplementationIdentity {
            name: "maps-rust".to_owned(),
            protocol: "maps-core/raster-v1".to_owned(),
        },
        fixture: RasterFixtureObservation {
            source: scenario.fixture.source,
            network: scenario.fixture.network,
        },
        declared_observations: scenario.observations,
        runtime_phases: scenario.runtime_phases,
        frames,
        final_visible_tile_set,
    })
}

fn validate_raster_scenario(
    scenario: &RasterTileChurnScenario,
) -> Result<(), Box<dyn std::error::Error>> {
    if scenario.schema_version != SCENARIO_SCHEMA_VERSION {
        return Err(format!(
            "unsupported raster scenario schema {}",
            scenario.schema_version
        )
        .into());
    }
    if scenario.id != RASTER_TILE_CHURN_V1 {
        return Err(format!("unsupported raster scenario {}", scenario.id).into());
    }
    if scenario.fixture.source.is_empty() || scenario.fixture.network.is_empty() {
        return Err("raster scenario fixture identity must be non-empty".into());
    }
    if !scenario.viewport.device_pixel_ratio.is_finite()
        || scenario.viewport.device_pixel_ratio <= 0.0
    {
        return Err("raster scenario devicePixelRatio must be positive and finite".into());
    }
    if scenario.journey.is_empty()
        || scenario.observations.is_empty()
        || scenario.runtime_phases.is_empty()
    {
        return Err(
            "raster scenario must declare journey, observations, and runtime phases".into(),
        );
    }

    Ok(())
}

fn settle_runtime(
    runtime: &mut FlatRasterRuntime,
    evidence: &mut EvidenceState,
    frames: &mut Vec<RasterFrameObservation>,
    sequence: &mut usize,
    operation: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    for _ in 0..MAX_SETTLE_FRAMES {
        let requests = capture_frame(runtime, evidence, frames, sequence, operation)?;
        if requests.is_empty() {
            return Ok(());
        }
        complete_tiles(runtime, evidence, &requests);
    }

    Err("raster scenario did not settle within the bounded frame budget".into())
}

fn capture_frame(
    runtime: &mut FlatRasterRuntime,
    evidence: &mut EvidenceState,
    frames: &mut Vec<RasterFrameObservation>,
    sequence: &mut usize,
    operation: &str,
) -> Result<Vec<TileId>, Box<dyn std::error::Error>> {
    let pending_before = evidence.pending.clone();
    let plan = runtime.frame_plan()?;
    let visible = plan
        .placements
        .iter()
        .map(|placement| placement.tile)
        .collect::<BTreeSet<_>>();

    for tile in &plan.cancellations {
        evidence.pending.remove(tile);
    }
    retain_pending_order(evidence);
    for tile in &plan.evictions {
        evidence.ready.remove(tile);
    }

    let cache_hits = visible
        .intersection(&evidence.ready)
        .copied()
        .collect::<Vec<_>>();
    let cache_misses = visible
        .difference(&evidence.ready)
        .copied()
        .collect::<Vec<_>>();
    let mut deduplicated = visible
        .intersection(&pending_before)
        .copied()
        .collect::<BTreeSet<_>>();
    let mut placement_identities = BTreeSet::new();
    for placement in &plan.placements {
        if !placement_identities.insert(placement.tile) {
            deduplicated.insert(placement.tile);
        }
    }

    for tile in &plan.requests {
        if evidence.pending.insert(*tile) {
            evidence.pending_order.push_back(*tile);
        }
    }

    let requests = plan.requests.clone();
    frames.push(RasterFrameObservation {
        sequence: *sequence,
        operation: operation.to_owned(),
        visible_tile_set: tile_observations(visible),
        requested_tile_identities: tile_observations(plan.requests.iter().copied()),
        request_priority_order: tile_observations(plan.requests.iter().copied()),
        cancelled_requests: tile_observations(plan.cancellations.iter().copied()),
        deduplicated_requests: tile_observations(deduplicated),
        cache_hits: tile_observations(cache_hits),
        cache_misses: tile_observations(cache_misses),
        evictions: tile_observations(plan.evictions.iter().copied()),
    });
    *sequence += 1;

    Ok(requests)
}

fn complete_pending(runtime: &mut FlatRasterRuntime, evidence: &mut EvidenceState, count: usize) {
    let tiles = evidence
        .pending_order
        .iter()
        .copied()
        .filter(|tile| evidence.pending.contains(tile))
        .take(count)
        .collect::<Vec<_>>();
    complete_tiles(runtime, evidence, &tiles);
}

fn complete_tiles(runtime: &mut FlatRasterRuntime, evidence: &mut EvidenceState, tiles: &[TileId]) {
    for tile in tiles {
        if evidence.pending.remove(tile) {
            runtime.mark_loaded(*tile);
            evidence.ready.insert(*tile);
        }
    }
    retain_pending_order(evidence);
}

fn retain_pending_order(evidence: &mut EvidenceState) {
    let pending = &evidence.pending;
    let pending_order = &mut evidence.pending_order;
    pending_order.retain(|tile| pending.contains(tile));
}

fn tile_observations(tiles: impl IntoIterator<Item = TileId>) -> Vec<TileObservation> {
    tiles.into_iter().map(TileObservation::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RASTER_SCENARIO: &str =
        include_str!("../../../../engine-scenarios/raster-tile-churn-v1.json");

    #[test]
    fn raster_churn_scenario_exercises_scheduler_and_cache_evidence() {
        let observation =
            execute_raster_tile_churn(RASTER_SCENARIO).expect("raster churn scenario");

        assert_eq!(observation.scenario_id, RASTER_TILE_CHURN_V1);
        assert!(!observation.final_visible_tile_set.is_empty());
        assert!(
            observation
                .frames
                .iter()
                .any(|frame| !frame.cancelled_requests.is_empty())
        );
        assert!(
            observation
                .frames
                .iter()
                .any(|frame| !frame.deduplicated_requests.is_empty())
        );
        assert!(
            observation
                .frames
                .iter()
                .any(|frame| !frame.cache_hits.is_empty())
        );
        assert!(
            observation
                .frames
                .iter()
                .any(|frame| !frame.cache_misses.is_empty())
        );
        assert!(
            observation
                .frames
                .iter()
                .any(|frame| !frame.evictions.is_empty())
        );
        assert!(
            observation
                .frames
                .iter()
                .all(|frame| { frame.requested_tile_identities == frame.request_priority_order })
        );
    }

    #[test]
    fn raster_churn_observation_is_deterministic() {
        let first = execute_raster_tile_churn(RASTER_SCENARIO).expect("first raster observation");
        let second = execute_raster_tile_churn(RASTER_SCENARIO).expect("second raster observation");

        assert_eq!(first, second);
    }
}
