//! Per-tile buckets for tileset `fill`, `line`, `circle` and `symbol` layers: MapLibre's
//! `FillBucket` triangles and outlines (#323), `LineBucket` strips (#322), `CircleBucket`
//! points and `performSymbolLayout` point-placement symbol instances (shaped glyph quads,
//! collision boxes and evaluated paint), in MapLibre's 8192-unit tile space.

use std::collections::BTreeSet;

use earcut::Earcut;
use serde_json::Value;

use super::color::Rgba;
use super::expression::{EvaluationContext, js_round, to_string};
use super::glyphs::{GLYPH_PBF_BORDER, GlyphStore};
use super::images::ImageStore;
use super::polylabel::{classify_rings, pole_of_inaccessibility};
use super::shaping::{ONE_EM, ShapeOptions, SymbolAnchor, shape_text};
use super::style::{StyleLayer, StyleLayerKind};
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

/// The text part of a symbol.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolText {
    /// Collision box around the anchor in CSS px at perspective ratio 1 (padding included).
    pub collision_box: [f64; 4],
    pub glyphs: Vec<SymbolGlyph>,
    /// `text-size` as the shader receives it (1/128 px steps).
    pub size: f32,
    pub stack: String,
    pub paint: SymbolPaint,
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
    /// `icon-size` as the shader receives it (1/128 steps).
    pub size: f32,
    /// The image's pixel ratio: one unlike the device's makes MapLibre sample linearly.
    pub pixel_ratio: f64,
    pub paint: SymbolPaint,
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
    /// `icon-size` is the constant 1: plain icons may then sample `NEAREST`.
    pub icon_size_one: bool,
    /// MapLibre's `hasHalo` (`*-halo-width` not the constant 0) for text and icons.
    pub text_halo: bool,
    pub icon_halo: bool,
    /// `isGlyphOverlap`: negative letter spacing, or a halo width over 1 (any data-driven
    /// one): halos then draw in their own pass before the fills, per tile.
    pub text_halo_pass: bool,
    pub icon_halo_pass: bool,
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
                let instances = match features {
                    Some(source) => layout_symbols(
                        layer,
                        source,
                        z,
                        glyphs,
                        images,
                        &mut buckets.missing_glyph_ranges,
                    )?,
                    None => Vec::new(),
                };
                let sdf_icons = instances
                    .iter()
                    .find_map(|instance| instance.icon.as_ref())
                    .and_then(|icon| images.image(&icon.image))
                    .is_some_and(|image| image.sdf);
                // `constantOr`: a data-driven value has no constant.
                let constant_number = |key: &str| layer.raw_paint(key).map(Value::as_f64);
                let has_halo = |key: &str| match constant_number(key) {
                    None => false,
                    Some(width) => width != Some(0.0),
                };
                let letter_spacing = layer
                    .raw_layout("text-letter-spacing")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let halo_pass = |key: &str| {
                    letter_spacing * ONE_EM < 0.0
                        || match constant_number(key) {
                            None => false,
                            Some(width) => width.unwrap_or(f64::INFINITY) > 1.0,
                        }
                };
                LayerBucket::Symbols(SymbolBucket {
                    instances,
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
                    icon_size_one: match layer.raw_layout("icon-size") {
                        None => true,
                        Some(value) => value.as_f64() == Some(1.0),
                    },
                    text_halo: has_halo("text-halo-width"),
                    icon_halo: has_halo("icon-halo-width"),
                    text_halo_pass: halo_pass("text-halo-width"),
                    icon_halo_pass: halo_pass("icon-halo-width"),
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

fn layout_symbols(
    layer: &StyleLayer,
    source: &MvtLayer,
    z: u8,
    glyphs: &GlyphStore,
    images: &ImageStore,
    missing: &mut BTreeSet<(String, u32)>,
) -> Result<Vec<SymbolInstance>, String> {
    let scale = scale(source);
    let mut instances = Vec::new();
    for (feature_index, feature) in source.features.iter().enumerate() {
        let tile_context = context(feature, f64::from(z));
        if !layer.accepts(&tile_context)? {
            continue;
        }
        let text = symbol_text(layer, feature, &tile_context, glyphs, missing)?;
        let icon = symbol_icon(layer, feature, &tile_context, images)?;
        if text.is_none() && icon.is_none() {
            continue;
        }
        for anchor in anchors(feature, scale) {
            // addSymbolAtAnchor: neighbouring tiles own anchors in their buffers.
            if anchor[0] < 0.0 || anchor[0] >= EXTENT || anchor[1] < 0.0 || anchor[1] >= EXTENT {
                continue;
            }
            instances.push(SymbolInstance {
                anchor: [anchor[0].trunc() / EXTENT, anchor[1].trunc() / EXTENT],
                text: text.clone(),
                icon: icon.clone(),
                feature_index,
            });
        }
    }
    Ok(instances)
}

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

fn symbol_paint(
    layer: &StyleLayer,
    prefix: &str,
    context: &EvaluationContext<'_>,
) -> Result<SymbolPaint, String> {
    let key = |name: &str| format!("{prefix}-{name}");
    Ok(SymbolPaint {
        color: layer
            .color(
                &key("color"),
                Rgba::parse("#000").unwrap_or(Rgba::TRANSPARENT),
                context,
            )?
            .premultiplied(),
        halo_color: layer
            .color(&key("halo-color"), Rgba::TRANSPARENT, context)?
            .premultiplied(),
        halo_width: layer.number(true, &key("halo-width"), 0.0, context)? as f32,
        halo_blur: layer.number(true, &key("halo-blur"), 0.0, context)? as f32,
        opacity: layer.number(true, &key("opacity"), 1.0, context)? as f32,
    })
}

/// `shapeIcon`, `getIconQuads` and the icon `CollisionFeature` for one feature. An image the
/// style lacks leaves the symbol without an icon, as in MapLibre.
fn symbol_icon(
    layer: &StyleLayer,
    feature: &MvtFeature,
    context: &EvaluationContext<'_>,
    images: &ImageStore,
) -> Result<Option<SymbolIcon>, String> {
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
    // `icon-size` at the tile zoom and zoom + 1 are equal: zoom-dependent sizes are rejected.
    let size = layer.number(false, "icon-size", 1.0, context)?;
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
        size: (js_round(size * 128.0) / 128.0) as f32,
        pixel_ratio: image.pixel_ratio,
        paint: symbol_paint(layer, "icon", context)?,
    }))
}

/// Shaped glyph quads, collision box and paint of one feature's `text-field`.
fn symbol_text(
    layer: &StyleLayer,
    feature: &MvtFeature,
    tile_context: &EvaluationContext<'_>,
    glyphs: &GlyphStore,
    missing: &mut BTreeSet<(String, u32)>,
) -> Result<Option<SymbolText>, String> {
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
    // `text-size` at the tile zoom ("this zoom") and at zoom + 1 (layout); both equal
    // because zoom-dependent sizes are rejected.
    let size = layer.number(false, "text-size", 16.0, tile_context)?;
    let font_scale = size / ONE_EM;
    let anchor =
        SymbolAnchor::parse(&layer.string(false, "text-anchor", "center", tile_context)?)
            .ok_or_else(|| format!("{}: invalid text-anchor", layer.id))?;
    let justify = match layer
        .string(false, "text-justify", "center", tile_context)?
        .as_str()
    {
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
    let options = ShapeOptions {
        stack: &stack,
        max_width: layer.number(false, "text-max-width", 10.0, tile_context)? * ONE_EM,
        line_height: layer.number(false, "text-line-height", 1.2, tile_context)? * ONE_EM,
        anchor,
        justify,
        spacing: layer.number(false, "text-letter-spacing", 0.0, tile_context)? * ONE_EM,
        translate: offset,
    };
    let Some(shaping) = shape_text(&text, glyphs, &options) else {
        return Ok(None);
    };
    let padding = layer.number(false, "text-padding", 2.0, tile_context)?;
    let collision_box = [
        shaping.left * font_scale - padding,
        shaping.top * font_scale - padding,
        shaping.right * font_scale + padding,
        shaping.bottom * font_scale + padding,
    ];
    let quantize = |value: f64| (js_round(value * 32.0) / 32.0) as f32;
    let rect_buffer = f64::from(GLYPH_PBF_BORDER + 1);
    let mut quads = Vec::new();
    for glyph in shaping.lines.iter().flatten() {
        if !glyph.has_bitmap {
            continue;
        }
        let metrics = glyph.metrics;
        let half_advance = f64::from(metrics.advance) / 2.0;
        let built_in = [glyph.x + half_advance + offset[0], glyph.y + offset[1]];
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
    Ok(Some(SymbolText {
        collision_box,
        glyphs: quads,
        size: (js_round(size * 128.0) / 128.0) as f32,
        stack,
        paint: symbol_paint(layer, "text", tile_context)?,
    }))
}

/// Point-placement anchors of a feature in 8192-unit tile space (`addFeature`).
fn anchors(feature: &MvtFeature, scale: f64) -> Vec<[f64; 2]> {
    let point = |p: &[i32; 2]| {
        [
            js_round(f64::from(p[0]) * scale),
            js_round(f64::from(p[1]) * scale),
        ]
    };
    match feature.geometry_type {
        MvtGeometryType::Point => feature.geometry.iter().flatten().map(point).collect(),
        MvtGeometryType::LineString => feature
            .geometry
            .iter()
            .filter_map(|line| line.first().map(point))
            .collect(),
        MvtGeometryType::Polygon => {
            let rings: Vec<Vec<[f64; 2]>> = feature
                .geometry
                .iter()
                .map(|ring| ring.iter().map(point).collect())
                .collect();
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
