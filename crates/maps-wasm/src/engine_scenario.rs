use maps_core::{
    BoundedFlatRasterRuntime as CoreBoundedFlatRasterRuntime, EngineImplementationIdentity,
    FlatRasterRuntime as CoreFlatRasterRuntime, FlatRasterRuntimeLimits,
    MapBounds as CoreMapBounds, MapCamera, RasterFramePlan, RasterSourceSpec, ScreenCoordinate,
    TileId, ViewportSize, execute_engine_scenario,
};
use serde::Deserialize;
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
    #[serde(default)]
    bearing: f64,
    #[serde(default)]
    pitch: f64,
    width: f64,
    height: f64,
    source: WasmRasterSourceSpec,
    #[serde(default)]
    limits: Option<WasmFlatRasterRuntimeLimits>,
    #[serde(default)]
    max_bounds: Option<[f64; 4]>,
    /// Presentation-only render-surface margin (CSS px per side).
    #[serde(default)]
    render_margin: f64,
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

/// Packed flat-raster frame transport shared with `src/flat-runtime-wasm.ts`.
///
/// One `Float64Array` per frame replaces per-field object serialization across
/// the WASM boundary. Layout (all values `f64`):
///
/// - header, [`PACKED_FRAME_HEADER_LENGTH`] values: camera longitude, latitude,
///   zoom, bearing, pitch, width, height; 16 view-projection elements; visible
///   bounds west, south, east, north, crosses-antimeridian (0/1), spans-full-world
///   (0/1); placement, request, cancellation and eviction counts; surface margin;
///   overscan (0/1);
/// - placements, [`PACKED_PLACEMENT_STRIDE`] values each: z, x, y, world copy,
///   local west, local north, local size, screen x, screen y, screen width,
///   screen height, visible (0/1);
/// - requests, cancellations and evictions, [`PACKED_TILE_STRIDE`] values each: z, x, y.
pub const PACKED_FRAME_HEADER_LENGTH: usize = 35;
pub const PACKED_PLACEMENT_STRIDE: usize = 12;
pub const PACKED_TILE_STRIDE: usize = 3;

fn pack_frame_plan(camera: MapCamera, plan: &RasterFramePlan) -> Vec<f64> {
    let tile_count = plan.requests.len() + plan.cancellations.len() + plan.evictions.len();
    let mut packed = Vec::with_capacity(
        PACKED_FRAME_HEADER_LENGTH
            + plan.placements.len() * PACKED_PLACEMENT_STRIDE
            + tile_count * PACKED_TILE_STRIDE,
    );
    packed.extend_from_slice(&[
        camera.longitude,
        camera.latitude,
        camera.zoom,
        camera.bearing,
        camera.pitch,
        camera.viewport.width,
        camera.viewport.height,
    ]);
    packed.extend(
        plan.render_camera
            .view_projection
            .iter()
            .map(|&value| f64::from(value)),
    );
    let bounds = plan.visible_bounds;
    packed.extend_from_slice(&[
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north,
        f64::from(u8::from(bounds.crosses_antimeridian)),
        f64::from(u8::from(bounds.spans_full_world)),
        plan.placements.len() as f64,
        plan.requests.len() as f64,
        plan.cancellations.len() as f64,
        plan.evictions.len() as f64,
        plan.surface_margin,
        f64::from(u8::from(plan.overscan)),
    ]);
    for placement in &plan.placements {
        packed.extend_from_slice(&[
            f64::from(placement.tile.z),
            f64::from(placement.tile.x),
            f64::from(placement.tile.y),
            f64::from(placement.world_copy),
            placement.local_west,
            placement.local_north,
            placement.local_size,
            placement.screen_x,
            placement.screen_y,
            placement.screen_width,
            placement.screen_height,
            f64::from(u8::from(placement.visible)),
        ]);
    }
    for tile in plan
        .requests
        .iter()
        .chain(&plan.cancellations)
        .chain(&plan.evictions)
    {
        packed.extend_from_slice(&[f64::from(tile.z), f64::from(tile.x), f64::from(tile.y)]);
    }
    packed
}

/// Stateful WASM transport over the Maps-owned flat raster runtime.
///
/// The browser host supplies input/network/pixel services. Camera, geographic
/// constraints, tile cover, request scheduling, cancellation and cache policy
/// remain Rust-owned.
#[wasm_bindgen]
pub struct MapsFlatRasterRuntime {
    inner: CoreBoundedFlatRasterRuntime,
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
            config.bearing,
            config.pitch,
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
        let runtime = CoreFlatRasterRuntime::new(camera, source, limits).map_err(to_js_error)?;
        let max_bounds = config.max_bounds.map(normalize_max_bounds).transpose()?;
        let mut inner =
            CoreBoundedFlatRasterRuntime::new(runtime, max_bounds).map_err(to_js_error)?;
        inner
            .set_render_margin(config.render_margin)
            .map_err(to_js_error)?;

        Ok(Self { inner })
    }

    #[wasm_bindgen(js_name = setViewState)]
    pub fn set_view_state(
        &mut self,
        longitude: f64,
        latitude: f64,
        zoom: f64,
        bearing: f64,
        pitch: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .set_camera_state(longitude, latitude, zoom, bearing, pitch)
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

    #[wasm_bindgen(js_name = panBetween)]
    pub fn pan_between(
        &mut self,
        previous_x: f64,
        previous_y: f64,
        current_x: f64,
        current_y: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .pan_between_screen_points(
                ScreenCoordinate {
                    x: previous_x,
                    y: previous_y,
                },
                ScreenCoordinate {
                    x: current_x,
                    y: current_y,
                },
            )
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

    #[wasm_bindgen(js_name = rotateAbout)]
    pub fn rotate_about(
        &mut self,
        delta_bearing: f64,
        screen_x: f64,
        screen_y: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .rotate_about(
                delta_bearing,
                ScreenCoordinate {
                    x: screen_x,
                    y: screen_y,
                },
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
            .project_screen(longitude, latitude)
            .map_err(to_js_error)?;
        encode_json_compatible(&[screen.x, screen.y])
    }

    #[wasm_bindgen(js_name = projectPacked)]
    pub fn project_packed(&self, coordinates: &[f64]) -> Result<Vec<f64>, JsValue> {
        let (coordinate_pairs, remainder) = coordinates.as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(JsValue::from_str(
                "packed projection coordinates must contain longitude/latitude pairs",
            ));
        }

        let mut projected = Vec::with_capacity(coordinates.len());
        for coordinate in coordinate_pairs {
            match self.inner.project_screen(coordinate[0], coordinate[1]) {
                Ok(screen) => {
                    projected.push(screen.x);
                    projected.push(screen.y);
                }
                Err(_) => {
                    // Preserve scalar-project fail-closed behavior per coordinate
                    // without turning one invalid point into a failed whole batch.
                    projected.push(f64::NAN);
                    projected.push(f64::NAN);
                }
            }
        }
        Ok(projected)
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

    /// Advances scheduling and returns the packed frame (see [`pack_frame_plan`]).
    #[wasm_bindgen(js_name = framePacked)]
    pub fn frame_packed(&mut self) -> Result<Vec<f64>, JsValue> {
        let plan = self.inner.frame_plan().map_err(to_js_error)?;
        Ok(pack_frame_plan(self.inner.camera(), &plan))
    }
}

fn normalize_max_bounds(values: [f64; 4]) -> Result<CoreMapBounds, JsValue> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(JsValue::from_str("invalid flat raster max bounds"));
    }

    let west = values[0].min(values[2]);
    let east = values[0].max(values[2]);
    let south = values[1].min(values[3]).clamp(-90.0, 90.0);
    let north = values[1].max(values[3]).clamp(-90.0, 90.0);

    CoreMapBounds::new([west, south, east, north])
        .ok_or_else(|| JsValue::from_str("invalid flat raster max bounds"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_frame_carries_the_authoritative_plan_without_loss() {
        let viewport = ViewportSize::new(800.0, 600.0).unwrap();
        let camera = MapCamera::new(179.9, 52.5, 3.25, 30.0, 0.0, viewport).unwrap();
        let mut runtime = CoreFlatRasterRuntime::new(
            camera,
            RasterSourceSpec::new(0, 19, 256).unwrap(),
            FlatRasterRuntimeLimits::default(),
        )
        .unwrap();
        runtime.set_render_margin(96.0).unwrap();
        let plan = runtime.frame_plan().unwrap();
        assert!(plan.overscan);
        assert!(plan.placements.iter().any(|placement| !placement.visible));
        assert!(!plan.placements.is_empty());
        assert!(!plan.requests.is_empty());
        let packed = pack_frame_plan(runtime.camera(), &plan);

        assert_eq!(&packed[..7], &[179.9, 52.5, 3.25, 30.0, 0.0, 800.0, 600.0]);
        for (index, value) in plan.render_camera.view_projection.iter().enumerate() {
            assert_eq!(packed[7 + index] as f32, *value);
        }
        let bounds = plan.visible_bounds;
        assert_eq!(
            &packed[23..29],
            &[
                bounds.west,
                bounds.south,
                bounds.east,
                bounds.north,
                f64::from(u8::from(bounds.crosses_antimeridian)),
                f64::from(u8::from(bounds.spans_full_world)),
            ]
        );
        let counts = [
            plan.placements.len(),
            plan.requests.len(),
            plan.cancellations.len(),
            plan.evictions.len(),
        ];
        assert_eq!(&packed[29..33], &counts.map(|count| count as f64));
        assert_eq!(&packed[33..35], &[96.0, 1.0]);
        let tiles_start = PACKED_FRAME_HEADER_LENGTH + counts[0] * PACKED_PLACEMENT_STRIDE;
        assert_eq!(
            packed.len(),
            tiles_start + (counts[1] + counts[2] + counts[3]) * PACKED_TILE_STRIDE
        );
        for (index, placement) in plan.placements.iter().enumerate() {
            let offset = PACKED_FRAME_HEADER_LENGTH + index * PACKED_PLACEMENT_STRIDE;
            assert_eq!(
                &packed[offset..offset + PACKED_PLACEMENT_STRIDE],
                &[
                    f64::from(placement.tile.z),
                    f64::from(placement.tile.x),
                    f64::from(placement.tile.y),
                    f64::from(placement.world_copy),
                    placement.local_west,
                    placement.local_north,
                    placement.local_size,
                    placement.screen_x,
                    placement.screen_y,
                    placement.screen_width,
                    placement.screen_height,
                    f64::from(u8::from(placement.visible)),
                ]
            );
        }
        for (index, tile) in plan.requests.iter().enumerate() {
            let offset = tiles_start + index * PACKED_TILE_STRIDE;
            assert_eq!(
                &packed[offset..offset + PACKED_TILE_STRIDE],
                &[f64::from(tile.z), f64::from(tile.x), f64::from(tile.y)]
            );
        }
    }
}
