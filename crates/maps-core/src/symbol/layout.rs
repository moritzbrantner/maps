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
use super::images::ImageStore;
use super::line_anchors::{LabelExtent, center_anchor, clip_line, line_anchors, merge_lines};
use super::polylabel::{classify_rings, pole_of_inaccessibility};
use super::shaping::{ONE_EM, ShapeOptions, Shaping, SymbolAnchor, shape_text};
use super::style::{StyleLayer, StyleLayerKind};
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

/// One glyph quad relative to its anchor, in 1/32-quantized glyph units (`ONE_EM` = 24).
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolGlyph {
    pub codepoint: u32,
    pub tl: [f32; 2],
    pub br: [f32; 2],
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
/// projecting its glyphs each frame: MapLibre's `lineVertexArray`, `glyphOffsetArray` and
/// the placed symbol's line fields.
#[derive(Clone, Debug, PartialEq)]
pub struct LineText {
    /// The line the label follows, in 8192-unit tile space (MapLibre's `Int16` vertices).
    pub line: Vec<[f64; 2]>,
    /// The anchor lies between `line[segment]` and `line[segment + 1]`.
    pub segment: usize,
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
}

/// The icon part of a symbol: MapLibre's `shapeIcon` and `getIconQuads` without
/// `icon-text-fit`, one quad over the image and its one-pixel padding.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolIcon {
    /// The style image id; its texture rect is the image's padded bin in the atlas.
    pub image: String,
    /// Quad corners relative to the anchor in 1/32-quantized CSS px at `icon-size` 1.
    pub tl: [f32; 2],
    pub br: [f32; 2],
    /// Collision box around the anchor in CSS px at perspective ratio 1 (`icon-padding`).
    pub collision_box: [f64; 4],
    /// `icon-size` at the bucket's two size zooms, as [`SymbolText::sizes`].
    pub sizes: [f32; 2],
    /// The image's pixel ratio: one unlike the device's makes MapLibre sample linearly.
    pub pixel_ratio: f64,
    pub paint: [SymbolPaint; 2],
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
    /// Text follows its line (`text-rotation-alignment: map` off point placement).
    pub text_along_line: bool,
    /// Line labels lie on the map plane (`text-pitch-alignment: map`).
    pub pitch_with_map: bool,
    /// `text-keep-upright`.
    pub keep_upright: bool,
    /// `text-padding` in CSS px: line labels pad their collision circles with it.
    pub text_padding: f64,
    /// The layer sets `icon-offset`: MapLibre's `u_is_offset` then keeps symbol sizes off
    /// the perspective ratio.
    pub icon_offset: bool,
}

impl SymbolBucket {
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
    Symbols(SymbolBucket),
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
                let alignment = |key: &str| layer.string(false, key, "auto", &constant);
                let text_along_line = placement != SymbolPlacement::Point
                    && alignment("text-rotation-alignment")? != "viewport";
                let options = SymbolOptions {
                    placement,
                    text_along_line,
                    text_size: &text_size,
                    icon_size: &icon_size,
                };
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
                LayerBucket::Symbols(SymbolBucket {
                    instances,
                    text_size,
                    icon_size,
                    placement,
                    text_along_line,
                    pitch_with_map: text_along_line
                        && alignment("text-pitch-alignment")? != "viewport",
                    keep_upright: layer.boolean("text-keep-upright", true, &constant)?,
                    text_padding: layer.number(false, "text-padding", 2.0, &constant)?,
                    icon_offset: layer.raw_layout("icon-offset").is_some(),
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
                })
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
}

/// One feature's symbol parts before anchors: its shaped text, icon and geometry.
struct SymbolFeature {
    index: usize,
    text: Option<FeatureText>,
    icon: Option<SymbolIcon>,
    geometry: Vec<Vec<[f64; 2]>>,
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
        let icon = symbol_icon(layer, feature, z, images, options.icon_size)?;
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
            let text = symbol.text.as_ref().map(|text| {
                let line = line
                    .filter(|_| options.text_along_line)
                    .map(|(line, segment)| {
                        let line: Vec<[f64; 2]> = line
                            .iter()
                            .map(|point| [point[0].trunc(), point[1].trunc()])
                            .collect();
                        (line, segment)
                    });
                text.at_anchor(line)
            });
            instances.push(SymbolInstance {
                anchor: [anchor[0] / EXTENT, anchor[1] / EXTENT],
                text,
                icon: symbol.icon.clone(),
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
                let Some(text) = &symbol.text else {
                    continue;
                };
                let max_angle = layer
                    .number(false, "text-max-angle", 45.0, &tile_context)?
                    .to_radians();
                let extent = LabelExtent {
                    length: text.shaping.right - text.shaping.left,
                    glyph_size: ONE_EM,
                    box_scale: TILE_PIXEL_RATIO * text.max_size / ONE_EM,
                };
                if options.placement == SymbolPlacement::Line {
                    let repeat_distance = spacing / 2.0;
                    for line in clip_line(&symbol.geometry, 0.0, 0.0, EXTENT, EXTENT) {
                        for anchor in line_anchors(&line, spacing, max_angle, &extent, 1.0, EXTENT)
                        {
                            let others = compare_text.entry(text.text.clone()).or_default();
                            if others.iter().rev().any(|other| {
                                (other[0] - anchor.point[0]).hypot(other[1] - anchor.point[1])
                                    < repeat_distance
                            }) {
                                continue;
                            }
                            others.push(anchor.point);
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

/// `shapeIcon`, `getIconQuads` and the icon `CollisionFeature` for one feature. An image the
/// style lacks leaves the symbol without an icon, as in MapLibre.
fn symbol_icon(
    layer: &StyleLayer,
    feature: &MvtFeature,
    z: u8,
    images: &ImageStore,
    size_data: &SizeData,
) -> Result<Option<SymbolIcon>, String> {
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
    let (right, bottom) = (left + display[0], top + display[1]);
    // `makeBox` over the whole image: one image pixel of padding on every side.
    let quantize = |value: f64| (js_round(value * 32.0) / 32.0) as f32;
    let em = |stretch: f64, image_size: u32, icon_size: f64, origin: f64| {
        quantize(stretch / f64::from(image_size) * icon_size + origin)
    };
    let tl = [
        em(-1.0, image.width, display[0], left),
        em(-1.0, image.height, display[1], top),
    ];
    let br = [
        em(f64::from(image.width) + 1.0, image.width, display[0], left),
        em(f64::from(image.height) + 1.0, image.height, display[1], top),
    ];
    // Collision boxes take `icon-size` at the tile zoom plus one.
    let (size, sizes) = feature_sizes(layer, "icon-size", 1.0, feature, z, size_data)?;
    let padding = icon_padding(layer.value("icon-padding", context)?);
    Ok(Some(SymbolIcon {
        image: id,
        tl,
        br,
        collision_box: [
            left * size - padding[3],
            top * size - padding[0],
            right * size + padding[1],
            bottom * size + padding[2],
        ],
        sizes,
        pixel_ratio: image.pixel_ratio,
        paint: feature_paint(layer, "icon", feature, z)?,
    }))
}

/// One feature's shaped `text-field`, before it is placed at its anchors.
struct FeatureText {
    /// The transformed text (`mergeLines` and `anchorIsTooClose` compare it).
    text: String,
    shaping: Shaping,
    stack: String,
    /// `text-size` at the tile zoom plus one, which collision shapes use.
    layout_size: f64,
    /// `text-size` at zoom 18 (`textMaxSize`), which line anchors space by.
    max_size: f64,
    sizes: [f32; 2],
    /// `text-offset` in glyph units.
    offset: [f64; 2],
    padding: f64,
    paint: [SymbolPaint; 2],
}

/// Glyph quads are quantized to 1/32 units as MapLibre's vertices store them.
fn quantize(value: f64) -> f32 {
    (js_round(value * 32.0) / 32.0) as f32
}

impl FeatureText {
    /// The text at one anchor: point quads (offset built in) and a collision box, or, along
    /// its line (`getGlyphQuads` with `alongLine`), quads around each glyph's centre with
    /// those centres and a collision circle.
    fn at_anchor(&self, line: Option<(Vec<[f64; 2]>, usize)>) -> SymbolText {
        let font_scale = self.layout_size / ONE_EM;
        let along_line = line.is_some();
        let rect_buffer = f64::from(GLYPH_PBF_BORDER + 1);
        let mut quads = Vec::new();
        let mut offsets = Vec::new();
        for glyph in self.shaping.lines.iter().flatten() {
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
            quads.push(SymbolGlyph {
                codepoint: glyph.codepoint,
                tl: [quantize(x1), quantize(y1)],
                br: [quantize(x2), quantize(y2)],
            });
        }
        let shaping = &self.shaping;
        SymbolText {
            collision_box: [
                shaping.left * font_scale - self.padding,
                shaping.top * font_scale - self.padding,
                shaping.right * font_scale + self.padding,
                shaping.bottom * font_scale + self.padding,
            ],
            glyphs: quads,
            sizes: self.sizes,
            stack: self.stack.clone(),
            paint: self.paint.clone(),
            line: line.map(|(line, segment)| {
                // `CollisionFeature` along a line: a circle as tall as the text, at least
                // 10 glyph units.
                let height = shaping.bottom - shaping.top;
                LineText {
                    line,
                    segment,
                    offsets,
                    line_offset: self.offset,
                    circle_diameter: (height > 0.0).then(|| height.max(10.0) * font_scale),
                }
            }),
        }
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
    let max_size = layer.number(false, "text-size", 16.0, &context(feature, 18.0))?;
    let anchor =
        SymbolAnchor::parse(&layer.string(false, "text-anchor", "center", tile_context)?)
            .ok_or_else(|| format!("{}: invalid text-anchor", layer.id))?;
    // Text along a line is centred on its anchor.
    let justify = match layer
        .string(false, "text-justify", "center", tile_context)?
        .as_str()
    {
        _ if options.text_along_line => 0.5,
        "auto" => anchor.justification(),
        "left" => 0.0,
        "right" => 1.0,
        _ => 0.5,
    };
    let offset = match layer.value("text-offset", tile_context)? {
        Some(Value::Array(values)) if values.len() == 2 => [
            values[0].as_f64().unwrap_or(0.0) * ONE_EM,
            values[1].as_f64().unwrap_or(0.0) * ONE_EM,
        ],
        _ => [0.0, 0.0],
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
    let Some(shaping) = shape_text(&text, glyphs, &shape_options) else {
        return Ok(None);
    };
    Ok(Some(FeatureText {
        text,
        shaping,
        stack,
        layout_size,
        max_size,
        sizes,
        offset,
        padding: layer.number(false, "text-padding", 2.0, tile_context)?,
        paint: feature_paint(layer, "text", feature, z)?,
    }))
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
        let dash = dasharray.map(|dasharray| TileDash {
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
        if mesh.indices.is_empty() || width <= 0.0 || color.a < 0.01 {
            continue;
        }
        lines.push(TileLine {
            mesh,
            color: color.straight(),
            width: width as f32,
            dash,
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
        assert_eq!(line.line, vec![[0.0, 4096.0], [8192.0, 4096.0]]);
        assert_eq!(line.segment, 0);
        // Seven glyphs centred on the anchor, left to right.
        assert_eq!(line.offsets.len(), 7);
        assert!(line.offsets.windows(2).all(|pair| pair[0] < pair[1]));
        assert!((line.offsets[0] + line.offsets[6]).abs() < 2.0);
        assert!(line.circle_diameter.is_some());
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
