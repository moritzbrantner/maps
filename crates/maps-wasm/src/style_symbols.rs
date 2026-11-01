//! Per-frame geometry of tileset style layers (#321, #322): `maps_core::symbol` lays out lines
//! and places labels; this module keeps each tile's buckets, projects anchors through the
//! frame camera and writes circle instances and SDF glyph vertices for the wgpu backend. Line
//! strips stay in tile space, drawn per tile with the retained line shader; their bytes are
//! rebuilt only when the tile zoom changes their dash scale.

use std::collections::{BTreeSet, HashMap};

use maps_core::symbol::{
    GlyphStore, LayerBucket, PlacementTile, StyleLayer, TileStyleBuckets, layout_tile,
    parse_glyph_pbf, place_symbols, symbol_tile_order,
};
use maps_core::{LINE_ATLAS_HEIGHT, LineAtlas, MvtLayer, TileId, decode_mvt_layers};

use crate::retained_frame::LocalFrame;
use crate::retained_polygons::{
    NO_DASH, RETAINED_POLYGON_STROKE_VERTEX_SIZE, push_line_strip_vertex,
};

/// Glyph vertex: clip position, atlas uv, (size, opacity, halo width, halo blur),
/// (fill?, halo?, device pixel ratio, 0), premultiplied fill and halo colors.
pub(crate) const GLYPH_VERTEX_FLOATS: usize = 20;
pub(crate) const GLYPH_VERTEX_SIZE: u64 = GLYPH_VERTEX_FLOATS as u64 * 4;
/// Same layout as the application circle instances (`application_circle.wgsl`).
pub(crate) const CIRCLE_INSTANCE_FLOATS: usize = 14;

type TileKey = (u8, u32, u32);
/// Tile-normalized point to (viewport CSS px, perspective ratio).
type Projector<'a> = Box<dyn Fn([f64; 2]) -> Option<([f64; 2], f64)> + 'a>;

struct StyleTile {
    z: u8,
    source: Vec<MvtLayer>,
    buckets: TileStyleBuckets,
    /// Line strip bytes for one tile zoom, with each line layer's vertex range.
    lines: Option<StyleTileLines>,
}

struct StyleTileLines {
    tile_zoom: u8,
    generation: u64,
    bytes: Vec<u8>,
    /// (layer index, first vertex, vertex count).
    ranges: Vec<(usize, u32, u32)>,
}

/// Draw runs in painter order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StyleDraw {
    Circles {
        first: u32,
        count: u32,
    },
    Glyphs {
        first: u32,
        count: u32,
    },
    /// Line strip vertices of one tile, drawn in the frame of `line_frames[frame]`.
    Lines {
        frame: u32,
        first: u32,
        count: u32,
    },
}

/// Where the frame draws: the render surface (viewport plus `margin` on every side).
#[derive(Clone, Copy, Debug)]
pub(crate) struct StyleSurface {
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) margin: f64,
    pub(crate) pixel_ratio: f64,
}

#[derive(Default)]
pub(crate) struct StyleFrame {
    pub(crate) circles: Vec<f32>,
    pub(crate) glyphs: Vec<f32>,
    /// Tile frames of the line draws.
    pub(crate) line_frames: Vec<LocalFrame>,
    /// All line strip bytes of this frame; `None` when unchanged since the last frame.
    pub(crate) line_bytes: Option<Vec<u8>>,
    /// Dynamic uniform offset of each line frame, written by the renderer.
    #[cfg_attr(
        not(all(
            target_arch = "wasm32",
            target_os = "unknown",
            feature = "wgpu-base-map"
        )),
        allow(dead_code)
    )]
    pub(crate) line_offsets: Vec<Option<u32>>,
    pub(crate) draws: Vec<StyleDraw>,
    pub(crate) placed_labels: u32,
}

#[derive(Default)]
pub(crate) struct StyleSymbols {
    layers: Vec<StyleLayer>,
    glyphs: GlyphStore,
    tiles: HashMap<(String, TileKey), StyleTile>,
    /// Tiles and builds of the line bytes uploaded last.
    line_signature: Vec<(TileKey, u64)>,
    line_generation: u64,
}

impl StyleSymbols {
    pub(crate) fn is_active(&self) -> bool {
        !self.layers.is_empty()
    }

    /// Replaces the style layers (a JSON array of MapLibre circle/symbol layers) and lays
    /// every retained tile out again.
    pub(crate) fn set_layers(&mut self, json: &str) -> Result<(), String> {
        self.layers = StyleLayer::parse_all(json)?;
        self.relayout()
    }

    pub(crate) fn add_glyphs(
        &mut self,
        stack: &str,
        start: u32,
        bytes: &[u8],
    ) -> Result<(), String> {
        let glyphs = parse_glyph_pbf(bytes).map_err(|error| error.to_string())?;
        self.glyphs.add_range(stack, start, glyphs);
        self.relayout()
    }

    /// Glyph ranges retained tiles need and nobody added yet, as `"<start>:<font stack>"`.
    pub(crate) fn missing_glyph_ranges(&self) -> Vec<String> {
        let missing: BTreeSet<&(String, u32)> = self
            .tiles
            .values()
            .flat_map(|tile| &tile.buckets.missing_glyph_ranges)
            .filter(|(stack, start)| !self.glyphs.has_range(stack, *start))
            .collect();
        missing
            .into_iter()
            .map(|(stack, start)| format!("{start}:{stack}"))
            .collect()
    }

    pub(crate) fn upload(
        &mut self,
        source: &str,
        key: TileKey,
        bytes: &[u8],
    ) -> Result<(), String> {
        if !self.is_active() {
            return Ok(());
        }
        let wanted: BTreeSet<&str> = self
            .layers
            .iter()
            .map(|layer| layer.source_layer.as_str())
            .collect();
        let decoded = decode_mvt_layers(bytes, |name| wanted.contains(name))
            .map_err(|error| error.to_string())?;
        let buckets = layout_tile(&self.layers, &decoded, key.0, &self.glyphs)?;
        self.tiles.insert(
            (source.to_owned(), key),
            StyleTile {
                z: key.0,
                source: decoded,
                buckets,
                lines: None,
            },
        );
        Ok(())
    }

    pub(crate) fn evict(&mut self, source: &str, key: TileKey) {
        self.tiles.remove(&(source.to_owned(), key));
    }

    fn relayout(&mut self) -> Result<(), String> {
        for tile in self.tiles.values_mut() {
            tile.buckets = layout_tile(&self.layers, &tile.source, tile.z, &self.glyphs)?;
            tile.lines = None;
        }
        Ok(())
    }

    pub(crate) fn atlas(&mut self) -> &maps_core::symbol::GlyphAtlas {
        self.glyphs.atlas()
    }

    /// Places labels and writes this frame's circle instances and glyph vertices.
    pub(crate) fn frame(
        &mut self,
        source: &str,
        placements: &[(TileId, LocalFrame)],
        view_projection: [f32; 16],
        surface: StyleSurface,
        line_atlas: &mut LineAtlas,
    ) -> StyleFrame {
        let mut frame = StyleFrame::default();
        if !self.is_active() || placements.is_empty() {
            return frame;
        }
        let vp: [f64; 16] = std::array::from_fn(|index| f64::from(view_projection[index]));
        let clip = |x: f64, y: f64| {
            [
                vp[0] * x + vp[4] * y + vp[12],
                vp[1] * x + vp[5] * y + vp[13],
                vp[3] * x + vp[7] * y + vp[15],
            ]
        };
        let center_depth = clip(0.0, 0.0)[2];
        let viewport = (
            surface.width - 2.0 * surface.margin,
            surface.height - 2.0 * surface.margin,
        );
        // Viewport CSS px and depth of a local map-plane point.
        let to_viewport = |x: f64, y: f64| -> Option<([f64; 2], f64)> {
            let [cx, cy, w] = clip(x, y);
            if w.is_nan() || w <= 0.0 {
                return None;
            }
            Some((
                [
                    (cx / w + 1.0) / 2.0 * surface.width - surface.margin,
                    (1.0 - cy / w) / 2.0 * surface.height - surface.margin,
                ],
                w,
            ))
        };
        // Camera zoom and bearing, read off the frame of the first tile.
        let (first_tile, first_frame) = placements[0];
        let zoom = f64::from(first_tile.z) + (first_frame.size / 512.0).log2();
        // MapLibre's `transform.tileZoom`: dashes keep their px length at the floored zoom.
        let tile_zoom = (zoom + 1.0e-9).floor().clamp(0.0, f64::from(u8::MAX)) as u8;
        if self
            .layers
            .iter()
            .any(|layer| layer.kind == maps_core::symbol::StyleLayerKind::Line)
        {
            for (tile, _) in placements {
                if let Some(style_tile) = self
                    .tiles
                    .get_mut(&(source.to_owned(), (tile.z, tile.x, tile.y)))
                    && style_tile.lines.as_ref().map(|lines| lines.tile_zoom) != Some(tile_zoom)
                {
                    self.line_generation += 1;
                    style_tile.lines = Some(build_tile_lines(
                        &style_tile.buckets,
                        tile.z,
                        tile_zoom,
                        self.line_generation,
                        line_atlas,
                    ));
                }
            }
        }
        let bearing = match (to_viewport(0.0, 0.0), to_viewport(1.0, 0.0)) {
            (Some((a, _)), Some((b, _))) => (b[1] - a[1]).atan2(b[0] - a[0]),
            _ => 0.0,
        };

        // Tiles intersecting the viewport, as MapLibre's covering tiles.
        let mut visible: Vec<(TileId, LocalFrame, &StyleTile)> = Vec::new();
        for (tile, local) in placements {
            let Some(style_tile) = self
                .tiles
                .get(&(source.to_owned(), (tile.z, tile.x, tile.y)))
            else {
                continue;
            };
            let corners = [
                (local.west, local.north),
                (local.west + local.size, local.north),
                (local.west, local.north - local.size),
                (local.west + local.size, local.north - local.size),
            ];
            let projected: Vec<[f64; 2]> = corners
                .iter()
                .filter_map(|(x, y)| to_viewport(*x, *y).map(|(point, _)| point))
                .collect();
            if projected.is_empty() {
                continue;
            }
            let min_x = projected.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
            let max_x = projected
                .iter()
                .map(|p| p[0])
                .fold(f64::NEG_INFINITY, f64::max);
            let min_y = projected.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
            let max_y = projected
                .iter()
                .map(|p| p[1])
                .fold(f64::NEG_INFINITY, f64::max);
            if max_x <= 0.0 || min_x >= viewport.0 || max_y <= 0.0 || min_y >= viewport.1 {
                continue;
            }
            visible.push((*tile, *local, style_tile));
        }
        // Line bytes of the visible tiles, uploaded again only when they changed.
        let mut line_bases: Vec<Option<(u32, u32)>> = vec![None; visible.len()];
        let mut line_bytes = Vec::new();
        let mut signature = Vec::new();
        for (index, (tile, local, style_tile)) in visible.iter().enumerate() {
            let Some(lines) = style_tile
                .lines
                .as_ref()
                .filter(|lines| !lines.bytes.is_empty())
            else {
                continue;
            };
            let base = (line_bytes.len() as u64 / RETAINED_POLYGON_STROKE_VERTEX_SIZE) as u32;
            line_bytes.extend_from_slice(&lines.bytes);
            signature.push(((tile.z, tile.x, tile.y), lines.generation));
            line_bases[index] = Some((frame.line_frames.len() as u32, base));
            frame.line_frames.push(*local);
        }
        if signature != self.line_signature {
            frame.line_bytes = Some(line_bytes);
            self.line_signature = signature;
        }
        let tile_ids: Vec<TileId> = visible.iter().map(|(tile, _, _)| *tile).collect();
        let order = symbol_tile_order(&tile_ids, bearing);
        let projectors: Vec<Projector<'_>> = order
            .iter()
            .map(|index| {
                let local = visible[*index].1;
                Box::new(move |uv: [f64; 2]| {
                    let (point, w) = to_viewport(
                        local.west + uv[0] * local.size,
                        local.north - uv[1] * local.size,
                    )?;
                    Some((point, 0.5 + 0.5 * center_depth / w))
                }) as Projector<'_>
            })
            .collect();
        let placement_tiles: Vec<PlacementTile<'_>> = order
            .iter()
            .zip(&projectors)
            .map(|(index, project)| PlacementTile {
                tile: visible[*index].0,
                buckets: &visible[*index].2.buckets,
                project: project.as_ref(),
            })
            .collect();
        let placed = place_symbols(&placement_tiles, self.layers.len(), viewport.0, viewport.1);

        let to_clip = |viewport_point: [f64; 2]| -> [f32; 2] {
            [
                ((viewport_point[0] + surface.margin) / surface.width * 2.0 - 1.0) as f32,
                (1.0 - (viewport_point[1] + surface.margin) / surface.height * 2.0) as f32,
            ]
        };
        let atlas = self.glyphs.atlas();
        let (atlas_width, atlas_height) = (f64::from(atlas.width), f64::from(atlas.height));
        for (layer_index, layer) in self.layers.iter().enumerate() {
            if !layer.visible || zoom < layer.min_zoom || zoom >= layer.max_zoom {
                continue;
            }
            match layer.kind {
                maps_core::symbol::StyleLayerKind::Line => {
                    for (index, (_, _, style_tile)) in visible.iter().enumerate() {
                        let (Some((line_frame, base)), Some(lines)) =
                            (line_bases[index], &style_tile.lines)
                        else {
                            continue;
                        };
                        for &(layer, first, count) in &lines.ranges {
                            if layer == layer_index && count > 0 {
                                frame.draws.push(StyleDraw::Lines {
                                    frame: line_frame,
                                    first: base + first,
                                    count,
                                });
                            }
                        }
                    }
                }
                maps_core::symbol::StyleLayerKind::Circle => {
                    let first = (frame.circles.len() / CIRCLE_INSTANCE_FLOATS) as u32;
                    // MapLibre draws circle layers over tiles in descending tile order.
                    for tile in placement_tiles.iter().rev() {
                        let Some(LayerBucket::Circles(circles)) =
                            tile.buckets.layers.get(layer_index)
                        else {
                            continue;
                        };
                        for circle in circles {
                            let Some((point, ratio)) = (tile.project)(circle.anchor) else {
                                continue;
                            };
                            let depth_scale = 2.0 * ratio - 1.0;
                            let outer = f64::from(circle.radius + circle.stroke_width);
                            if outer <= 0.0 {
                                continue;
                            }
                            let center = to_clip(point);
                            let fill_ratio = if circle.stroke_width >= 0.01 {
                                circle.radius / (circle.radius + circle.stroke_width)
                            } else {
                                2.0
                            };
                            let blur = (1.0 / (surface.pixel_ratio * outer))
                                .max(f64::from(circle.blur))
                                as f32;
                            frame.circles.extend_from_slice(&[
                                center[0],
                                center[1],
                                (outer * depth_scale / surface.width * 2.0) as f32,
                                (outer * depth_scale / surface.height * 2.0) as f32,
                                fill_ratio,
                                blur,
                            ]);
                            frame.circles.extend_from_slice(&circle.fill);
                            frame.circles.extend_from_slice(&circle.stroke);
                        }
                    }
                    let count = (frame.circles.len() / CIRCLE_INSTANCE_FLOATS) as u32 - first;
                    if count > 0 {
                        frame.draws.push(StyleDraw::Circles { first, count });
                    }
                }
                maps_core::symbol::StyleLayerKind::Symbol => {
                    let first = (frame.glyphs.len() / GLYPH_VERTEX_FLOATS) as u32;
                    let symbols = &placed[layer_index];
                    // Halo width over 1 px overlaps neighbouring glyphs: MapLibre then draws
                    // a tile's halos before its fills instead of one combined pass.
                    // Labels draw per tile in MapLibre's descending symbol tile order.
                    for tile_index in (0..placement_tiles.len()).rev() {
                        let Some(LayerBucket::Symbols { instances, .. }) =
                            placement_tiles[tile_index].buckets.layers.get(layer_index)
                        else {
                            continue;
                        };
                        let tile_symbols: Vec<_> = symbols
                            .iter()
                            .filter(|symbol| symbol.tile == tile_index)
                            .collect();
                        if tile_symbols.is_empty() {
                            continue;
                        }
                        let two_pass = tile_symbols
                            .iter()
                            .any(|symbol| instances[symbol.instance].paint.halo_width > 1.0);
                        let passes: &[[f32; 2]] = if two_pass {
                            &[[0.0, 1.0], [1.0, 0.0]]
                        } else {
                            &[[1.0, 1.0]]
                        };
                        for mode in passes {
                            for symbol in &tile_symbols {
                                let instance = &instances[symbol.instance];
                                let has_halo = instance.paint.halo_width != 0.0;
                                if !has_halo && mode[0] == 0.0 {
                                    continue;
                                }
                                let mode = if has_halo { *mode } else { [1.0, 0.0] };
                                let size = f64::from(instance.size)
                                    * symbol.perspective_ratio.clamp(0.0, 4.0);
                                let font_scale = size / 24.0;
                                for glyph in &instance.glyphs {
                                    let Some(rect) = atlas.rect(&instance.stack, glyph.codepoint)
                                    else {
                                        continue;
                                    };
                                    let corner = |offset: [f32; 2]| {
                                        to_clip([
                                            symbol.anchor[0] + f64::from(offset[0]) * font_scale,
                                            symbol.anchor[1] + f64::from(offset[1]) * font_scale,
                                        ])
                                    };
                                    let (tl, br) = (corner(glyph.tl), corner(glyph.br));
                                    let u0 = (f64::from(rect.x) / atlas_width) as f32;
                                    let v0 = (f64::from(rect.y) / atlas_height) as f32;
                                    let u1 = (f64::from(rect.x + rect.w) / atlas_width) as f32;
                                    let v1 = (f64::from(rect.y + rect.h) / atlas_height) as f32;
                                    let paint = &instance.paint;
                                    for (position, uv) in [
                                        ([tl[0], tl[1]], [u0, v0]),
                                        ([br[0], tl[1]], [u1, v0]),
                                        ([tl[0], br[1]], [u0, v1]),
                                        ([tl[0], br[1]], [u0, v1]),
                                        ([br[0], tl[1]], [u1, v0]),
                                        ([br[0], br[1]], [u1, v1]),
                                    ] {
                                        frame.glyphs.extend_from_slice(&position);
                                        frame.glyphs.extend_from_slice(&uv);
                                        frame.glyphs.extend_from_slice(&[
                                            size as f32,
                                            paint.opacity,
                                            paint.halo_width,
                                            paint.halo_blur,
                                            mode[0],
                                            mode[1],
                                            surface.pixel_ratio as f32,
                                            0.0,
                                        ]);
                                        frame.glyphs.extend_from_slice(&paint.color);
                                        frame.glyphs.extend_from_slice(&paint.halo_color);
                                    }
                                }
                            }
                        }
                        frame.placed_labels += tile_symbols.len() as u32;
                    }
                    let count = (frame.glyphs.len() / GLYPH_VERTEX_FLOATS) as u32 - first;
                    if count > 0 {
                        frame.draws.push(StyleDraw::Glyphs { first, count });
                    }
                }
            }
        }
        frame
    }
}

/// One tile's line strips in tile-normalized coordinates, clipped to the tile, with MapLibre's
/// dash coordinates for the camera's tile zoom (`u_tileratio`).
fn build_tile_lines(
    buckets: &TileStyleBuckets,
    z: u8,
    tile_zoom: u8,
    generation: u64,
    atlas: &mut LineAtlas,
) -> StyleTileLines {
    let atlas_height = LINE_ATLAS_HEIGHT as f32;
    let tile_ratio = (f64::from(tile_zoom) - f64::from(z)).exp2() / 16.0;
    let mut bytes = Vec::new();
    let mut ranges = Vec::new();
    let vertex_count =
        |bytes: &Vec<u8>| (bytes.len() as u64 / RETAINED_POLYGON_STROKE_VERTEX_SIZE) as u32;
    for (layer_index, bucket) in buckets.layers.iter().enumerate() {
        let LayerBucket::Lines(lines) = bucket else {
            continue;
        };
        let first = vertex_count(&bytes);
        for line in lines {
            let dash = line.dash.as_ref().and_then(|dash| {
                let entry = atlas.dash(&dash.dasharray, dash.round)?;
                let period = if dash.integer_period {
                    entry.width.trunc()
                } else {
                    entry.width
                };
                (period > 0.0).then_some((entry, period))
            });
            for &index in &line.mesh.indices {
                let vertex = line.mesh.vertices[index as usize];
                let dash = dash.map_or(NO_DASH, |(entry, period)| {
                    [
                        (f64::from(vertex.linesofar) * tile_ratio
                            / f64::from(period)
                            / f64::from(line.width)) as f32,
                        (entry.y + 0.5) / atlas_height,
                        entry.height / 2.0 / atlas_height,
                        period,
                    ]
                });
                push_line_strip_vertex(
                    &mut bytes,
                    vertex.point.map(|value| (value / 8192.0) as f32),
                    vertex.extrude.map(|value| value as f32),
                    vertex.normal,
                    line.width,
                    line.color,
                    dash,
                    [0.0, 0.0, 1.0, 1.0],
                );
            }
        }
        ranges.push((layer_index, first, vertex_count(&bytes) - first));
    }
    StyleTileLines {
        tile_zoom,
        generation,
        bytes,
        ranges,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut value: u64, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn field(number: u32, bytes: &[u8], out: &mut Vec<u8>) {
        varint(u64::from(number << 3 | 2), out);
        varint(bytes.len() as u64, out);
        out.extend_from_slice(bytes);
    }

    /// One `places` layer with a point at tile (2048, 2048) named "Zürich", rank 2.
    fn places_tile() -> Vec<u8> {
        let mut feature = Vec::new();
        let mut tags = Vec::new();
        for tag in [0, 0, 1, 1] {
            varint(tag, &mut tags);
        }
        field(2, &tags, &mut feature);
        varint(3 << 3, &mut feature);
        varint(1, &mut feature);
        let mut geometry = Vec::new();
        for value in [9_u64, 4096, 4096] {
            varint(value, &mut geometry);
        }
        field(4, &geometry, &mut feature);
        let mut layer = Vec::new();
        field(1, b"places", &mut layer);
        field(2, &feature, &mut layer);
        field(3, b"name", &mut layer);
        field(3, b"rank", &mut layer);
        let mut name = Vec::new();
        field(1, "Zürich".as_bytes(), &mut name);
        field(4, &name, &mut layer);
        let mut rank = Vec::new();
        varint(5 << 3, &mut rank);
        varint(2, &mut rank);
        field(4, &rank, &mut layer);
        let mut tile = Vec::new();
        field(3, &layer, &mut tile);
        tile
    }

    #[test]
    fn lays_out_places_and_places_one_label_per_point() {
        let mut symbols = StyleSymbols::default();
        symbols
            .set_layers(
                r##"[
                {"id":"dots","type":"circle","source":"v","source-layer":"places",
                 "paint":{"circle-radius":["interpolate",["linear"],["get","rank"],2,5,8,3],"circle-color":"#1f2937"}},
                {"id":"labels","type":"symbol","source":"v","source-layer":"places",
                 "layout":{"text-field":["get","name"],"text-font":["NotoSans-Regular"],"text-anchor":"left",
                           "text-offset":[0.6,0],"text-size":["interpolate",["linear"],["get","rank"],2,20,8,13]},
                 "paint":{"text-color":"#111827","text-halo-color":"#ffffff","text-halo-width":1.5}}
            ]"##,
            )
            .unwrap();
        symbols.upload("s", (7, 66, 45), &places_tile()).unwrap();
        assert_eq!(
            symbols.missing_glyph_ranges(),
            vec!["0:NotoSans-Regular".to_owned()]
        );
        let glyphs = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../oracle/glyphs/NotoSans-Regular/0-255.pbf"
        ))
        .unwrap();
        symbols.add_glyphs("NotoSans-Regular", 0, &glyphs).unwrap();
        assert!(symbols.missing_glyph_ranges().is_empty());

        // A 512 px tile centred in a 720 x 480 surface without margin: local = screen.
        let (width, height) = (720.0_f32, 480.0_f32);
        let mut view_projection = [0.0_f32; 16];
        view_projection[0] = 2.0 / width;
        view_projection[5] = 2.0 / height;
        view_projection[10] = 1.0;
        view_projection[15] = 1.0;
        let tile = TileId::new(7, 66, 45).unwrap();
        let local = LocalFrame {
            west: -256.0,
            north: 256.0,
            size: 512.0,
        };
        let frame = symbols.frame(
            "s",
            &[(tile, local)],
            view_projection,
            StyleSurface {
                width: f64::from(width),
                height: f64::from(height),
                margin: 0.0,
                pixel_ratio: 1.0,
            },
            &mut LineAtlas::new(),
        );
        assert_eq!(frame.placed_labels, 1);
        assert_eq!(frame.draws.len(), 2);
        assert_eq!(frame.circles.len(), CIRCLE_INSTANCE_FLOATS);
        // "Zürich": six inked glyphs, halo then fill pass, six vertices each.
        assert_eq!(frame.glyphs.len(), 6 * 2 * 6 * GLYPH_VERTEX_FLOATS);
        // The circle sits on the anchor: tile centre at the screen centre.
        assert!(frame.circles[0].abs() < 1e-6 && frame.circles[1].abs() < 1e-6);
        assert_eq!(GLYPH_VERTEX_SIZE, 80);
        assert!(symbols.atlas().width > 0);
        symbols.evict("s", (7, 66, 45));
        assert!(symbols.missing_glyph_ranges().is_empty());
    }
}
