use maps_core::{
    EngineImplementationIdentity, FlatRasterRuntime as CoreFlatRasterRuntime,
    FlatRasterRuntimeLimits, MapCamera, RasterFramePlan, RasterSourceSpec, RasterTilePlacement,
    ScreenCoordinate, TileId, ViewportSize, execute_engine_scenario,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::{encode_json_compatible, to_js_error};

/// Executes a canonical Maps engine scenario through the same Rust semantics
/// used by native consumers and returns the normalized observation envelope.
#[wasm_bindgen(js_name = executeEngineScenario)]
pub fn execute_engine_scenario_for_js(scenario_json: &str) -> Result<JsValue, JsValue> {
    let observation =
        execute_engine_scenario(scenario_json, EngineImplementationIdentity::maps_rust())
            .map_err(to_js_error)?;

    encode_json_compatible(&observation)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmFlatRasterRuntimeConfig {
    center: [f64; 2],
    zoom: f64,
    width: f64,
    height: f64,
    source: WasmRasterSourceSpec,
    #[serde(default)]
    limits: Option<WasmFlatRasterRuntimeLimits>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmRasterSourceSpec {
    min_zoom: u8,
    max_zoom: u8,
    tile_size: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmFlatRasterRuntimeLimits {
    max_visible_tiles: usize,
    cache_capacity: usize,
    load_concurrency: usize,
}

#[derive(Debug, Serialize)]
struct WasmTileId {
    z: u8,
    x: u32,
    y: u32,
}

impl From<TileId> for WasmTileId {
    fn from(tile: TileId) -> Self {
        Self {
            z: tile.z,
            x: tile.x,
            y: tile.y,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmRasterTilePlacement {
    tile: WasmTileId,
    world_copy: i32,
    screen_x: f64,
    screen_y: f64,
    screen_width: f64,
    screen_height: f64,
}

impl From<RasterTilePlacement> for WasmRasterTilePlacement {
    fn from(placement: RasterTilePlacement) -> Self {
        Self {
            tile: placement.tile.into(),
            world_copy: placement.world_copy,
            screen_x: placement.screen_x,
            screen_y: placement.screen_y,
            screen_width: placement.screen_width,
            screen_height: placement.screen_height,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmCameraState {
    center: [f64; 2],
    zoom: f64,
    bearing: f64,
    pitch: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmVisibleBounds {
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    crosses_antimeridian: bool,
    spans_full_world: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmRasterFramePlan {
    camera: WasmCameraState,
    visible_bounds: WasmVisibleBounds,
    placements: Vec<WasmRasterTilePlacement>,
    requests: Vec<WasmTileId>,
    cancellations: Vec<WasmTileId>,
    evictions: Vec<WasmTileId>,
}

/// Stateful WASM transport over the Maps-owned flat raster runtime.
///
/// The browser host supplies input/network/pixel services. Camera, tile cover,
/// request scheduling, cancellation and cache policy remain Rust-owned.
#[wasm_bindgen]
pub struct MapsFlatRasterRuntime {
    inner: CoreFlatRasterRuntime,
}

#[wasm_bindgen]
impl MapsFlatRasterRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<MapsFlatRasterRuntime, JsValue> {
        let config = serde_wasm_bindgen::from_value::<WasmFlatRasterRuntimeConfig>(config)
            .map_err(to_js_error)?;
        let viewport = ViewportSize::new(config.width, config.height)
            .ok_or_else(|| JsValue::from_str("invalid flat raster viewport"))?;
        let camera = MapCamera::new(
            config.center[0],
            config.center[1],
            config.zoom,
            0.0,
            0.0,
            viewport,
        )
        .ok_or_else(|| JsValue::from_str("invalid flat raster camera"))?;
        let source = RasterSourceSpec::new(
            config.source.min_zoom,
            config.source.max_zoom,
            config.source.tile_size,
        )
        .ok_or_else(|| JsValue::from_str("invalid flat raster source"))?;
        let limits = match config.limits {
            Some(limits) => FlatRasterRuntimeLimits::new(
                limits.max_visible_tiles,
                limits.cache_capacity,
                limits.load_concurrency,
            )
            .ok_or_else(|| JsValue::from_str("invalid flat raster runtime limits"))?,
            None => FlatRasterRuntimeLimits::default(),
        };
        let inner = CoreFlatRasterRuntime::new(camera, source, limits).map_err(to_js_error)?;

        Ok(Self { inner })
    }

    #[wasm_bindgen(js_name = setViewState)]
    pub fn set_view_state(
        &mut self,
        longitude: f64,
        latitude: f64,
        zoom: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .set_view_state(longitude, latitude, zoom)
            .map_err(to_js_error)
    }

    pub fn resize(&mut self, width: f64, height: f64) -> Result<(), JsValue> {
        self.inner.resize(width, height).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = panBy)]
    pub fn pan_by(&mut self, delta_x: f64, delta_y: f64) -> Result<(), JsValue> {
        self.inner
            .pan_by_pixels(delta_x, delta_y)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = zoomAbout)]
    pub fn zoom_about(
        &mut self,
        delta_zoom: f64,
        screen_x: f64,
        screen_y: f64,
        min_zoom: f64,
        max_zoom: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .zoom_about(
                delta_zoom,
                ScreenCoordinate {
                    x: screen_x,
                    y: screen_y,
                },
                min_zoom,
                max_zoom,
            )
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = fitBounds)]
    pub fn fit_bounds(
        &mut self,
        west: f64,
        south: f64,
        east: f64,
        north: f64,
        padding: f64,
        max_zoom: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .fit_bounds(west, south, east, north, padding, max_zoom)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = markLoaded)]
    pub fn mark_loaded(&mut self, z: u8, x: u32, y: u32) -> Result<(), JsValue> {
        let tile = TileId::new(z, x, y)
            .ok_or_else(|| JsValue::from_str("invalid loaded raster tile id"))?;
        self.inner.mark_loaded(tile);
        Ok(())
    }

    #[wasm_bindgen(js_name = markFailed)]
    pub fn mark_failed(&mut self, z: u8, x: u32, y: u32) -> Result<(), JsValue> {
        let tile = TileId::new(z, x, y)
            .ok_or_else(|| JsValue::from_str("invalid failed raster tile id"))?;
        self.inner.mark_failed(tile);
        Ok(())
    }

    pub fn project(&self, longitude: f64, latitude: f64) -> Result<JsValue, JsValue> {
        let screen = self
            .inner
            .camera()
            .project_screen(longitude, latitude)
            .ok_or_else(|| JsValue::from_str("screen projection is unavailable"))?;
        encode_json_compatible(&[screen.x, screen.y])
    }

    pub fn unproject(&self, screen_x: f64, screen_y: f64) -> Result<JsValue, JsValue> {
        let coordinate = self
            .inner
            .unproject_screen(ScreenCoordinate {
                x: screen_x,
                y: screen_y,
            })
            .map_err(to_js_error)?;
        encode_json_compatible(&[coordinate.longitude, coordinate.latitude])
    }

    pub fn frame(&mut self) -> Result<JsValue, JsValue> {
        let plan = self.inner.frame_plan().map_err(to_js_error)?;
        let camera = self.inner.camera();
        encode_json_compatible(&wasm_frame_plan(camera, plan))
    }
}

fn wasm_frame_plan(camera: MapCamera, plan: RasterFramePlan) -> WasmRasterFramePlan {
    WasmRasterFramePlan {
        camera: WasmCameraState {
            center: [camera.longitude, camera.latitude],
            zoom: camera.zoom,
            bearing: camera.bearing,
            pitch: camera.pitch,
            width: camera.viewport.width,
            height: camera.viewport.height,
        },
        visible_bounds: WasmVisibleBounds {
            west: plan.visible_bounds.west,
            south: plan.visible_bounds.south,
            east: plan.visible_bounds.east,
            north: plan.visible_bounds.north,
            crosses_antimeridian: plan.visible_bounds.crosses_antimeridian,
            spans_full_world: plan.visible_bounds.spans_full_world,
        },
        placements: plan
            .placements
            .into_iter()
            .map(WasmRasterTilePlacement::from)
            .collect(),
        requests: plan.requests.into_iter().map(WasmTileId::from).collect(),
        cancellations: plan
            .cancellations
            .into_iter()
            .map(WasmTileId::from)
            .collect(),
        evictions: plan.evictions.into_iter().map(WasmTileId::from).collect(),
    }
}
