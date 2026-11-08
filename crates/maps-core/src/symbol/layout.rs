//! Per-tile buckets for tileset `fill`, `line`, `circle` and `symbol` layers: MapLibre's
//! `FillBucket` triangles and outlines (#323), `LineBucket` strips (#322), `CircleBucket`
//! points and `performSymbolLayout` point-placement symbol instances (shaped glyph quads,
//! collision boxes and evaluated paint), in MapLibre's 8192-unit tile space.

use std::collections::{BTreeSet, HashMap};

use earcut::Earcut;
use serde_json::Value;

use super::color::Rgba;
use super::expression::{EvaluationContext, js_round, to_string};
use super::glyphs::{GLYPH_PBF_BORDER, GlyphStore};
use super::images::{IMAGE_PADDING, ImageStore, StyleImage, TextFit};
use super::line_anchors::{LabelExtent, center_anchor, clip_line, line_anchors, merge_lines};
use super::polylabel::{classify_rings, pole_of_inaccessibility};
use super::projection::SymbolAlignment;
use super::shaping::{ONE_EM, ShapeOptions, Shaping, SymbolAnchor, shape_text};
use super::style::{StyleLayer, StyleLayerKind};
use super::variable_anchors::{self, AnchorOffset};
use super::zoom::{PropertyKind, SizeData, camera_context, packed_size, symbol_paint};
use crate::line_mesh::{LineCap, LineJoin, LineLayout, LineMesh};
use crate::mvt_features::{MvtFeature, MvtGeometryType, MvtLayer};

/// MapLibre's tile extent for buckets.
pub const EXTENT: f64 = 8192.0;

#[derive(Clone, Debug, PartialEq)]
pub struct TileCircle {
    /// Tile-normalized position (`0..1`).
    pub anchor: [f64; 2],
    pub radius: f32,
    pub blur: f32,
    /// Straight-alpha fill and stroke (opacity applied), as the circle shader takes them.
    pub fill: [f32; 4],
    pub stroke: [f32; 4],
    pub stroke_width: f32,
}

/// One glyph quad relative to its anchor, in 1/32-quantized glyph units (`ONE_EM` = 24):
/// corners tl, tr, bl, br, `text-rotate` applied.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolGlyph {
    pub codepoint: u32,
    pub corners: [[f32; 2]; 4],
}

/// One icon quad (`getIconQuads`): the whole image, or one of the patches `icon-text-fit`
/// stretches. A corner sits at `corners * max(min_font_scale, size) + pixel_offsets` CSS px
/// from the anchor, `size` being `icon-size` (with the perspective ratio).
#[derive(Clone, Debug, PartialEq)]
pub struct IconQuad {
    /// tl, tr, bl, br in 1/32-quantized CSS px at `icon-size` 1, `icon-rotate` applied.
    pub corners: [[f32; 2]; 4],
    /// Fixed (unstretched) offsets of the tl and br corners in 1/16 CSS px; the tr and bl
    /// corners mix them as MapLibre's vertices do. Not rotated, as in MapLibre.
    pub pixel_offsets: [[f32; 2]; 2],
    /// The smallest scale keeping the fixed parts at their size (`minFontScaleX/Y`).
    pub min_font_scale: [f32; 2],
    /// The sampled rect relative to the image's padded atlas bin: x, y, width, height.
    pub tex: [f64; 4],
}

/// Where a line-placed symbol sits on its line: MapLibre's `lineVertexArray` slice and the
/// anchor's segment.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolLine {
    /// The line in 8192-unit tile space (MapLibre's `Int16` vertices).
    pub points: Vec<[f64; 2]>,
    /// The anchor lies between `points[segment]` and `points[segment + 1]`.
    pub segment: usize,
}

/// Evaluated `text-*` or `icon-*` paint; colors premultiplied.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolPaint {
    pub color: [f32; 4],
    pub halo_color: [f32; 4],
    pub halo_width: f32,
    pub halo_blur: f32,
    pub opacity: f32,
}

/// What a line label (`symbol-placement: line` or `line-center` along the line) keeps for
/// projecting its glyphs along [`SymbolInstance::line`] each frame: MapLibre's
/// `glyphOffsetArray` and the placed symbol's line fields.
#[derive(Clone, Debug, PartialEq)]
pub struct LineText {
    /// Each glyph's centre along the text in glyph units, one per quad.
    pub offsets: Vec<f32>,
    /// `text-offset` in glyph units: along the line and away from it.
    pub line_offset: [f64; 2],
    /// The collision circle diameter in CSS px at the layout text size (`None`: no height).
    pub circle_diameter: Option<f64>,
}

/// The text part of a symbol.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolText {
    /// Collision box around the anchor in CSS px at perspective ratio 1 (padding included);
    /// line labels collide with circles along their line instead.
    pub collision_box: [f64; 4],
    /// Quads relative to the anchor (point labels) or to each glyph's point on the line.
    pub glyphs: Vec<SymbolGlyph>,
    /// `text-size` at the bucket's two size zooms (source sizes: twice the same), in the
    /// shader's 1/128 px steps; see [`SizeData::for_feature`].
    pub sizes: [f32; 2],
    pub stack: String,
    /// Paint at the tile zoom and one above (they differ for composite functions).
    pub paint: [SymbolPaint; 2],
    pub line: Option<LineText>,
    /// `text-variable-anchor` or `text-variable-anchor-offset`.
    pub variable: Option<VariableText>,
}

/// A label whose anchor is chosen at placement (MapLibre's `textAnchorOffsets` and shapings
/// per justification): its [`SymbolText::glyphs`] and box are centred on the anchor, and the
/// chosen anchor shifts them.
#[derive(Clone, Debug, PartialEq)]
pub struct VariableText {
    /// Anchors in the order placement tries them, with their offsets in glyph units.
    pub anchors: Vec<AnchorOffset>,
    /// The layout `text-size` over 24: the box is measured at that size.
    pub box_scale: f64,
    /// Quads of a multi-line label per justification (0 left, 0.5 center, 1 right) under
    /// `text-justify: auto`; empty when [`SymbolText::glyphs`] serve every anchor.
    pub justified: Vec<(f64, Vec<SymbolGlyph>)>,
}

impl VariableText {
    /// The quads for an anchor (`markUsedJustification`), `default` when one set serves all.
    #[must_use]
    pub fn glyphs<'a>(
        &'a self,
        anchor: SymbolAnchor,
        default: &'a [SymbolGlyph],
    ) -> &'a [SymbolGlyph] {
        self.justified
            .iter()
            .find(|(justification, _)| *justification == anchor.justification())
            .map_or(default, |(_, glyphs)| glyphs)
    }
}

/// The icon part of a symbol: MapLibre's `shapeIcon`, `fitIconToText` and `getIconQuads`.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolIcon {
    /// The style image id; quads sample rects of its padded bin in the atlas.
    pub image: String,
    /// One quad over the image and its one-pixel padding, or the stretched patches.
    pub quads: Vec<IconQuad>,
    /// Collision box around the anchor in CSS px at perspective ratio 1 (`icon-padding`),
    /// around the rotated box under `icon-rotate`.
    pub collision_box: [f64; 4],
    /// `icon-offset`: an icon along its line also moves along and off the line by it, in
    /// `icon-size` / 24 units (MapLibre's line offset).
    pub line_offset: [f64; 2],
    /// `icon-size` at the bucket's two size zooms, as [`SymbolText::sizes`].
    pub sizes: [f32; 2],
    /// The image's pixel ratio: one unlike the device's makes MapLibre sample linearly.
    pub pixel_ratio: f64,
    pub paint: [SymbolPaint; 2],
}

/// `text-translate` or `icon-translate` (CSS px) and whether its anchor is the viewport.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SymbolTranslate {
    pub offset: [f64; 2],
    pub viewport: bool,
}

impl SymbolTranslate {
    /// MapLibre's `translatePosition` in tile-normalized units, for a tile `tile_px` CSS px
    /// wide under the camera `bearing` (clockwise, radians): a viewport-anchored offset
    /// turns with the bearing into the tile's axes.
    #[must_use]
    pub fn uv(&self, bearing: f64, tile_px: f64) -> [f64; 2] {
        let [mut x, mut y] = self.offset;
        if x == 0.0 && y == 0.0 {
            return [0.0, 0.0];
        }
        if self.viewport && bearing != 0.0 {
            let (sin, cos) = bearing.sin_cos();
            (x, y) = (x * cos - y * sin, x * sin + y * cos);
        }
        [x / tile_px, y / tile_px]
    }

    fn of(
        layer: &StyleLayer,
        prefix: &str,
        context: &EvaluationContext<'_>,
    ) -> Result<Self, String> {
        let offset = match layer.paint_value(&format!("{prefix}-translate"), context)? {
            Some(Value::Array(values)) if values.len() == 2 => [
                values[0].as_f64().unwrap_or(0.0),
                values[1].as_f64().unwrap_or(0.0),
            ],
            _ => [0.0, 0.0],
        };
        Ok(Self {
            offset,
            viewport: layer.string(true, &format!("{prefix}-translate-anchor"), "map", context)?
                == "viewport",
        })
    }
}

/// `symbol-placement`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SymbolPlacement {
    #[default]
    Point,
    Line,
    LineCenter,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SymbolInstance {
    /// Tile-normalized anchor, truncated to MapLibre's integer 8192-unit grid.
    pub anchor: [f64; 2],
    /// The line of a line-placed symbol; text and icons along it follow it.
    pub line: Option<SymbolLine>,
    pub text: Option<SymbolText>,
    pub icon: Option<SymbolIcon>,
    pub feature_index: usize,
}

/// One symbol layer of one tile with the layer-wide placement and draw state MapLibre keeps
/// on its `SymbolBucket` and reads off the layer when it places and draws.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SymbolBucket {
    pub instances: Vec<SymbolInstance>,
    pub text_allow_overlap: bool,
    pub text_ignore_placement: bool,
    pub text_optional: bool,
    pub icon_allow_overlap: bool,
    pub icon_ignore_placement: bool,
    pub icon_optional: bool,
    /// `bucket.sdfIcons`: the first icon decides; MapLibre cannot mix SDF and plain icons.
    pub sdf_icons: bool,
    pub text_size: SizeData,
    pub icon_size: SizeData,
    pub placement: SymbolPlacement,
    /// Text follows its line (`text-rotation-alignment` other than `viewport` off point
    /// placement).
    pub text_along_line: bool,
    /// Text turns with the map (`text-rotation-alignment: map`).
    pub rotate_with_map: bool,
    /// Text lies on the map plane (`text-pitch-alignment: map`).
    pub pitch_with_map: bool,
    /// `text-keep-upright`.
    pub keep_upright: bool,
    /// Icons follow their line (`icon-rotation-alignment: map` off point placement).
    pub icon_along_line: bool,
    /// Icons turn with the map (`icon-rotation-alignment: map`).
    pub icon_rotate_with_map: bool,
    /// Icons lie on the map plane (`icon-pitch-alignment: map`).
    pub icon_pitch_with_map: bool,
    /// `icon-keep-upright`.
    pub icon_keep_upright: bool,
    /// `iconsNeedLinear` from the layout: a rotated icon (`icon-rotate` not the constant 0).
    pub icons_rotated: bool,
    /// `text-translate` and `icon-translate` with their anchors.
    pub text_translate: SymbolTranslate,
    pub icon_translate: SymbolTranslate,
    /// `text-padding` in CSS px: line labels pad their collision circles with it.
    pub text_padding: f64,
    /// The layer sets `icon-offset`: MapLibre's `u_is_offset` then keeps symbol sizes off
    /// the perspective ratio.
    pub icon_offset: bool,
    /// `icon-text-fit` is not `none`: under variable anchors the icon moves with its text.
    pub icon_text_fit: bool,
    /// The layer sets `text-variable-anchor` or `text-variable-anchor-offset`.
    pub variable_anchors: bool,
}

impl SymbolBucket {
    /// How this layer's text meets the map; placement reads it for icon boxes too.
    #[must_use]
    pub fn text_alignment(&self) -> SymbolAlignment {
        SymbolAlignment {
            rotate_with_map: self.rotate_with_map,
            pitch_with_map: self.pitch_with_map,
        }
    }

    /// How this layer's icons meet the map when drawn.
    #[must_use]
    pub fn icon_alignment(&self) -> SymbolAlignment {
        SymbolAlignment {
            rotate_with_map: self.icon_rotate_with_map,
            pitch_with_map: self.icon_pitch_with_map,
        }
    }

    #[must_use]
    pub fn has_text(&self) -> bool {
        self.instances
            .iter()
            .any(|instance| instance.text.is_some())
    }

    #[must_use]
    pub fn has_icons(&self) -> bool {
        self.instances
            .iter()
            .any(|instance| instance.icon.is_some())
    }
}

/// A `line-dasharray` as one feature needs it from the dash atlas.
#[derive(Clone, Debug, PartialEq)]
pub struct TileDash {
    /// Dash and gap lengths in line widths.
    pub dasharray: Vec<f64>,
    /// Round dash ends: a round `line-cap` that the dash atlas sees (see [`layout_lines`]).
    pub round: bool,
    /// A data-driven dash array: MapLibre stores its period as an integer (`Uint16`).
    pub integer_period: bool,
}

/// One feature of a line layer: its strip in tile units (8192 per tile) and evaluated paint.
#[derive(Clone, Debug, PartialEq)]
pub struct TileLine {
    pub mesh: LineMesh,
    /// Straight-alpha color, `line-opacity` applied.
    pub color: [f32; 4],
    /// `line-width` in CSS px.
    pub width: f32,
    pub dash: Option<TileDash>,
    /// `line-opacity`, which MapLibre's `line_pattern` program applies to the image.
    pub opacity: f32,
    /// The `line-pattern` image id (#349): the strip then samples it instead of its color.
    pub pattern: Option<String>,
}

/// One feature of a fill layer: earcut triangles and the `fill-antialias` outline segments
/// (`indexArray2`, one pair per ring edge) over its vertices in tile units (8192 per tile).
#[derive(Clone, Debug, PartialEq)]
pub struct TileFill {
    pub vertices: Vec<[f64; 2]>,
    pub triangles: Vec<u32>,
    pub outline: Vec<[u32; 2]>,
    /// Straight-alpha `fill-color`; `fill-opacity` stays apart, as MapLibre's shaders take it.
    pub color: [f32; 4],
    /// Straight-alpha `fill-outline-color`, the fill color when unset.
    pub outline_color: [f32; 4],
    pub opacity: f32,
    /// The `fill-pattern` image id.
    pub pattern: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LayerBucket {
    Fills {
        fills: Vec<TileFill>,
        /// `fill-antialias`.
        antialias: bool,
        /// Whether `fill-outline-color` is set: the outline then ignores the pattern.
        outline_color: bool,
        /// MapLibre's opaque-pass fill (no pattern, constant opaque color and opacity 1): its
        /// depth keeps the outline outside the fill, so renderers draw the outline first.
        opaque: bool,
    },
    Lines(Vec<TileLine>),
    Circles(Vec<TileCircle>),
    Symbols(Box<SymbolBucket>),
}

/// Buckets of one tile, one per style layer (in style order).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TileStyleBuckets {
    pub layers: Vec<LayerBucket>,
    /// Glyph ranges (`stack`, first codepoint) this tile needed but the store lacked.
    pub missing_glyph_ranges: BTreeSet<(String, u32)>,
}

fn geometry_name(kind: MvtGeometryType) -> &'static str {
    match kind {
        MvtGeometryType::Point => "Point",
        MvtGeometryType::LineString => "LineString",
        MvtGeometryType::Polygon => "Polygon",
    }
}

fn context<'a>(feature: &'a MvtFeature, zoom: f64) -> EvaluationContext<'a> {
    EvaluationContext {
        zoom,
        properties: &feature.properties,
        id: feature.id,
        geometry_type: geometry_name(feature.geometry_type),
    }
}

/// Lays out every style layer for one tile at zoom `z`. Icons resolve against `images`, as
/// MapLibre's worker lays symbols out once their images arrived.
pub fn layout_tile(
    layers: &[StyleLayer],
    source: &[MvtLayer],
    z: u8,
    glyphs: &GlyphStore,
    images: &ImageStore,
) -> Result<TileStyleBuckets, String> {
    let mut buckets = TileStyleBuckets::default();
    for layer in layers {
        let features = source
            .iter()
            .find(|candidate| candidate.name == layer.source_layer);
        let bucket = match layer.kind {
            StyleLayerKind::Fill => LayerBucket::Fills {
                fills: match features {
                    Some(source) => layout_fills(layer, source, z)?,
                    None => Vec::new(),
                },
                antialias: layer.raw_paint("fill-antialias").and_then(Value::as_bool)
                    != Some(false),
                outline_color: layer.raw_paint("fill-outline-color").is_some(),
                opaque: opaque_fill(layer),
            },
            StyleLayerKind::Line => LayerBucket::Lines(match features {
                Some(source) => layout_lines(layer, source, z)?,
                None => Vec::new(),
            }),
            StyleLayerKind::Circle => LayerBucket::Circles(match features {
                Some(source) => layout_circles(layer, source, z)?,
                None => Vec::new(),
            }),
            StyleLayerKind::Symbol => {
                let probe = MvtFeature {
                    id: None,
                    geometry_type: MvtGeometryType::Point,
                    geometry: Vec::new(),
                    properties: Default::default(),
                };
                let zoom = f64::from(z);
                let constant = context(&probe, zoom);
                let size_data = |key: &str, default: f64| {
                    SizeData::new(&PropertyKind::of(layer.raw_layout(key))?, zoom, |at| {
                        layer.number(false, key, default, &camera_context(at))
                    })
                };
                let text_size = size_data("text-size", 16.0)?;
                let icon_size = size_data("icon-size", 1.0)?;
                let placement = match layer
                    .string(false, "symbol-placement", "point", &constant)?
                    .as_str()
                {
                    "line" => SymbolPlacement::Line,
                    "line-center" => SymbolPlacement::LineCenter,
                    _ => SymbolPlacement::Point,
                };
                let (text_rotation, text_pitch) = layer.symbol_alignment("text");
                let (icon_rotation, icon_pitch) = layer.symbol_alignment("icon");
                let text_along_line =
                    placement != SymbolPlacement::Point && text_rotation != "viewport";
                let icon_along_line =
                    placement != SymbolPlacement::Point && icon_rotation != "viewport";
                let options = SymbolOptions {
                    placement,
                    text_along_line,
                    text_size: &text_size,
                    icon_size: &icon_size,
                    icon_text_fit: layer.string(false, "icon-text-fit", "none", &constant)?,
                    icon_text_fit_padding: match layer.value("icon-text-fit-padding", &constant)? {
                        Some(Value::Array(values)) if values.len() == 4 => {
                            std::array::from_fn(|index| values[index].as_f64().unwrap_or(0.0))
                        }
                        _ => [0.0; 4],
                    },
                };
                let icon_text_fit = options.icon_text_fit != "none";
                let instances = match features {
                    Some(source) => layout_symbols(
                        layer,
                        source,
                        z,
                        glyphs,
                        images,
                        &mut buckets.missing_glyph_ranges,
                        &options,
                    )?,
                    None => Vec::new(),
                };
                let sdf_icons = instances
                    .iter()
                    .find_map(|instance| instance.icon.as_ref())
                    .and_then(|icon| images.image(&icon.image))
                    .is_some_and(|image| image.sdf);
                LayerBucket::Symbols(Box::new(SymbolBucket {
                    instances,
                    text_size,
                    icon_size,
                    placement,
                    text_along_line,
                    rotate_with_map: text_rotation == "map",
                    pitch_with_map: text_pitch == "map",
                    keep_upright: layer.boolean("text-keep-upright", true, &constant)?,
                    icon_along_line,
                    icon_rotate_with_map: icon_rotation == "map",
                    icon_pitch_with_map: icon_pitch == "map",
                    icon_keep_upright: layer.boolean("icon-keep-upright", false, &constant)?,
                    // `constantOr(1) !== 0`: data-driven rotations count as rotated.
                    icons_rotated: !PropertyKind::of(layer.raw_layout("icon-rotate"))?
                        .is_feature_constant()
                        || layer.number(false, "icon-rotate", 0.0, &constant)? != 0.0,
                    text_translate: SymbolTranslate::of(layer, "text", &constant)?,
                    icon_translate: SymbolTranslate::of(layer, "icon", &constant)?,
                    text_padding: layer.number(false, "text-padding", 2.0, &constant)?,
                    icon_offset: layer.raw_layout("icon-offset").is_some(),
                    icon_text_fit,
                    variable_anchors: layer.raw_layout("text-variable-anchor").is_some()
                        || layer.raw_layout("text-variable-anchor-offset").is_some(),
                    text_allow_overlap: layer.boolean("text-allow-overlap", false, &constant)?,
                    text_ignore_placement: layer.boolean(
                        "text-ignore-placement",
                        false,
                        &constant,
                    )?,
                    text_optional: layer.boolean("text-optional", false, &constant)?,
                    icon_allow_overlap: layer.boolean("icon-allow-overlap", false, &constant)?,
                    icon_ignore_placement: layer.boolean(
                        "icon-ignore-placement",
                        false,
                        &constant,
                    )?,
                    icon_optional: layer.boolean("icon-optional", false, &constant)?,
                    sdf_icons,
                }))
            }
        };
        buckets.layers.push(bucket);
    }
    Ok(buckets)
}

fn scale(source: &MvtLayer) -> f64 {
    EXTENT / f64::from(source.extent)
}

fn layout_circles(layer: &StyleLayer, source: &MvtLayer, z: u8) -> Result<Vec<TileCircle>, String> {
    let scale = scale(source);
    let mut circles = Vec::new();
    for feature in &source.features {
        let context = context(feature, f64::from(z));
        if !layer.accepts(&context)? {
            continue;
        }
        let radius = layer.number(true, "circle-radius", 5.0, &context)?;
        let opacity = layer.number(true, "circle-opacity", 1.0, &context)?;
        let stroke_opacity = layer.number(true, "circle-stroke-opacity", 1.0, &context)?;
        let mut fill = layer.color(
            "circle-color",
            Rgba::parse("#000").unwrap_or(Rgba::TRANSPARENT),
            &context,
        )?;
        fill.a *= opacity;
        let mut stroke = layer.color(
            "circle-stroke-color",
            Rgba::parse("#000").unwrap_or(Rgba::TRANSPARENT),
            &context,
        )?;
        stroke.a *= stroke_opacity;
        let circle = |point: [i32; 2]| TileCircle {
            anchor: [
                js_round(f64::from(point[0]) * scale) / EXTENT,
                js_round(f64::from(point[1]) * scale) / EXTENT,
            ],
            radius: radius as f32,
            blur: 0.0,
            fill: fill.straight(),
            stroke: stroke.straight(),
            stroke_width: 0.0,
        };
        let blur = layer.number(true, "circle-blur", 0.0, &context)? as f32;
        let stroke_width = layer.number(true, "circle-stroke-width", 0.0, &context)? as f32;
        for path in &feature.geometry {
            for point in path {
                let x = js_round(f64::from(point[0]) * scale);
                let y = js_round(f64::from(point[1]) * scale);
                // CircleBucket: points outside the tile are drawn by their own tile.
                if x < 0.0 || x >= EXTENT || y < 0.0 || y >= EXTENT {
                    continue;
                }
                circles.push(TileCircle {
                    blur,
                    stroke_width,
                    ..circle(*point)
                });
            }
        }
    }
    Ok(circles)
}

/// `drawFill`'s `fillEligibleForOpaque`: no pattern, and a constant fill color of alpha 1 with
/// a constant opacity of 1.
fn opaque_fill(layer: &StyleLayer) -> bool {
    let color = match layer.raw_paint("fill-color") {
        None => Some(1.0),
        Some(Value::String(text)) => Rgba::parse(text).map(|color| color.a),
        Some(_) => None,
    };
    let opacity = match layer.raw_paint("fill-opacity") {
        None => Some(1.0),
        Some(value) => value.as_f64(),
    };
    layer.raw_paint("fill-pattern").is_none() && color == Some(1.0) && opacity == Some(1.0)
}

/// MapLibre's `FillBucket.addFeature`: each polygon of a feature (rings classified by
/// winding) is earcut into triangles over its ring vertices, and every ring edge, the closing
/// one included, becomes an outline segment. `fill-pattern` is evaluated per feature at the
/// tile zoom; zoom-dependent patterns were rejected when the layer was parsed, so MapLibre's
/// cross-faded `from` and `to` images are the same one.
pub fn layout_fills(layer: &StyleLayer, source: &MvtLayer, z: u8) -> Result<Vec<TileFill>, String> {
    let scale = scale(source);
    let mut earcut = Earcut::new();
    let mut triangles: Vec<u32> = Vec::new();
    let mut fills = Vec::new();
    for feature in &source.features {
        if feature.geometry_type != MvtGeometryType::Polygon {
            continue;
        }
        let context = context(feature, f64::from(z));
        if !layer.accepts(&context)? {
            continue;
        }
        let black = Rgba::parse("#000").unwrap_or(Rgba::TRANSPARENT);
        let color = layer.color("fill-color", black, &context)?;
        let outline_color = layer.color("fill-outline-color", color, &context)?;
        let opacity = layer.number(true, "fill-opacity", 1.0, &context)?;
        let pattern = match layer.raw_paint("fill-pattern") {
            None => None,
            Some(_) => layer
                .paint_value("fill-pattern", &context)?
                .and_then(|value| value.as_str().map(str::to_owned))
                .filter(|id| !id.is_empty()),
        };
        // A layer with `fill-pattern` draws only the features whose image resolves.
        if layer.raw_paint("fill-pattern").is_some() && pattern.is_none() {
            continue;
        }
        let rings: Vec<Vec<[f64; 2]>> = feature
            .geometry
            .iter()
            .map(|ring| {
                let ring = match ring.as_slice() {
                    [first, .., last] if first == last => &ring[..ring.len() - 1],
                    _ => ring.as_slice(),
                };
                ring.iter()
                    .map(|point| {
                        [
                            js_round(f64::from(point[0]) * scale),
                            js_round(f64::from(point[1]) * scale),
                        ]
                    })
                    .collect()
            })
            .collect();
        let mut fill = TileFill {
            vertices: Vec::new(),
            triangles: Vec::new(),
            outline: Vec::new(),
            color: color.straight(),
            outline_color: outline_color.straight(),
            opacity: opacity as f32,
            pattern,
        };
        for polygon in classify_rings(&rings) {
            let base = fill.vertices.len() as u32;
            let mut holes = Vec::new();
            for (index, ring) in polygon.iter().enumerate() {
                if ring.is_empty() {
                    continue;
                }
                let first = fill.vertices.len() as u32;
                if index > 0 {
                    holes.push(first - base);
                }
                let count = ring.len() as u32;
                fill.outline.push([first + count - 1, first]);
                for offset in 1..count {
                    fill.outline.push([first + offset - 1, first + offset]);
                }
                fill.vertices.extend_from_slice(ring);
            }
            earcut.earcut(
                fill.vertices[base as usize..].iter().copied(),
                &holes,
                &mut triangles,
            );
            fill.triangles
                .extend(triangles.iter().map(|index| base + index));
        }
        if !fill.vertices.is_empty() {
            fills.push(fill);
        }
    }
    Ok(fills)
}

/// Resolves `{token}` strings (legacy text-field) against feature properties.
fn resolve_tokens(text: &str, feature: &MvtFeature) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        let Some(end) = rest[start..].find('}') else {
            break;
        };
        output.push_str(&rest[..start]);
        let key = &rest[start + 1..start + end];
        output.push_str(
            &feature
                .properties
                .get(key)
                .map(to_string)
                .unwrap_or_default(),
        );
        rest = &rest[start + end + 1..];
    }
    output.push_str(rest);
    output
}

/// What `performSymbolLayout` reads off the bucket for every feature.
struct SymbolOptions<'a> {
    placement: SymbolPlacement,
    text_along_line: bool,
    text_size: &'a SizeData,
    icon_size: &'a SizeData,
    /// `icon-text-fit` (`none`, `width`, `height`, `both`) and its padding (top, right,
    /// bottom, left).
    icon_text_fit: String,
    icon_text_fit_padding: [f64; 4],
}

/// One feature's symbol parts before anchors: its shaped text, icon and geometry.
struct SymbolFeature {
    index: usize,
    text: Option<FeatureText>,
    icon: Option<FeatureIcon>,
    geometry: Vec<Vec<[f64; 2]>>,
}

/// MapLibre's `PositionedIcon`: the icon's box around the anchor in CSS px at `icon-size` 1,
/// and the padding `fitIconToText` leaves outside an image's `content` box.
#[derive(Clone, Debug, PartialEq)]
struct PositionedIcon {
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
    collision_padding: Option<[f64; 4]>,
}

/// One feature's icon, before it is placed at its anchors.
struct FeatureIcon {
    icon: SymbolIcon,
    shaped: PositionedIcon,
}

/// `performSymbolLayout` and `addFeature`: shaped text and icons at each anchor of each
/// accepted feature. Line placement merges same-text lines first (`mergeLines`) and drops
/// anchors too close to one of the same text (`anchorIsTooClose`).
#[allow(clippy::too_many_arguments)]
fn layout_symbols(
    layer: &StyleLayer,
    source: &MvtLayer,
    z: u8,
    glyphs: &GlyphStore,
    images: &ImageStore,
    missing: &mut BTreeSet<(String, u32)>,
    options: &SymbolOptions<'_>,
) -> Result<Vec<SymbolInstance>, String> {
    let scale = scale(source);
    let mut features = Vec::new();
    for (index, feature) in source.features.iter().enumerate() {
        let tile_context = context(feature, f64::from(z));
        if !layer.accepts(&tile_context)? {
            continue;
        }
        let text = feature_text(layer, feature, z, glyphs, missing, options)?;
        let icon = symbol_icon(layer, feature, z, images, text.as_ref(), options)?;
        if text.is_none() && icon.is_none() {
            continue;
        }
        let geometry = feature
            .geometry
            .iter()
            .map(|path| {
                path.iter()
                    .map(|point| {
                        [
                            js_round(f64::from(point[0]) * scale),
                            js_round(f64::from(point[1]) * scale),
                        ]
                    })
                    .collect()
            })
            .collect();
        features.push((
            feature,
            SymbolFeature {
                index,
                text,
                icon,
                geometry,
            },
        ));
    }
    if options.placement == SymbolPlacement::Line {
        let keyed = features
            .into_iter()
            .map(|(feature, mut symbol)| {
                let text = symbol.text.as_ref().map(|text| text.text.clone());
                let geometry = std::mem::take(&mut symbol.geometry);
                ((feature, symbol), text, geometry)
            })
            .collect();
        features = merge_lines(keyed)
            .into_iter()
            .map(|((feature, mut symbol), geometry)| {
                symbol.geometry = geometry;
                (feature, symbol)
            })
            .collect();
    }

    let mut instances = Vec::new();
    let mut compare_text: HashMap<String, Vec<[f64; 2]>> = HashMap::new();
    for (feature, symbol) in &features {
        let tile_context = context(feature, f64::from(z));
        let spacing =
            TILE_PIXEL_RATIO * layer.number(false, "symbol-spacing", 250.0, &tile_context)?;
        let mut add = |anchor: [f64; 2], line: Option<(&[[f64; 2]], usize)>| {
            // addSymbolAtAnchor: neighbouring tiles own anchors in their buffers.
            if anchor[0] < 0.0 || anchor[0] >= EXTENT || anchor[1] < 0.0 || anchor[1] >= EXTENT {
                return;
            }
            // MapLibre stores anchors and line vertices as `Int16`.
            let anchor = [anchor[0].trunc(), anchor[1].trunc()];
            let line = line.map(|(line, segment)| SymbolLine {
                points: line
                    .iter()
                    .map(|point| [point[0].trunc(), point[1].trunc()])
                    .collect(),
                segment,
            });
            let text_along_line = line.is_some() && options.text_along_line;
            instances.push(SymbolInstance {
                anchor: [anchor[0] / EXTENT, anchor[1] / EXTENT],
                line,
                text: symbol
                    .text
                    .as_ref()
                    .map(|text| text.at_anchor(text_along_line)),
                icon: symbol.icon.as_ref().map(|icon| icon.icon.clone()),
                feature_index: symbol.index,
            });
        };
        match options.placement {
            SymbolPlacement::Point => {
                for anchor in point_anchors(feature.geometry_type, &symbol.geometry) {
                    add(anchor, None);
                }
            }
            SymbolPlacement::Line | SymbolPlacement::LineCenter => {
                let max_angle = layer
                    .number(false, "text-max-angle", 45.0, &tile_context)?
                    .to_radians();
                // `textMaxSize`: `text-size` at zoom 18, whether or not there is text.
                let max_size = layer.number(false, "text-size", 16.0, &context(feature, 18.0))?;
                let text_length = symbol
                    .text
                    .as_ref()
                    .map_or(0.0, |text| text.shaping.right - text.shaping.left);
                let icon_length = symbol
                    .icon
                    .as_ref()
                    .map_or(0.0, |icon| icon.shaped.right - icon.shaped.left);
                let extent = LabelExtent {
                    length: text_length.max(icon_length),
                    glyph_size: ONE_EM,
                    box_scale: TILE_PIXEL_RATIO * max_size / ONE_EM,
                    has_text: symbol.text.is_some(),
                };
                if options.placement == SymbolPlacement::Line {
                    let repeat_distance = spacing / 2.0;
                    for line in clip_line(&symbol.geometry, 0.0, 0.0, EXTENT, EXTENT) {
                        for anchor in line_anchors(&line, spacing, max_angle, &extent, 1.0, EXTENT)
                        {
                            // `anchorIsTooClose` compares text only.
                            if let Some(text) = &symbol.text {
                                let others = compare_text.entry(text.text.clone()).or_default();
                                if others.iter().rev().any(|other| {
                                    (other[0] - anchor.point[0]).hypot(other[1] - anchor.point[1])
                                        < repeat_distance
                                }) {
                                    continue;
                                }
                                others.push(anchor.point);
                            }
                            add(anchor.point, Some((&line, anchor.segment)));
                        }
                    }
                } else {
                    for line in symbol.geometry.iter().filter(|line| line.len() > 1) {
                        if let Some(anchor) = center_anchor(line, max_angle, &extent) {
                            add(anchor.point, Some((line, anchor.segment)));
                        }
                    }
                }
            }
        }
    }
    Ok(instances)
}

/// `EXTENT / tileSize`: tile units per CSS px of a 512 px tile.
const TILE_PIXEL_RATIO: f64 = EXTENT / 512.0;

/// A string layout property: `{token}` strings resolve against the feature (legacy), others
/// evaluate as expressions. `None` for null or empty.
fn string_property(
    layer: &StyleLayer,
    key: &str,
    feature: &MvtFeature,
    context: &EvaluationContext<'_>,
) -> Result<Option<String>, String> {
    let value = match layer.raw_layout(key) {
        None => return Ok(None),
        Some(Value::String(tokens)) => resolve_tokens(tokens, feature),
        Some(_) => match layer.value(key, context)? {
            None | Some(Value::Null) => return Ok(None),
            Some(value) => to_string(&value),
        },
    };
    Ok(Some(value).filter(|value| !value.is_empty()))
}

/// MapLibre's `getIconPadding`: CSS order (top, right, bottom, left) from 1 to 4 values.
fn icon_padding(value: Option<Value>) -> [f64; 4] {
    let values: Vec<f64> = match value {
        Some(Value::Number(number)) => number.as_f64().into_iter().collect(),
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_f64).collect(),
        _ => Vec::new(),
    };
    match values[..] {
        [all] => [all; 4],
        [vertical, horizontal] => [vertical, horizontal, vertical, horizontal],
        [top, horizontal, bottom] => [top, horizontal, bottom, horizontal],
        [top, right, bottom, left] => [top, right, bottom, left],
        _ => [2.0; 4],
    }
}

/// A feature's paint at the tile zoom and one above (composite paint blends them).
fn feature_paint(
    layer: &StyleLayer,
    prefix: &str,
    feature: &MvtFeature,
    z: u8,
) -> Result<[SymbolPaint; 2], String> {
    let zoom = f64::from(z);
    Ok([
        symbol_paint(layer, prefix, &context(feature, zoom))?,
        symbol_paint(layer, prefix, &context(feature, zoom + 1.0))?,
    ])
}

/// A feature's `text-size` or `icon-size` at the zoom of its layout (the tile zoom plus one,
/// which collision boxes use) and as the shader's two packed sizes.
fn feature_sizes(
    layer: &StyleLayer,
    key: &str,
    default: f64,
    feature: &MvtFeature,
    z: u8,
    data: &SizeData,
) -> Result<(f64, [f32; 2]), String> {
    let at = |zoom: f64| layer.number(false, key, default, &context(feature, zoom));
    let layout_size = at(f64::from(z) + 1.0)?;
    let sizes = match data.feature_zooms() {
        Some([lower, upper]) => [packed_size(at(lower)?), packed_size(at(upper)?)],
        None => [packed_size(at(f64::from(z))?); 2],
    };
    Ok((layout_size, sizes))
}

/// MapLibre's `_matMult([cos, -sin, sin, cos])` (and `_rotate`): `point` turned by the angle
/// whose sine and cosine are given.
fn rotate_point(point: [f64; 2], (sin, cos): (f64, f64)) -> [f64; 2] {
    [
        cos * point[0] - sin * point[1],
        sin * point[0] + cos * point[1],
    ]
}

/// `CollisionFeature` under `text-rotate` / `icon-rotate`: the box around the rotated box.
fn rotated_box(b: [f64; 4], degrees: f64) -> [f64; 4] {
    if degrees == 0.0 || degrees.is_nan() {
        return b;
    }
    let angle = degrees.to_radians().sin_cos();
    let corners = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]
        .map(|corner| rotate_point(corner, angle));
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for [x, y] in corners {
        lo = [lo[0].min(x), lo[1].min(y)];
        hi = [hi[0].max(x), hi[1].max(y)];
    }
    [lo[0], lo[1], hi[0], hi[1]]
}

/// A value as MapLibre's `Int16` vertex attributes keep it: truncated, `NaN` 0.
fn truncated(value: f64) -> f64 {
    if value.is_finite() {
        value.trunc()
    } else {
        0.0
    }
}

/// Glyph and icon corners are quantized to 1/32 units as MapLibre's vertices store them.
fn quantize(value: f64) -> f32 {
    (truncated(js_round(value * 32.0)) / 32.0) as f32
}

/// `fitIconToText`: the icon centred on the text, or stretched over it (plus
/// `icon-text-fit-padding`: top, right, bottom, left) along the fitted axes; `font_scale` is
/// the layout `text-size` over 24.
fn fit_icon_to_text(
    image: &StyleImage,
    shaping: &Shaping,
    fit: &str,
    padding: [f64; 4],
    offset: [f64; 2],
    font_scale: f64,
) -> PositionedIcon {
    let display = [
        f64::from(image.width) / image.pixel_ratio,
        f64::from(image.height) / image.pixel_ratio,
    ];
    let collision_padding = image.fit.content.map(|content| {
        [
            content[0] / image.pixel_ratio,
            content[1] / image.pixel_ratio,
            display[0] - content[2] / image.pixel_ratio,
            display[1] - content[3] / image.pixel_ratio,
        ]
    });
    let (text_left, text_right) = (shaping.left * font_scale, shaping.right * font_scale);
    let (left, right) = if fit == "width" || fit == "both" {
        (
            offset[0] + text_left - padding[3],
            offset[0] + text_right + padding[1],
        )
    } else {
        let left = offset[0] + (text_left + text_right - display[0]) / 2.0;
        (left, left + display[0])
    };
    let (text_top, text_bottom) = (shaping.top * font_scale, shaping.bottom * font_scale);
    let (top, bottom) = if fit == "height" || fit == "both" {
        (
            offset[1] + text_top - padding[0],
            offset[1] + text_bottom + padding[2],
        )
    } else {
        let top = offset[1] + (text_top + text_bottom - display[1]) / 2.0;
        (top, top + display[1])
    };
    PositionedIcon {
        top,
        bottom,
        left,
        right,
        collision_padding,
    }
}

/// `applyTextFit`: a fitted icon widened or heightened back to its `content` aspect ratio
/// along a `proportional` axis. Returns left, top, right, bottom.
fn apply_text_fit(shaped: &PositionedIcon, image: &StyleImage) -> [f64; 4] {
    let (mut left, mut top) = (shaped.left, shaped.top);
    let (mut width, mut height) = (shaped.right - left, shaped.bottom - top);
    let content = image.fit.content.unwrap_or_default();
    let aspect = (content[2] - content[0]) / (content[3] - content[1]);
    let fit_width = image.fit.text_fit_width.unwrap_or_default();
    let fit_height = image.fit.text_fit_height.unwrap_or_default();
    if fit_height == TextFit::Proportional {
        if (fit_width == TextFit::StretchOnly && width / height < aspect)
            || fit_width == TextFit::Proportional
        {
            let new_width = (height * aspect).ceil();
            left *= new_width / width;
            width = new_width;
        }
    } else if fit_width == TextFit::Proportional
        && fit_height == TextFit::StretchOnly
        && aspect != 0.0
        && width / height > aspect
    {
        let new_height = (width / aspect).ceil();
        top *= new_height / height;
        height = new_height;
    }
    [left, top, left + width, top + height]
}

/// One edge of an icon patch: image pixels in fixed and in stretched zones before it.
#[derive(Clone, Copy)]
struct Cut {
    fixed: f64,
    stretch: f64,
}

/// `stretchZonesToCuts`.
fn stretch_zones_to_cuts(zones: &[[f64; 2]], fixed_size: f64, stretch_size: f64) -> Vec<Cut> {
    let border = f64::from(IMAGE_PADDING);
    let mut cuts = vec![Cut {
        fixed: -border,
        stretch: 0.0,
    }];
    for [c1, c2] in zones {
        let last = cuts[cuts.len() - 1];
        cuts.push(Cut {
            fixed: c1 - last.stretch,
            stretch: last.stretch,
        });
        cuts.push(Cut {
            fixed: c1 - last.stretch,
            stretch: last.stretch + (c2 - c1),
        });
    }
    cuts.push(Cut {
        fixed: fixed_size + border,
        stretch: stretch_size,
    });
    cuts
}

/// `sumWithinRange`.
fn sum_within_range(ranges: &[[f64; 2]], min: f64, max: f64) -> f64 {
    ranges
        .iter()
        .map(|range| range[1].min(max).max(min) - range[0].min(max).max(min))
        .sum()
}

/// The stretch and fixed extents `getIconQuads` maps an image's patches through, per axis.
#[derive(Clone, Copy)]
struct PatchAxis {
    /// Stretched image pixels in the whole image, before the content box and inside it.
    stretch_size: f64,
    stretch_offset: f64,
    stretch_content: f64,
    /// Fixed image pixels before the content box and inside it.
    fixed_offset: f64,
    fixed_content: f64,
    /// The icon's extent on this axis in CSS px.
    icon_origin: f64,
    icon_size: f64,
}

impl PatchAxis {
    /// `getEmOffset`.
    fn em(&self, cut: Cut) -> f64 {
        (cut.stretch - self.stretch_offset) / self.stretch_content * self.icon_size
            + self.icon_origin
    }

    /// `getPxOffset`.
    fn px(&self, cut: Cut) -> f64 {
        cut.fixed - self.fixed_offset - self.fixed_content * cut.stretch / self.stretch_size
    }
}

/// `getIconQuads`: one quad over the image and its one-pixel padding, or, under
/// `icon-text-fit` with `stretchX` / `stretchY`, a patch per pair of cuts whose stretched
/// zones scale with the icon and whose fixed zones keep their size.
fn icon_quads(
    shaped: &PositionedIcon,
    image: &StyleImage,
    rotate_degrees: f64,
    has_icon_text_fit: bool,
) -> Vec<IconQuad> {
    let border = f64::from(IMAGE_PADDING);
    let pixel_ratio = image.pixel_ratio;
    let (image_width, image_height) = (f64::from(image.width), f64::from(image.height));
    let mut icon = [shaped.left, shaped.top, shaped.right, shaped.bottom];
    let whole_x = [[0.0, image_width]];
    let whole_y = [[0.0, image_height]];
    let stretch_x: &[[f64; 2]] = image.fit.stretch_x.as_deref().unwrap_or(&whole_x);
    let stretch_y: &[[f64; 2]] = image.fit.stretch_y.as_deref().unwrap_or(&whole_y);
    let total = |ranges: &[[f64; 2]]| ranges.iter().map(|range| range[1] - range[0]).sum::<f64>();
    let (stretch_width, stretch_height) = (total(stretch_x), total(stretch_y));
    let (fixed_width, fixed_height) = (image_width - stretch_width, image_height - stretch_height);
    let axis = |stretch_size: f64, fixed_size: f64| PatchAxis {
        stretch_size,
        stretch_offset: 0.0,
        stretch_content: stretch_size,
        fixed_offset: 0.0,
        fixed_content: fixed_size,
        icon_origin: 0.0,
        icon_size: 0.0,
    };
    let (mut x, mut y) = (
        axis(stretch_width, fixed_width),
        axis(stretch_height, fixed_height),
    );
    if let (Some(content), true) = (image.fit.content, has_icon_text_fit) {
        if image.fit.text_fit_width.is_some() || image.fit.text_fit_height.is_some() {
            icon = apply_text_fit(shaped, image);
        }
        x.stretch_offset = sum_within_range(stretch_x, 0.0, content[0]);
        y.stretch_offset = sum_within_range(stretch_y, 0.0, content[1]);
        x.stretch_content = sum_within_range(stretch_x, content[0], content[2]);
        y.stretch_content = sum_within_range(stretch_y, content[1], content[3]);
        x.fixed_offset = content[0] - x.stretch_offset;
        y.fixed_offset = content[1] - y.stretch_offset;
        x.fixed_content = content[2] - content[0] - x.stretch_content;
        y.fixed_content = content[3] - content[1] - y.stretch_content;
    }
    (x.icon_origin, x.icon_size) = (icon[0], icon[2] - icon[0]);
    (y.icon_origin, y.icon_size) = (icon[1], icon[3] - icon[1]);
    let angle = (rotate_degrees != 0.0 && !rotate_degrees.is_nan())
        .then(|| rotate_degrees.to_radians().sin_cos());
    // `a_pixeloffset` keeps 1/16 px and 1/256 scale steps in `Int16`s.
    let sixteenth = |value: f64| (truncated(value / pixel_ratio * 16.0) / 16.0) as f32;
    let scale = |value: f64| (truncated(value * 256.0) / 256.0) as f32;
    let make_box = |left: Cut, top: Cut, right: Cut, bottom: Cut| {
        let mut corners = [
            [x.em(left), y.em(top)],
            [x.em(right), y.em(top)],
            [x.em(left), y.em(bottom)],
            [x.em(right), y.em(bottom)],
        ];
        if let Some(angle) = angle {
            corners = corners.map(|corner| rotate_point(corner, angle));
        }
        let (x1, x2) = (left.stretch + left.fixed, right.stretch + right.fixed);
        let (y1, y2) = (top.stretch + top.fixed, bottom.stretch + bottom.fixed);
        IconQuad {
            corners: corners.map(|[cx, cy]| [quantize(cx), quantize(cy)]),
            pixel_offsets: [
                [sixteenth(x.px(left)), sixteenth(y.px(top))],
                [sixteenth(x.px(right)), sixteenth(y.px(bottom))],
            ],
            min_font_scale: [
                scale(x.fixed_content / pixel_ratio / x.icon_size),
                scale(y.fixed_content / pixel_ratio / y.icon_size),
            ],
            tex: [border + x1, border + y1, x2 - x1, y2 - y1],
        }
    };
    if !has_icon_text_fit || (image.fit.stretch_x.is_none() && image.fit.stretch_y.is_none()) {
        let cut = |stretch: f64| Cut {
            fixed: 0.0,
            stretch,
        };
        return vec![make_box(
            cut(-1.0),
            cut(-1.0),
            cut(image_width + 1.0),
            cut(image_height + 1.0),
        )];
    }
    let x_cuts = stretch_zones_to_cuts(stretch_x, fixed_width, stretch_width);
    let y_cuts = stretch_zones_to_cuts(stretch_y, fixed_height, stretch_height);
    let mut quads = Vec::new();
    for xs in x_cuts.windows(2) {
        for ys in y_cuts.windows(2) {
            quads.push(make_box(xs[0], ys[0], xs[1], ys[1]));
        }
    }
    quads
}

/// `shapeIcon`, `fitIconToText`, `getIconQuads` and the icon `CollisionFeature` for one
/// feature. An image the style lacks leaves the symbol without an icon, as in MapLibre.
fn symbol_icon(
    layer: &StyleLayer,
    feature: &MvtFeature,
    z: u8,
    images: &ImageStore,
    text: Option<&FeatureText>,
    options: &SymbolOptions<'_>,
) -> Result<Option<FeatureIcon>, String> {
    let tile_context = context(feature, f64::from(z));
    let context = &tile_context;
    let Some(id) = string_property(layer, "icon-image", feature, context)? else {
        return Ok(None);
    };
    let Some(image) = images.image(&id) else {
        return Ok(None);
    };
    let anchor = SymbolAnchor::parse(&layer.string(false, "icon-anchor", "center", context)?)
        .ok_or_else(|| format!("{}: invalid icon-anchor", layer.id))?;
    let offset = match layer.value("icon-offset", context)? {
        Some(Value::Array(values)) if values.len() == 2 => [
            values[0].as_f64().unwrap_or(0.0),
            values[1].as_f64().unwrap_or(0.0),
        ],
        _ => [0.0, 0.0],
    };
    let (horizontal, vertical) = anchor.alignment();
    let display = [
        f64::from(image.width) / image.pixel_ratio,
        f64::from(image.height) / image.pixel_ratio,
    ];
    let left = offset[0] - display[0] * horizontal;
    let top = offset[1] - display[1] * vertical;
    let mut shaped = PositionedIcon {
        top,
        bottom: top + display[1],
        left,
        right: left + display[0],
        collision_padding: None,
    };
    let has_icon_text_fit = options.icon_text_fit != "none";
    if let (true, Some(text)) = (has_icon_text_fit, text) {
        shaped = fit_icon_to_text(
            image,
            &text.shaping,
            &options.icon_text_fit,
            options.icon_text_fit_padding,
            offset,
            text.layout_size / ONE_EM,
        );
    }
    let rotate = layer.number(false, "icon-rotate", 0.0, context)?;
    // Collision boxes take `icon-size` at the tile zoom plus one.
    let (size, sizes) = feature_sizes(layer, "icon-size", 1.0, feature, z, options.icon_size)?;
    let padding = icon_padding(layer.value("icon-padding", context)?);
    let fitted = image.fit.content.is_some()
        && (image.fit.text_fit_width.is_some() || image.fit.text_fit_height.is_some());
    let [x1, y1, x2, y2] = if fitted {
        apply_text_fit(&shaped, image)
    } else {
        [shaped.left, shaped.top, shaped.right, shaped.bottom]
    };
    let mut collision_box = [
        x1 * size - padding[3],
        y1 * size - padding[0],
        x2 * size + padding[1],
        y2 * size + padding[2],
    ];
    if let Some(extra) = shaped.collision_padding {
        collision_box[0] -= extra[0] * size;
        collision_box[1] -= extra[1] * size;
        collision_box[2] += extra[2] * size;
        collision_box[3] += extra[3] * size;
    }
    Ok(Some(FeatureIcon {
        icon: SymbolIcon {
            image: id,
            quads: icon_quads(&shaped, image, rotate, has_icon_text_fit),
            collision_box: rotated_box(collision_box, rotate),
            line_offset: offset,
            sizes,
            pixel_ratio: image.pixel_ratio,
            paint: feature_paint(layer, "icon", feature, z)?,
        },
        shaped,
    }))
}

/// One feature's shaped `text-field`, before it is placed at its anchors.
struct FeatureText {
    /// The transformed text (`mergeLines` and `anchorIsTooClose` compare it).
    text: String,
    shaping: Shaping,
    /// Under variable anchors with several justifications, every shaping (first is `shaping`).
    justified: Vec<(f64, Shaping)>,
    /// `text-variable-anchor(-offset)`: anchors with their offsets in glyph units.
    variable: Option<Vec<AnchorOffset>>,
    stack: String,
    /// `text-size` at the tile zoom plus one, which collision shapes use.
    layout_size: f64,
    sizes: [f32; 2],
    /// `text-offset` in glyph units.
    offset: [f64; 2],
    padding: f64,
    /// `text-rotate` in degrees.
    rotate: f64,
    paint: [SymbolPaint; 2],
}

impl FeatureText {
    /// The text at one anchor: point quads (offset built in) and a collision box, or, along
    /// its line (`getGlyphQuads` with `alongLine`), quads around each glyph's centre with
    /// those centres and a collision circle.
    fn at_anchor(&self, along_line: bool) -> SymbolText {
        let font_scale = self.layout_size / ONE_EM;
        let (quads, offsets) = self.glyph_quads(&self.shaping, along_line);
        let variable = self.variable.as_ref().map(|anchors| VariableText {
            anchors: anchors.clone(),
            box_scale: font_scale,
            justified: self
                .justified
                .iter()
                .map(|(justification, shaping)| {
                    (*justification, self.glyph_quads(shaping, false).0)
                })
                .collect(),
        });
        let shaping = &self.shaping;
        SymbolText {
            collision_box: rotated_box(
                [
                    shaping.left * font_scale - self.padding,
                    shaping.top * font_scale - self.padding,
                    shaping.right * font_scale + self.padding,
                    shaping.bottom * font_scale + self.padding,
                ],
                self.rotate,
            ),
            glyphs: quads,
            sizes: self.sizes,
            stack: self.stack.clone(),
            paint: self.paint.clone(),
            variable,
            line: along_line.then(|| {
                // `CollisionFeature` along a line: a circle as tall as the text, at least
                // 10 glyph units.
                let height = shaping.bottom - shaping.top;
                LineText {
                    offsets,
                    line_offset: self.offset,
                    circle_diameter: (height > 0.0).then(|| height.max(10.0) * font_scale),
                }
            }),
        }
    }

    /// `getGlyphQuads` for one shaping: quads, and along a line each glyph's centre.
    fn glyph_quads(&self, shaping: &Shaping, along_line: bool) -> (Vec<SymbolGlyph>, Vec<f32>) {
        let rect_buffer = f64::from(GLYPH_PBF_BORDER + 1);
        let angle = (self.rotate != 0.0 && !self.rotate.is_nan())
            .then(|| self.rotate.to_radians().sin_cos());
        let mut quads = Vec::new();
        let mut offsets = Vec::new();
        for glyph in shaping.lines.iter().flatten() {
            if !glyph.has_bitmap {
                continue;
            }
            let metrics = glyph.metrics;
            let half_advance = f64::from(metrics.advance) / 2.0;
            let built_in = if along_line {
                offsets.push((glyph.x + half_advance) as f32);
                // `addSymbols` adds the glyph's line offset to its quad.
                [0.0, glyph.y]
            } else {
                [
                    glyph.x + half_advance + self.offset[0],
                    glyph.y + self.offset[1],
                ]
            };
            let x1 = (f64::from(metrics.left) - rect_buffer) - half_advance + built_in[0];
            let y1 = (-f64::from(metrics.top) - rect_buffer) + built_in[1];
            // Atlas bins: bitmap (with its SDF border) plus 1 px padding on each side.
            let border = 2 * GLYPH_PBF_BORDER + 2;
            let x2 = x1 + f64::from(metrics.width as i32 + border);
            let y2 = y1 + f64::from(metrics.height as i32 + border);
            let mut corners = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]];
            if let Some(angle) = angle {
                corners = corners.map(|corner| rotate_point(corner, angle));
            }
            quads.push(SymbolGlyph {
                codepoint: glyph.codepoint,
                corners: corners.map(|[x, y]| [quantize(x), quantize(y)]),
            });
        }
        (quads, offsets)
    }
}

/// Shapes one feature's `text-field` (`performSymbolLayout`).
fn feature_text(
    layer: &StyleLayer,
    feature: &MvtFeature,
    z: u8,
    glyphs: &GlyphStore,
    missing: &mut BTreeSet<(String, u32)>,
    options: &SymbolOptions<'_>,
) -> Result<Option<FeatureText>, String> {
    let tile_context = &context(feature, f64::from(z));
    let Some(text) = string_property(layer, "text-field", feature, tile_context)? else {
        return Ok(None);
    };
    let text = match layer
        .string(false, "text-transform", "none", tile_context)?
        .as_str()
    {
        "uppercase" => text.to_uppercase(),
        "lowercase" => text.to_lowercase(),
        _ => text,
    };
    let stack = match layer.value("text-font", tile_context)? {
        Some(Value::Array(fonts)) => fonts
            .iter()
            .map(|font| font.as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(","),
        _ => "Open Sans Regular,Arial Unicode MS Regular".to_owned(),
    };
    for c in text.chars() {
        if !glyphs.has_range(&stack, u32::from(c)) {
            missing.insert((stack.clone(), u32::from(c) / 256 * 256));
        }
    }
    let (layout_size, sizes) =
        feature_sizes(layer, "text-size", 16.0, feature, z, options.text_size)?;
    let anchor =
        SymbolAnchor::parse(&layer.string(false, "text-anchor", "center", tile_context)?)
            .ok_or_else(|| format!("{}: invalid text-anchor", layer.id))?;
    let text_justify = layer.string(false, "text-justify", "center", tile_context)?;
    // Text along a line is centred on its anchor.
    let justify = match text_justify.as_str() {
        _ if options.text_along_line => 0.5,
        "auto" => anchor.justification(),
        "left" => 0.0,
        "right" => 1.0,
        _ => 0.5,
    };
    let style_offset = match layer.value("text-offset", tile_context)? {
        Some(Value::Array(values)) if values.len() == 2 => [
            values[0].as_f64().unwrap_or(0.0) * ONE_EM,
            values[1].as_f64().unwrap_or(0.0) * ONE_EM,
        ],
        _ => [0.0, 0.0],
    };
    let radial = layer.number(false, "text-radial-offset", 0.0, tile_context)? * ONE_EM;
    let variable = variable_anchor_offsets(layer, radial, style_offset)?;
    // Variable anchors take their offsets at placement; otherwise the style spec leaves
    // `text-offset` with `text-radial-offset` open and MapLibre goes with the radial offset.
    let offset = if variable.is_some() {
        [0.0, 0.0]
    } else if radial != 0.0 {
        variable_anchors::radial_offset(anchor, radial)
    } else {
        style_offset
    };
    let shape_options = ShapeOptions {
        stack: &stack,
        // Line labels never wrap.
        max_width: if options.placement == SymbolPlacement::Point {
            layer.number(false, "text-max-width", 10.0, tile_context)? * ONE_EM
        } else {
            f64::INFINITY
        },
        line_height: layer.number(false, "text-line-height", 1.2, tile_context)? * ONE_EM,
        anchor,
        justify,
        spacing: layer.number(false, "text-letter-spacing", 0.0, tile_context)? * ONE_EM,
        translate: offset,
    };
    // Variable anchors shape around the centre, once per justification their anchors need
    // (`text-justify: auto`); one line reads the same under every justification.
    let mut shapings: Vec<(f64, Shaping)> = Vec::new();
    match &variable {
        Some(anchors) if !options.text_along_line => {
            let justifications: Vec<f64> = if text_justify == "auto" {
                anchors
                    .iter()
                    .map(|(anchor, _)| anchor.justification())
                    .collect()
            } else {
                vec![justify]
            };
            for justification in justifications {
                if shapings.iter().any(|(done, _)| *done == justification) {
                    continue;
                }
                let centered = ShapeOptions {
                    anchor: SymbolAnchor::Center,
                    justify: justification,
                    ..shape_options
                };
                if let Some(shaping) = shape_text(&text, glyphs, &centered) {
                    let single_line = shaping.lines.len() == 1;
                    shapings.push((justification, shaping));
                    if single_line {
                        break;
                    }
                }
            }
        }
        _ => {
            if let Some(shaping) = shape_text(&text, glyphs, &shape_options) {
                shapings.push((justify, shaping));
            }
        }
    }
    let Some((_, shaping)) = shapings.first().cloned() else {
        return Ok(None);
    };
    Ok(Some(FeatureText {
        text,
        shaping,
        justified: if shapings.len() > 1 {
            shapings
        } else {
            Vec::new()
        },
        variable,
        stack,
        layout_size,
        sizes,
        offset,
        padding: layer.number(false, "text-padding", 2.0, tile_context)?,
        rotate: layer.number(false, "text-rotate", 0.0, tile_context)?,
        paint: feature_paint(layer, "text", feature, z)?,
    }))
}

/// `getTextVariableAnchorOffset`: a label's anchors with their offsets in glyph units;
/// `radial` and `style_offset` (`text-radial-offset`, `text-offset`) are in glyph units too.
fn variable_anchor_offsets(
    layer: &StyleLayer,
    radial: f64,
    style_offset: [f64; 2],
) -> Result<Option<Vec<AnchorOffset>>, String> {
    if let Some(value) = layer.raw_layout("text-variable-anchor-offset") {
        let anchors = variable_anchors::parse_anchor_offsets(value)
            .map_err(|error| format!("{}: text-variable-anchor-offset: {error}", layer.id))?;
        return Ok(Some(variable_anchors::em_offsets_to_glyph_units(&anchors)));
    }
    let Some(value) = layer.raw_layout("text-variable-anchor") else {
        return Ok(None);
    };
    let anchors = variable_anchors::parse_anchors(value)
        .map_err(|error| format!("{}: text-variable-anchor: {error}", layer.id))?;
    let has_radial = layer.raw_layout("text-radial-offset").is_some();
    Ok(Some(
        anchors
            .into_iter()
            .map(|anchor| {
                let offset = if has_radial {
                    variable_anchors::radial_offset(anchor, radial)
                } else {
                    variable_anchors::text_offset(anchor, style_offset)
                };
                (anchor, offset)
            })
            .collect(),
    ))
}

/// Point-placement anchors of a feature (`addFeature`): its points, the first vertex of each
/// line, the pole of inaccessibility of each polygon; 8192-unit tile space.
fn point_anchors(kind: MvtGeometryType, geometry: &[Vec<[f64; 2]>]) -> Vec<[f64; 2]> {
    match kind {
        MvtGeometryType::Point => geometry.iter().flatten().copied().collect(),
        MvtGeometryType::LineString => geometry
            .iter()
            .filter_map(|line| line.first().copied())
            .collect(),
        MvtGeometryType::Polygon => {
            let rings = geometry.to_vec();
            classify_rings(&rings)
                .iter()
                .filter(|polygon| !polygon.is_empty())
                .map(|polygon| pole_of_inaccessibility(polygon, 16.0))
                .collect()
        }
    }
}

/// MapLibre's `LineBucket.addFeature` for one tile: each accepted line or polygon ring is a
/// strip with the feature's `line-cap`, `line-join` and limits, carrying its `line-color`,
/// `line-opacity`, `line-width` and `line-dasharray`. As in MapLibre, a constant dash array
/// takes round dash ends only from a constant `line-cap: round`, and a data-driven one from
/// each feature's cap.
pub fn layout_lines(layer: &StyleLayer, source: &MvtLayer, z: u8) -> Result<Vec<TileLine>, String> {
    let scale = scale(source);
    let dash_data_driven = layer.raw_paint("line-dasharray").is_some_and(|value| {
        value
            .as_array()
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .is_some_and(|op| op != "literal")
    });
    let constant_round_cap = layer.raw_layout("line-cap").and_then(Value::as_str) == Some("round");
    let mut lines = Vec::new();
    for feature in &source.features {
        if feature.geometry_type == MvtGeometryType::Point {
            continue;
        }
        let context = context(feature, f64::from(z));
        if !layer.accepts(&context)? {
            continue;
        }
        let cap = match layer.string(false, "line-cap", "butt", &context)?.as_str() {
            "round" => LineCap::Round,
            "square" => LineCap::Square,
            _ => LineCap::Butt,
        };
        let join = match layer
            .string(false, "line-join", "miter", &context)?
            .as_str()
        {
            "round" => LineJoin::Round,
            "bevel" => LineJoin::Bevel,
            _ => LineJoin::Miter,
        };
        let line_layout = LineLayout {
            cap,
            join,
            miter_limit: layer.number(false, "line-miter-limit", 2.0, &context)?,
            round_limit: layer.number(false, "line-round-limit", 1.05, &context)?,
        };
        let width = layer.number(true, "line-width", 1.0, &context)?;
        let opacity = layer.number(true, "line-opacity", 1.0, &context)?;
        let mut color = layer.color(
            "line-color",
            Rgba::parse("#000").unwrap_or(Rgba::TRANSPARENT),
            &context,
        )?;
        color.a *= opacity;
        let dasharray: Option<Vec<f64>> = layer
            .paint_value("line-dasharray", &context)?
            .and_then(|value| {
                value
                    .as_array()
                    .map(|items| items.iter().filter_map(Value::as_f64).collect())
            })
            .filter(|values: &Vec<f64>| {
                !values.is_empty()
                    && values
                        .iter()
                        .all(|value| value.is_finite() && *value >= 0.0)
            });
        // `line-pattern` (#349), evaluated per feature like `fill-pattern`: a layer with it
        // draws with MapLibre's `line_pattern` program, only the features whose image resolves.
        let pattern = match layer.raw_paint("line-pattern") {
            None => None,
            Some(_) => match layer
                .paint_value("line-pattern", &context)?
                .and_then(|value| value.as_str().map(str::to_owned))
                .filter(|id| !id.is_empty())
            {
                Some(id) => Some(id),
                None => continue,
            },
        };
        let dash = dasharray
            .filter(|_| pattern.is_none())
            .map(|dasharray| TileDash {
                dasharray,
                round: if dash_data_driven {
                    cap == LineCap::Round
                } else {
                    constant_round_cap
                },
                integer_period: dash_data_driven,
            });
        let closed = feature.geometry_type == MvtGeometryType::Polygon;
        let mut mesh = LineMesh::new();
        for path in &feature.geometry {
            let points: Vec<[f64; 2]> = path
                .iter()
                .map(|point| {
                    [
                        js_round(f64::from(point[0]) * scale),
                        js_round(f64::from(point[1]) * scale),
                    ]
                })
                .collect();
            mesh.add_line(&points, &line_layout, closed);
        }
        // `line_pattern` ignores `line-color` and culls below 0.01 `line-opacity`.
        let alpha = if pattern.is_some() { opacity } else { color.a };
        if mesh.indices.is_empty() || width <= 0.0 || alpha < 0.01 {
            continue;
        }
        lines.push(TileLine {
            mesh,
            color: color.straight(),
            width: width as f32,
            dash,
            opacity: opacity as f32,
            pattern,
        });
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn line_layer(json: &str) -> StyleLayer {
        StyleLayer::parse(&serde_json::from_str(json).unwrap()).unwrap()
    }

    fn source() -> MvtLayer {
        let feature = |kind: &str, dash: Value| MvtFeature {
            id: None,
            geometry_type: MvtGeometryType::LineString,
            geometry: vec![vec![[0, 0], [2048, 0], [2048, 2048]]],
            properties: BTreeMap::from([
                ("kind".to_owned(), Value::from(kind)),
                ("dash".to_owned(), dash),
            ]),
        };
        MvtLayer {
            name: "streets".to_owned(),
            extent: 4096,
            features: vec![
                feature("primary", serde_json::json!([3, 1.5])),
                feature("track", serde_json::json!([1, 1])),
            ],
        }
    }

    #[test]
    fn line_labels_anchor_along_their_line_with_glyph_offsets_and_zoomed_sizes() {
        let mut glyphs = GlyphStore::default();
        let pbf = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../oracle/glyphs/NotoSans-Regular/0-255.pbf"
        ))
        .unwrap();
        glyphs.add_range(
            "NotoSans-Regular",
            0,
            super::super::glyphs::parse_glyph_pbf(&pbf).unwrap(),
        );
        let layer = line_layer(
            r#"{"id":"r","type":"symbol","source-layer":"streets",
                "layout":{"symbol-placement":"line","text-field":["get","kind"],"text-font":["NotoSans-Regular"],
                          "text-size":["interpolate",["linear"],["zoom"],8,10,10,20]}}"#,
        );
        // One street across the whole tile, continued from its west edge.
        let source = MvtLayer {
            name: "streets".to_owned(),
            extent: 4096,
            features: vec![MvtFeature {
                id: None,
                geometry_type: MvtGeometryType::LineString,
                geometry: vec![vec![[0, 2048], [4096, 2048]]],
                properties: BTreeMap::from([("kind".to_owned(), Value::from("primary"))]),
            }],
        };
        let buckets = layout_tile(&[layer], &[source], 8, &glyphs, &ImageStore::default()).unwrap();
        let LayerBucket::Symbols(bucket) = &buckets.layers[0] else {
            panic!("{buckets:?}")
        };
        assert!(bucket.text_along_line && bucket.pitch_with_map && bucket.keep_upright);
        // The camera size at the drawn zoom, capped at the layout size of zoom 9.
        assert_eq!(bucket.text_size.at_zoom(8.5).size, 12.5);
        assert_eq!(bucket.text_size.at_zoom(9.5).size, 15.0);
        // Continued lines start half a `symbol-spacing` (250 px, 16 units each) in.
        let anchors: Vec<[f64; 2]> = bucket
            .instances
            .iter()
            .map(|instance| [instance.anchor[0] * EXTENT, instance.anchor[1] * EXTENT])
            .collect();
        assert_eq!(anchors, vec![[2000.0, 4096.0], [6000.0, 4096.0]]);
        let line = bucket.instances[0]
            .text
            .as_ref()
            .unwrap()
            .line
            .as_ref()
            .unwrap();
        let symbol_line = bucket.instances[0].line.as_ref().unwrap();
        assert_eq!(symbol_line.points, vec![[0.0, 4096.0], [8192.0, 4096.0]]);
        assert_eq!(symbol_line.segment, 0);
        // Seven glyphs centred on the anchor, left to right.
        assert_eq!(line.offsets.len(), 7);
        assert!(line.offsets.windows(2).all(|pair| pair[0] < pair[1]));
        assert!((line.offsets[0] + line.offsets[6]).abs() < 2.0);
        assert!(line.circle_diameter.is_some());
    }

    /// One point feature at the tile centre with a `name` property.
    fn place_source(name: &str) -> MvtLayer {
        MvtLayer {
            name: "places".to_owned(),
            extent: 4096,
            features: vec![MvtFeature {
                id: None,
                geometry_type: MvtGeometryType::Point,
                geometry: vec![vec![[2048, 2048]]],
                properties: BTreeMap::from([("name".to_owned(), Value::from(name))]),
            }],
        }
    }

    fn variable_text(layout: &str, name: &str) -> SymbolText {
        let layer = line_layer(&format!(
            r#"{{"id":"p","type":"symbol","source-layer":"places","layout":{{"text-field":["get","name"],"text-font":["NotoSans-Regular"],"text-size":24,{layout}}}}}"#
        ));
        let buckets = layout_tile(
            &[layer],
            &[place_source(name)],
            8,
            &oracle_glyphs(),
            &ImageStore::default(),
        )
        .unwrap();
        let LayerBucket::Symbols(bucket) = &buckets.layers[0] else {
            panic!("{buckets:?}")
        };
        assert!(bucket.variable_anchors || layout.contains("radial"));
        bucket.instances[0].text.clone().unwrap()
    }

    #[test]
    fn variable_anchors_centre_the_label_and_keep_offsets_for_placement() {
        let text = variable_text(
            r#""text-variable-anchor":["left","top"],"text-offset":[1,2],"text-padding":0"#,
            "Rome",
        );
        let variable = text.variable.as_ref().unwrap();
        // `fromTextOffset`: the offset magnitude towards each anchor, in glyph units.
        assert_eq!(
            variable.anchors,
            [
                (SymbolAnchor::Left, [24.0, 0.0]),
                (SymbolAnchor::Top, [0.0, 41.0]),
            ]
        );
        assert_eq!(variable.box_scale, 1.0);
        assert!(variable.justified.is_empty());
        // Centred on the anchor: no `text-offset` built in; the shift moves it at placement.
        let [x1, y1, x2, y2] = text.collision_box;
        assert!(
            (x1 + x2).abs() < 1.0 && (y1 + y2).abs() < 6.0,
            "{x1} {y1} {x2} {y2}"
        );
        // A plain label with the same offset carries it in its quads.
        let plain = variable_text(
            r#""text-offset":[1,2],"text-padding":0,"text-radial-offset":0"#,
            "Rome",
        );
        assert!(plain.variable.is_none());
        assert!(plain.collision_box[1] > text.collision_box[1] + 40.0);
    }

    #[test]
    fn anchor_offsets_take_ems_and_radial_offsets_follow_the_anchor() {
        let text = variable_text(
            r#""text-variable-anchor-offset":["top",[0,1],"right",[-2,0]]"#,
            "Rome",
        );
        assert_eq!(
            text.variable.as_ref().unwrap().anchors,
            [
                (SymbolAnchor::Top, [0.0, 17.0]),
                (SymbolAnchor::Right, [-48.0, 0.0]),
            ]
        );
        // `text-radial-offset` applies to variable anchors and to a fixed `text-anchor`.
        let variable = variable_text(
            r#""text-variable-anchor":["bottom"],"text-radial-offset":1"#,
            "Rome",
        );
        assert_eq!(
            variable.variable.as_ref().unwrap().anchors,
            [(SymbolAnchor::Bottom, [0.0, -17.0])]
        );
        let fixed = variable_text(r#""text-anchor":"left","text-radial-offset":1"#, "Rome");
        assert!(fixed.variable.is_none());
        let plain = variable_text(r#""text-anchor":"left","text-radial-offset":0"#, "Rome");
        assert!(fixed.collision_box[0] > plain.collision_box[0] + 20.0);
    }

    #[test]
    fn multi_line_auto_justified_labels_keep_one_quad_set_per_justification() {
        // Two lines of different widths: one justified set per justification of the anchors.
        let layout =
            r#""text-variable-anchor":["left","right"],"text-justify":"auto","text-max-width":3"#;
        let two_lines = variable_text(layout, "Aaaaaaaa b");
        let justified = &two_lines.variable.as_ref().unwrap().justified;
        assert_eq!(justified.len(), 2);
        assert_eq!(justified[0].0, 0.0);
        assert_eq!(justified[1].0, 1.0);
        let (left, right) = (&justified[0].1, &justified[1].1);
        assert_eq!(left.len(), right.len());
        assert_ne!(left[8].corners, right[8].corners);
        let variable = two_lines.variable.as_ref().unwrap();
        assert_eq!(
            variable.glyphs(SymbolAnchor::Left, &two_lines.glyphs),
            left.as_slice()
        );
        assert_eq!(
            variable.glyphs(SymbolAnchor::Right, &two_lines.glyphs),
            right.as_slice()
        );
        // A single line reads the same under every justification.
        let one_line = variable_text(layout, "Rome");
        assert!(one_line.variable.as_ref().unwrap().justified.is_empty());
    }

    fn oracle_glyphs() -> GlyphStore {
        let mut glyphs = GlyphStore::default();
        let pbf = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../oracle/glyphs/NotoSans-Regular/0-255.pbf"
        ))
        .unwrap();
        glyphs.add_range(
            "NotoSans-Regular",
            0,
            super::super::glyphs::parse_glyph_pbf(&pbf).unwrap(),
        );
        glyphs
    }

    /// A 20x16 stretchable `shield` and a 16x10 `arrow`.
    fn sprite() -> ImageStore {
        let mut images = ImageStore::default();
        images
            .add_sprite(
                r#"{"shield":{"x":0,"y":0,"width":20,"height":16,"pixelRatio":1,
                     "stretchX":[[4,16]],"stretchY":[[4,12]],"content":[3,3,17,13]},
                    "arrow":{"x":20,"y":0,"width":16,"height":10,"pixelRatio":1}}"#,
                &[0; 36 * 16 * 4],
                36,
                16,
            )
            .unwrap();
        images
    }

    fn one_street() -> MvtLayer {
        MvtLayer {
            name: "streets".to_owned(),
            extent: 4096,
            features: vec![MvtFeature {
                id: None,
                geometry_type: MvtGeometryType::LineString,
                geometry: vec![vec![[0, 2048], [4096, 2048]]],
                properties: BTreeMap::from([("kind".to_owned(), Value::from("primary"))]),
            }],
        }
    }

    fn symbol_bucket(json: &str) -> SymbolBucket {
        let buckets = layout_tile(
            &[line_layer(json)],
            &[one_street()],
            8,
            &oracle_glyphs(),
            &sprite(),
        )
        .unwrap();
        let LayerBucket::Symbols(bucket) = &buckets.layers[0] else {
            panic!("{buckets:?}")
        };
        (**bucket).clone()
    }

    #[test]
    fn icons_without_text_anchor_along_their_line_and_follow_it() {
        let bucket = symbol_bucket(
            r#"{"id":"a","type":"symbol","source-layer":"streets",
                "layout":{"symbol-placement":"line","icon-image":"arrow"}}"#,
        );
        assert!(bucket.icon_along_line && bucket.icon_pitch_with_map && !bucket.icon_keep_upright);
        // Icon-only labels space like text: continued lines start half a spacing in.
        let anchors: Vec<[f64; 2]> = bucket
            .instances
            .iter()
            .map(|instance| [instance.anchor[0] * EXTENT, instance.anchor[1] * EXTENT])
            .collect();
        assert_eq!(anchors, vec![[2000.0, 4096.0], [6000.0, 4096.0]]);
        let instance = &bucket.instances[0];
        assert!(instance.text.is_none());
        assert_eq!(instance.line.as_ref().unwrap().segment, 0);
        let icon = instance.icon.as_ref().unwrap();
        assert_eq!(icon.quads.len(), 1);
        assert_eq!(icon.quads[0].corners[0], [-9.0, -6.0]);
        assert_eq!(icon.quads[0].tex, [0.0, 0.0, 18.0, 12.0]);
    }

    #[test]
    fn icon_rotate_turns_the_quad_and_bounds_the_turned_collision_box() {
        let bucket = symbol_bucket(
            r#"{"id":"a","type":"symbol","source-layer":"streets",
                "layout":{"icon-image":"arrow","icon-rotate":90}}"#,
        );
        assert!(bucket.icons_rotated);
        let icon = bucket.instances[0].icon.as_ref().unwrap();
        // (x, y) turns to (-y, x).
        assert_eq!(icon.quads[0].corners[0], [6.0, -9.0]);
        assert_eq!(icon.quads[0].corners[3], [-6.0, 9.0]);
        let expected = [-7.0, -10.0, 7.0, 10.0];
        for (actual, expected) in icon.collision_box.iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-9, "{:?}", icon.collision_box);
        }
    }

    #[test]
    fn icon_text_fit_stretches_the_middle_and_keeps_the_frame() {
        let bucket = symbol_bucket(
            r#"{"id":"a","type":"symbol","source-layer":"streets",
                "layout":{"icon-image":"shield","icon-text-fit":"both","icon-text-fit-padding":[1,2,1,2],
                          "text-field":"A1","text-font":["NotoSans-Regular"],"text-size":12}}"#,
        );
        let instance = &bucket.instances[0];
        let icon = instance.icon.as_ref().unwrap();
        // One stretch zone per axis: three columns of three patches.
        assert_eq!(icon.quads.len(), 9);
        let first = &icon.quads[0];
        // The top-left corner patch: its border pixel and the fixed 4 px before the stretch
        // zone, measured from the icon's left edge (both em corners there).
        assert_eq!(first.corners[0][0], first.corners[1][0]);
        assert_eq!(first.pixel_offsets, [[-4.0, -4.0], [1.0, 1.0]]);
        assert_eq!(first.tex, [0.0, 0.0, 5.0, 5.0]);
        let last = &icon.quads[8];
        assert_eq!(last.pixel_offsets[1], [4.0, 4.0]);
        // The icon spans the text plus its padding; the content inset frames it.
        let text = instance.text.as_ref().unwrap();
        let text_width = text.collision_box[2] - text.collision_box[0] - 4.0;
        let icon_width = f64::from(last.corners[3][0] - first.corners[0][0]);
        assert!(
            (icon_width - (text_width + 4.0)).abs() < 0.1,
            "{icon_width} {text_width}"
        );
        // Two fixed content pixels per axis stay unscaled.
        assert!((f64::from(first.min_font_scale[0]) - 2.0 / icon_width).abs() < 1.0 / 256.0);
        // The collision box grows by the padding outside the content box.
        assert!(icon.collision_box[0] < f64::from(first.corners[0][0]) - 2.0);
    }

    #[test]
    fn line_layers_lay_out_strips_with_their_layout_and_dashes() {
        let layer = line_layer(
            r##"{"id":"p","type":"line","source-layer":"streets","filter":["==",["get","kind"],"primary"],
                 "layout":{"line-cap":"round","line-join":"bevel"},
                 "paint":{"line-color":"#ff0000","line-opacity":0.5,"line-width":3,"line-dasharray":[3,1.5]}}"##,
        );
        let lines = layout_lines(&layer, &source(), 8).unwrap();
        let [line] = &lines[..] else {
            panic!("{lines:?}")
        };
        assert_eq!(line.width, 3.0);
        assert_eq!(line.color, [1.0, 0.0, 0.0, 0.5]);
        assert_eq!(
            line.dash,
            Some(TileDash {
                dasharray: vec![3.0, 1.5],
                round: true,
                integer_period: false,
            })
        );
        // Tile units: the 4096 extent doubles to MapLibre's 8192.
        let max_x = line
            .mesh
            .vertices
            .iter()
            .map(|vertex| vertex.point[0])
            .fold(f64::MIN, f64::max);
        assert_eq!(max_x, 4096.0);
    }

    #[test]
    fn line_pattern_layers_keep_the_image_and_opacity_of_the_features_that_resolve_one() {
        let layer = line_layer(
            r##"{"id":"p","type":"line","source-layer":"streets",
                 "paint":{"line-pattern":["match",["get","kind"],"primary","track",""],
                          "line-opacity":0.5,"line-width":6,"line-dasharray":[3,1.5]}}"##,
        );
        let lines = layout_lines(&layer, &source(), 8).unwrap();
        // The track resolves to no image and is left out, as MapLibre leaves it undrawn.
        let [line] = &lines[..] else {
            panic!("{lines:?}")
        };
        assert_eq!(line.pattern.as_deref(), Some("track"));
        assert_eq!(line.opacity, 0.5);
        assert_eq!(line.width, 6.0);
        // `line-pattern` selects MapLibre's `line_pattern` program: no dashes.
        assert_eq!(line.dash, None);

        let plain = line_layer(r#"{"id":"s","type":"line","source-layer":"streets"}"#);
        let lines = layout_lines(&plain, &source(), 8).unwrap();
        assert!(
            lines
                .iter()
                .all(|line| line.pattern.is_none() && line.opacity == 1.0)
        );
    }

    #[test]
    fn fill_layers_triangulate_polygons_with_holes_and_outline_every_ring_edge() {
        let layer = line_layer(
            r##"{"id":"f","type":"fill","source-layer":"water",
                 "paint":{"fill-pattern":["match",["get","kind"],"glacier","hatch",""],"fill-opacity":0.5}}"##,
        );
        let polygon = |kind: &str| MvtFeature {
            id: None,
            geometry_type: MvtGeometryType::Polygon,
            geometry: vec![
                vec![[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
                vec![[25, 25], [25, 75], [75, 75], [75, 25], [25, 25]],
            ],
            properties: BTreeMap::from([("kind".to_owned(), Value::from(kind))]),
        };
        let source = MvtLayer {
            name: "water".to_owned(),
            extent: 4096,
            features: vec![polygon("glacier"), polygon("lake")],
        };
        let fills = layout_fills(&layer, &source, 8).unwrap();
        // The lake resolves to no image and is left out, as MapLibre leaves it undrawn.
        let [fill] = &fills[..] else {
            panic!("{fills:?}")
        };
        assert_eq!(fill.pattern.as_deref(), Some("hatch"));
        assert_eq!(fill.opacity, 0.5);
        assert_eq!(fill.vertices.len(), 8);
        assert_eq!(fill.vertices[2], [200.0, 200.0]);
        // A square with a square hole: eight triangles; eight edges, closing ones included.
        assert_eq!(fill.triangles.len(), 8 * 3);
        assert_eq!(fill.outline.len(), 8);
        assert_eq!(fill.outline[0], [3, 0]);
        assert_eq!(fill.outline[4], [7, 4]);
    }

    #[test]
    fn a_data_driven_dash_array_takes_round_ends_per_feature_and_an_integer_period() {
        let data_driven = line_layer(
            r#"{"id":"d","type":"line","source-layer":"streets",
                 "layout":{"line-cap":["match",["get","kind"],"track","round","butt"]},
                 "paint":{"line-dasharray":["get","dash"]}}"#,
        );
        let lines = layout_lines(&data_driven, &source(), 8).unwrap();
        let dashes: Vec<_> = lines
            .iter()
            .map(|line| line.dash.clone().unwrap())
            .collect();
        assert_eq!(
            (dashes[0].round, dashes[1].round),
            (false, true),
            "the cap per feature"
        );
        assert!(dashes.iter().all(|dash| dash.integer_period));

        // A constant dash array only sees a constant round cap.
        let constant = line_layer(
            r#"{"id":"c","type":"line","source-layer":"streets",
                 "layout":{"line-cap":["match",["get","kind"],"track","round","butt"]},
                 "paint":{"line-dasharray":[1,1]}}"#,
        );
        let lines = layout_lines(&constant, &source(), 8).unwrap();
        assert!(lines.iter().all(|line| !line.dash.as_ref().unwrap().round));
    }
}
