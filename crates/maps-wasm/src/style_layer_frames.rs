//! Tileset style layers without a GPU (#346): the Canvas2D fallback's source of the very
//! frames the wgpu backend draws. `StyleSymbols` lays out, places and writes the same circle
//! instances, glyph and icon vertices, fill, outline and line strip vertices and draw runs;
//! this module keeps them for the host together with each tile frame's matrix and surface
//! uniform, MapLibre's pattern cross-fade and the glyph, image and dash atlases. Only the
//! pixels differ: `src/canvas-style-layers.ts` runs the wgpu programs' vertex and fragment
//! math over these buffers.

use maps_core::symbol::{CrossfadeParameters, FADE_DURATION_MS, ImageStore, ZoomHistory};
use maps_core::{LINE_ATLAS_HEIGHT, LINE_ATLAS_WIDTH, LineAtlas, TileId, vector_tile_placements};
use wasm_bindgen::prelude::*;

use crate::retained_frame::{LocalFrame, local_frame_matrix};
use crate::style_symbols::{SourceZooms, StyleDraw, StyleFrame, StyleSurface, StyleSymbols};
use crate::wgpu_geometry::{SurfaceClip, WgpuRasterTilePlacement, unpack_tile_draws};

/// One packed draw run: kind, tile frame, first vertex or instance, count, flag.
pub(crate) const STYLE_DRAW_STRIDE: usize = 5;
pub(crate) const DRAW_CIRCLES: u32 = 0;
pub(crate) const DRAW_GLYPHS: u32 = 1;
/// Flag: sampled `LINEAR` (else `NEAREST`).
pub(crate) const DRAW_ICONS: u32 = 2;
/// Flag: MapLibre's `line_pattern` program (else the line program, dashed or solid).
pub(crate) const DRAW_LINES: u32 = 3;
pub(crate) const DRAW_FILLS: u32 = 4;
pub(crate) const DRAW_FILL_OUTLINES: u32 = 5;
/// One tile frame: the frame matrix (16, column-major), then the surface uniform
/// (physical width, physical height, pixel ratio, frame size in CSS px), then 1 when the
/// matrix is representable (else the frame draws nothing, as the wgpu path skips it).
pub(crate) const TILE_FRAME_FLOATS: usize = 21;
/// MapLibre's and the Map View's default maximum zoom.
pub(crate) const DEFAULT_MAP_MAX_ZOOM: f64 = 22.0;

/// The tile frames of the vector tiles that cover `placements`, as both backends draw them.
pub(crate) fn style_frame_tiles(
    placements: &[WgpuRasterTilePlacement],
    max_zoom: u8,
) -> Vec<(TileId, LocalFrame)> {
    let raster = placements.iter().filter_map(|placement| {
        let (z, x, y) = placement.key?;
        Some((
            TileId::new(z, x, y)?,
            placement.local_west,
            placement.local_north,
            placement.local_size,
        ))
    });
    vector_tile_placements(raster, max_zoom)
        .iter()
        .map(|placement| (placement.tile, LocalFrame::from(placement)))
        .collect()
}

/// The camera zoom from any placed tile: `z + log2(size / 512)`.
pub(crate) fn placement_zoom(placements: &[WgpuRasterTilePlacement]) -> Option<f64> {
    placements.iter().find_map(|placement| {
        let (z, _, _) = placement.key?;
        let zoom = f64::from(z) + (placement.local_size / 512.0).log2();
        zoom.is_finite().then_some(zoom)
    })
}

/// The render surface in CSS px of a `width` x `height` physical target.
pub(crate) fn style_surface(width: u32, height: u32, clip: SurfaceClip) -> StyleSurface {
    let pixel_ratio = clip.pixel_ratio.max(f64::MIN_POSITIVE);
    StyleSurface {
        width: f64::from(width) / pixel_ratio,
        height: f64::from(height) / pixel_ratio,
        margin: clip.margin,
        pixel_ratio,
    }
}

fn pack_draw(draw: &StyleDraw) -> [u32; STYLE_DRAW_STRIDE] {
    match *draw {
        StyleDraw::Circles { first, count } => [DRAW_CIRCLES, 0, first, count, 0],
        StyleDraw::Glyphs { first, count } => [DRAW_GLYPHS, 0, first, count, 0],
        StyleDraw::Icons {
            first,
            count,
            linear,
        } => [DRAW_ICONS, 0, first, count, u32::from(linear)],
        StyleDraw::Lines {
            frame,
            first,
            count,
            pattern,
        } => [DRAW_LINES, frame, first, count, u32::from(pattern)],
        StyleDraw::Fills {
            frame,
            first,
            count,
        } => [DRAW_FILLS, frame, first, count, 0],
        StyleDraw::FillOutlines {
            frame,
            first,
            count,
        } => [DRAW_FILL_OUTLINES, frame, first, count, 0],
    }
}

fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect()
}

fn js_error(context: &str, error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{context}: {error}"))
}

/// Tileset style layers for the Canvas2D fallback: the wgpu renderer's style-layer state
/// (layers, glyphs, sprite images, dash atlas, pattern zoom history) without its device.
#[wasm_bindgen]
pub struct MapsStyleLayerFrames {
    symbols: StyleSymbols,
    images: ImageStore,
    line_atlas: LineAtlas,
    zoom_history: ZoomHistory,
    source: String,
    max_zoom: u8,
    map_max_zoom: f64,
    cross_fading: bool,
    crossfade: CrossfadeParameters,
    draws: Vec<u32>,
    circles: Vec<f32>,
    glyphs: Vec<f32>,
    tile_frames: Vec<f32>,
    /// The visible tiles' strip, fill and outline vertices: `StyleFrame` hands them out
    /// only when they changed, the Canvas draws them every frame.
    lines: Vec<f32>,
    fills: Vec<f32>,
    outlines: Vec<f32>,
    placed_labels: u32,
    /// Errors of tiles laid out again past the source's maximum zoom since the last take.
    style_relayout: Option<Vec<String>>,
}

impl Default for MapsStyleLayerFrames {
    fn default() -> Self {
        Self {
            symbols: StyleSymbols::default(),
            images: ImageStore::default(),
            line_atlas: LineAtlas::new(),
            zoom_history: ZoomHistory::default(),
            source: String::new(),
            max_zoom: u8::MAX,
            map_max_zoom: DEFAULT_MAP_MAX_ZOOM,
            cross_fading: false,
            crossfade: CrossfadeParameters {
                from_scale: 1.0,
                to_scale: 1.0,
                t: 1.0,
            },
            draws: Vec::new(),
            circles: Vec::new(),
            glyphs: Vec::new(),
            tile_frames: Vec::new(),
            lines: Vec::new(),
            fills: Vec::new(),
            outlines: Vec::new(),
            placed_labels: 0,
            style_relayout: None,
        }
    }
}

impl MapsStyleLayerFrames {
    /// Lays out and places this frame's style layers, as the wgpu renderer's frame does.
    pub(crate) fn prepare(
        &mut self,
        placements: &[WgpuRasterTilePlacement],
        view_projection: [f32; 16],
        clip: SurfaceClip,
        (width, height): (u32, u32),
        now: f64,
    ) {
        let tiles = style_frame_tiles(placements, self.max_zoom);
        let frame = if self.symbols.is_active() {
            self.symbols.frame(
                &self.source,
                &tiles,
                SourceZooms::new(self.max_zoom, self.map_max_zoom),
                view_projection,
                style_surface(width, height, clip),
                &mut self.line_atlas,
                &mut self.images,
            )
        } else {
            StyleFrame::default()
        };
        self.store(frame, view_projection, clip, (width, height));
        // MapLibre's per-frame zoom history and pattern cross-fade.
        if let Some(zoom) = placement_zoom(placements) {
            self.zoom_history.update(zoom, now);
            self.crossfade = self.zoom_history.crossfade(zoom, now, FADE_DURATION_MS);
            self.cross_fading = !self.images.is_empty()
                && self.zoom_history.crossfading_factor(now, FADE_DURATION_MS) < 1.0;
        }
    }

    fn store(
        &mut self,
        mut frame: StyleFrame,
        view_projection: [f32; 16],
        clip: SurfaceClip,
        (width, height): (u32, u32),
    ) {
        self.draws = frame.draws.iter().flat_map(pack_draw).collect();
        self.circles = frame.circles;
        self.glyphs = frame.glyphs;
        self.placed_labels = frame.placed_labels;
        if let Some(errors) = frame.relayout.take() {
            self.style_relayout.get_or_insert_default().extend(errors);
        }
        if let Some(bytes) = frame.line_bytes {
            self.lines = floats(&bytes);
        }
        if let Some((fills, outlines)) = frame.fill_bytes {
            self.fills = floats(&fills);
            self.outlines = floats(&outlines);
        }
        self.tile_frames.clear();
        self.tile_frames
            .reserve(frame.tile_frames.len() * TILE_FRAME_FLOATS);
        for local in frame.tile_frames {
            let matrix = local_frame_matrix(view_projection, local);
            self.tile_frames
                .extend_from_slice(&matrix.unwrap_or([0.0; 16]));
            self.tile_frames.extend_from_slice(&[
                width as f32,
                height as f32,
                clip.pixel_ratio as f32,
                local.size as f32,
                if matrix.is_some() { 1.0 } else { 0.0 },
            ]);
        }
    }
}

#[wasm_bindgen]
impl MapsStyleLayerFrames {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MapsStyleLayerFrames {
        Self::default()
    }

    /// Replaces the tileset style layers (MapLibre style-spec JSON), as `setVectorLayers`
    /// of the wgpu renderer; unsupported properties are rejected.
    #[wasm_bindgen(js_name = setVectorLayers)]
    pub fn set_vector_layers(&mut self, layers: &str) -> Result<(), JsValue> {
        self.symbols
            .set_layers(layers, &mut self.images)
            .map_err(|error| js_error("invalid tileset style layers", error))
    }

    #[wasm_bindgen(js_name = addGlyphs)]
    pub fn add_glyphs(&mut self, stack: &str, start: u32, bytes: &[u8]) -> Result<(), JsValue> {
        self.symbols
            .add_glyphs(stack, start, bytes, &mut self.images)
            .map_err(|error| js_error("invalid glyph range", error))
    }

    #[wasm_bindgen(js_name = missingGlyphRanges)]
    pub fn missing_glyph_ranges(&self) -> Vec<String> {
        self.symbols.missing_glyph_ranges()
    }

    /// Adds a sprite: its JSON index and its sheet as straight-alpha RGBA pixels.
    #[wasm_bindgen(js_name = addSprite)]
    pub fn add_sprite(
        &mut self,
        json: &str,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<u32, JsValue> {
        let count = self
            .images
            .add_sprite(json, rgba, width, height)
            .map_err(|error| JsValue::from_str(&error))?;
        if self.symbols.uses_icons() {
            self.symbols
                .relayout(&mut self.images)
                .map_err(|error| js_error("could not lay out tileset style layers", error))?;
        }
        Ok(count as u32)
    }

    #[wasm_bindgen(js_name = setVectorSource)]
    pub fn set_vector_source(&mut self, source: String) {
        self.source = source;
    }

    #[wasm_bindgen(js_name = setVectorMaxZoom)]
    pub fn set_vector_max_zoom(&mut self, max_zoom: u8) {
        self.max_zoom = max_zoom;
    }

    /// The Map View's maximum zoom, as `setMapMaxZoom` of the wgpu renderer.
    #[wasm_bindgen(js_name = setMapMaxZoom)]
    pub fn set_map_max_zoom(&mut self, max_zoom: f64) {
        self.map_max_zoom = if max_zoom.is_finite() {
            max_zoom
        } else {
            DEFAULT_MAP_MAX_ZOOM
        };
    }

    #[wasm_bindgen(js_name = uploadVectorTile)]
    pub fn upload_vector_tile(
        &mut self,
        z: u8,
        x: u32,
        y: u32,
        bytes: &[u8],
    ) -> Result<(), JsValue> {
        if TileId::new(z, x, y).is_none() {
            return Err(JsValue::from_str("invalid vector tile identity"));
        }
        self.symbols
            .upload(&self.source, (z, x, y), bytes, &mut self.images)
            .map_err(|error| js_error("could not lay out tileset style layers", error))
    }

    #[wasm_bindgen(js_name = evictVectorTile)]
    pub fn evict_vector_tile(&mut self, z: u8, x: u32, y: u32) {
        self.symbols.evict(&self.source, (z, x, y));
    }

    #[wasm_bindgen(js_name = evictVectorSourceTile)]
    pub fn evict_vector_source_tile(&mut self, source: &str, z: u8, x: u32, y: u32) {
        self.symbols.evict(source, (z, x, y));
    }

    #[wasm_bindgen(js_name = isActive)]
    pub fn is_active(&self) -> bool {
        self.symbols.is_active()
    }

    /// Prepares one frame from the wgpu renderer's packed tile draws (`renderPacked`) for a
    /// `width` x `height` physical surface at host time `now` (ms).
    pub fn frame(
        &mut self,
        tile_draws: &[f64],
        width: u32,
        height: u32,
        now: f64,
    ) -> Result<(), JsValue> {
        let (view_projection, clip, _, placements) =
            unpack_tile_draws(tile_draws).map_err(JsValue::from_str)?;
        if view_projection.into_iter().any(|value| !value.is_finite()) {
            return Err(JsValue::from_str(
                "style layer camera contains non-finite matrix values",
            ));
        }
        let placements: Vec<WgpuRasterTilePlacement> = placements.collect();
        self.prepare(&placements, view_projection, clip, (width, height), now);
        Ok(())
    }

    /// Draw runs in painter order, [`STYLE_DRAW_STRIDE`] values each.
    pub fn draws(&self) -> Vec<u32> {
        self.draws.clone()
    }

    /// Circle instances (`application_circle.wgsl`).
    pub fn circles(&self) -> Vec<f32> {
        self.circles.clone()
    }

    /// Glyph and icon vertices (`symbol_sdf.wgsl`).
    pub fn glyphs(&self) -> Vec<f32> {
        self.glyphs.clone()
    }

    /// Line strip vertices (`retained_polygons.wgsl` kind 4, or `line_pattern.wgsl`).
    pub fn lines(&self) -> Vec<f32> {
        self.lines.clone()
    }

    /// Fill vertices (`fill_pattern.wgsl` `vs_fill`).
    pub fn fills(&self) -> Vec<f32> {
        self.fills.clone()
    }

    /// Fill outline vertices (`fill_pattern.wgsl` `vs_outline`).
    pub fn outlines(&self) -> Vec<f32> {
        self.outlines.clone()
    }

    /// [`TILE_FRAME_FLOATS`] per tile frame.
    #[wasm_bindgen(js_name = tileFrames)]
    pub fn tile_frames(&self) -> Vec<f32> {
        self.tile_frames.clone()
    }

    /// MapLibre's pattern cross-fade: (from scale, to scale, fade).
    pub fn crossfade(&self) -> Vec<f32> {
        vec![
            self.crossfade.from_scale as f32,
            self.crossfade.to_scale as f32,
            self.crossfade.t as f32,
        ]
    }

    /// Whether the last frame drew patterns mid cross-fade: the host renders again.
    #[wasm_bindgen(js_name = isCrossFading)]
    pub fn is_cross_fading(&self) -> bool {
        self.cross_fading
    }

    #[wasm_bindgen(js_name = placedLabels)]
    pub fn placed_labels(&self) -> u32 {
        self.placed_labels
    }

    /// As `takeStyleRelayout` of the wgpu renderer: `undefined` unless frames since the last
    /// call laid tiles out again past the source's maximum zoom, then the failed tiles' errors.
    #[wasm_bindgen(js_name = takeStyleRelayout)]
    pub fn take_style_relayout(&mut self) -> Option<Vec<String>> {
        self.style_relayout.take()
    }

    /// MapLibre's `queryRenderedFeatures` at a viewport point (CSS px) over the named circle
    /// and symbol style layers, against what the last frame drew, as the wgpu renderer's.
    #[wasm_bindgen(js_name = queryRenderedFeatures)]
    pub fn query_rendered_features(
        &self,
        x: f64,
        y: f64,
        layers: Vec<String>,
    ) -> Result<String, JsValue> {
        self.symbols
            .query_rendered_features([x, y], &layers)
            .map_err(|error| js_error("invalid rendered feature query", error))
    }

    /// The SDF glyph atlas: (revision, width, height); its R8 texels from `glyphAtlas`.
    #[wasm_bindgen(js_name = glyphAtlasInfo)]
    pub fn glyph_atlas_info(&mut self) -> Vec<f64> {
        let atlas = self.symbols.atlas();
        vec![
            atlas.revision as f64,
            f64::from(atlas.width),
            f64::from(atlas.height),
        ]
    }

    #[wasm_bindgen(js_name = glyphAtlas)]
    pub fn glyph_atlas(&mut self) -> Vec<u8> {
        self.symbols.atlas().image.clone()
    }

    /// The image atlas: (revision, width, height); its premultiplied RGBA from `imageAtlas`.
    #[wasm_bindgen(js_name = imageAtlasInfo)]
    pub fn image_atlas_info(&mut self) -> Vec<f64> {
        let atlas = self.images.atlas();
        vec![
            atlas.revision as f64,
            f64::from(atlas.width),
            f64::from(atlas.height),
        ]
    }

    #[wasm_bindgen(js_name = imageAtlas)]
    pub fn image_atlas(&mut self) -> Vec<u8> {
        self.images.atlas().image.clone()
    }

    /// The dash atlas: (version, width, height); its R8 texels from `dashAtlas`.
    #[wasm_bindgen(js_name = dashAtlasInfo)]
    pub fn dash_atlas_info(&self) -> Vec<f64> {
        vec![
            f64::from(self.line_atlas.version),
            f64::from(LINE_ATLAS_WIDTH),
            f64::from(LINE_ATLAS_HEIGHT),
        ]
    }

    #[wasm_bindgen(js_name = dashAtlas)]
    pub fn dash_atlas(&self) -> Vec<u8> {
        self.line_atlas.data.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut value: u64, out: &mut Vec<u8>) {
        while value >= 0x80 {
            out.push((value as u8) | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    }

    fn field(number: u64, payload: &[u8], out: &mut Vec<u8>) {
        varint(number << 3 | 2, out);
        varint(payload.len() as u64, out);
        out.extend_from_slice(payload);
    }

    /// One MVT layer `name` with one feature of `geometry_type` and zigzag `commands`.
    fn layer(name: &str, geometry_type: u64, commands: &[u64], out: &mut Vec<u8>) {
        let mut feature = Vec::new();
        varint(3 << 3, &mut feature);
        varint(geometry_type, &mut feature);
        let mut geometry = Vec::new();
        for value in commands {
            varint(*value, &mut geometry);
        }
        field(4, &geometry, &mut feature);
        let mut layer = Vec::new();
        field(1, name.as_bytes(), &mut layer);
        field(2, &feature, &mut layer);
        varint(15 << 3, &mut layer);
        varint(2, &mut layer);
        field(3, &layer, out);
    }

    /// A point at the tile centre, a line across it and a square around its centre.
    fn tile() -> Vec<u8> {
        let mut tile = Vec::new();
        layer("places", 1, &[9, 4096, 4096], &mut tile);
        layer("streets", 2, &[9, 2048, 4096, 10, 4096, 0], &mut tile);
        // MoveTo (1024, 1024), LineTo +2048,0 / 0,+2048 / -2048,0, ClosePath.
        layer(
            "water",
            3,
            &[9, 2048, 2048, 26, 4096, 0, 0, 4096, 4095, 0, 15],
            &mut tile,
        );
        tile
    }

    const LAYERS: &str = r##"[
        {"id":"water","type":"fill","source":"v","source-layer":"water",
         "paint":{"fill-color":"#0000ff","fill-outline-color":"#000000"}},
        {"id":"streets","type":"line","source":"v","source-layer":"streets",
         "paint":{"line-color":"#ff0000","line-width":4,"line-dasharray":[2,1]}},
        {"id":"places","type":"circle","source":"v","source-layer":"places",
         "paint":{"circle-radius":6,"circle-color":"#00ff00"}}
    ]"##;

    /// The wgpu renderer's packed tile draws for one 512 px tile centred in a 720 x 480
    /// CSS px surface: an orthographic camera, no margin, pixel ratio 1.
    fn tile_draws() -> Vec<f64> {
        let mut packed = vec![0.0; 22];
        packed[0] = 2.0 / 720.0;
        packed[5] = 2.0 / 480.0;
        packed[10] = 1.0;
        packed[15] = 1.0;
        packed[19] = 1.0;
        packed.extend_from_slice(&[7.0, 66.0, 45.0, -256.0, 256.0, 512.0, 1.0]);
        packed
    }

    fn frames() -> MapsStyleLayerFrames {
        let mut frames = MapsStyleLayerFrames::new();
        frames.set_vector_source("s".to_owned());
        frames.set_vector_layers(LAYERS).unwrap();
        frames.upload_vector_tile(7, 66, 45, &tile()).unwrap();
        frames
    }

    #[test]
    fn canvas_frames_are_the_frames_the_wgpu_renderer_draws() {
        let mut frames = frames();
        frames.frame(&tile_draws(), 720, 480, 0.0).unwrap();

        // The wgpu renderer's own preparation over the same input.
        let mut images = ImageStore::default();
        let mut symbols = StyleSymbols::default();
        symbols.set_layers(LAYERS, &mut images).unwrap();
        symbols
            .upload("s", (7, 66, 45), &tile(), &mut images)
            .unwrap();
        let packed = tile_draws();
        let (view_projection, clip, _, placements) = unpack_tile_draws(&packed).unwrap();
        let placements: Vec<_> = placements.collect();
        let expected = symbols.frame(
            "s",
            &style_frame_tiles(&placements, u8::MAX),
            SourceZooms::new(u8::MAX, DEFAULT_MAP_MAX_ZOOM),
            view_projection,
            style_surface(720, 480, clip),
            &mut LineAtlas::new(),
            &mut images,
        );

        let draws: Vec<u32> = expected.draws.iter().flat_map(pack_draw).collect();
        assert_eq!(frames.draws(), draws);
        let kinds: Vec<u32> = draws
            .chunks(STYLE_DRAW_STRIDE)
            .map(|draw| draw[0])
            .collect();
        assert_eq!(
            kinds,
            [DRAW_FILL_OUTLINES, DRAW_FILLS, DRAW_LINES, DRAW_CIRCLES],
            "an opaque fill draws its outline first, then the line and circle layers"
        );
        assert_eq!(frames.circles(), expected.circles);
        let (lines, fills) = (expected.line_bytes.unwrap(), expected.fill_bytes.unwrap());
        assert_eq!(frames.lines(), floats(&lines));
        assert_eq!(frames.fills(), floats(&fills.0));
        assert_eq!(frames.outlines(), floats(&fills.1));
        assert!(!frames.lines().is_empty() && !frames.fills().is_empty());
    }

    #[test]
    fn strips_and_fills_stay_available_on_frames_that_do_not_rebuild_them() {
        let mut frames = frames();
        frames.frame(&tile_draws(), 720, 480, 0.0).unwrap();
        let (lines, fills, outlines) = (frames.lines(), frames.fills(), frames.outlines());
        // The wgpu buffers keep last frame's bytes; the Canvas draws them again.
        frames.frame(&tile_draws(), 720, 480, 16.0).unwrap();
        assert_eq!(frames.lines(), lines);
        assert_eq!(frames.fills(), fills);
        assert_eq!(frames.outlines(), outlines);
    }

    #[test]
    fn tile_frames_carry_the_frame_uniform_of_the_wgpu_programs() {
        let mut frames = frames();
        frames.frame(&tile_draws(), 1440, 960, 0.0).unwrap();
        let tile_frames = frames.tile_frames();
        assert_eq!(tile_frames.len(), TILE_FRAME_FLOATS);
        let (view_projection, _, _, _) = unpack_tile_draws(&tile_draws()).unwrap();
        let matrix = local_frame_matrix(
            view_projection,
            LocalFrame {
                west: -256.0,
                north: 256.0,
                size: 512.0,
            },
        )
        .unwrap();
        assert_eq!(tile_frames[..16], matrix);
        // Physical surface, pixel ratio, CSS px per frame unit, representable.
        assert_eq!(tile_frames[16..], [1440.0, 960.0, 1.0, 512.0, 1.0]);
        // Dashes were packed into the dash atlas the strips sample.
        assert!(frames.dash_atlas_info()[0] > 0.0);
        assert_eq!(
            frames.dash_atlas().len(),
            (LINE_ATLAS_WIDTH * LINE_ATLAS_HEIGHT) as usize
        );
    }

    #[test]
    fn without_style_layers_a_frame_draws_nothing() {
        let mut frames = MapsStyleLayerFrames::new();
        assert!(!frames.is_active());
        frames.frame(&tile_draws(), 720, 480, 0.0).unwrap();
        assert!(frames.draws().is_empty());
        assert!(frames.tile_frames().is_empty());
    }
}
