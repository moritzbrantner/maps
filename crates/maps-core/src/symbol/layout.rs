//! Per-tile buckets for tileset `circle` and `symbol` layers: MapLibre's `CircleBucket`
//! points and `performSymbolLayout` point-placement symbol instances (shaped glyph quads,
//! collision boxes and evaluated paint), in MapLibre's 8192-unit tile space.

use std::collections::BTreeSet;

use serde_json::Value;

use super::color::Rgba;
use super::expression::{EvaluationContext, js_round, to_string};
use super::glyphs::{GLYPH_PBF_BORDER, GlyphStore};
use super::polylabel::{classify_rings, pole_of_inaccessibility};
use super::shaping::{ONE_EM, ShapeOptions, SymbolAnchor, shape_text};
use super::style::{StyleLayer, StyleLayerKind};
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

#[derive(Clone, Debug, PartialEq)]
pub struct TextPaint {
    pub color: [f32; 4],
    pub halo_color: [f32; 4],
    pub halo_width: f32,
    pub halo_blur: f32,
    pub opacity: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SymbolInstance {
    /// Tile-normalized anchor, truncated to MapLibre's integer 8192-unit grid.
    pub anchor: [f64; 2],
    /// Collision box around the anchor in CSS px at perspective ratio 1 (padding included).
    pub collision_box: [f64; 4],
    pub glyphs: Vec<SymbolGlyph>,
    /// `text-size` as the shader receives it (1/128 px steps).
    pub size: f32,
    pub stack: String,
    pub paint: TextPaint,
    pub feature_index: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LayerBucket {
    Circles(Vec<TileCircle>),
    Symbols {
        instances: Vec<SymbolInstance>,
        allow_overlap: bool,
        ignore_placement: bool,
    },
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

/// Lays out every style layer for one tile at zoom `z`.
pub fn layout_tile(
    layers: &[StyleLayer],
    source: &[MvtLayer],
    z: u8,
    glyphs: &GlyphStore,
) -> Result<TileStyleBuckets, String> {
    let mut buckets = TileStyleBuckets::default();
    for layer in layers {
        let features = source
            .iter()
            .find(|candidate| candidate.name == layer.source_layer);
        let bucket = match layer.kind {
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
                LayerBucket::Symbols {
                    instances: match features {
                        Some(source) => layout_symbols(
                            layer,
                            source,
                            z,
                            glyphs,
                            &mut buckets.missing_glyph_ranges,
                        )?,
                        None => Vec::new(),
                    },
                    allow_overlap: layer.boolean("text-allow-overlap", false, &constant)?,
                    ignore_placement: layer.boolean("text-ignore-placement", false, &constant)?,
                }
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
    missing: &mut BTreeSet<(String, u32)>,
) -> Result<Vec<SymbolInstance>, String> {
    let scale = scale(source);
    let mut instances = Vec::new();
    for (feature_index, feature) in source.features.iter().enumerate() {
        let tile_context = context(feature, f64::from(z));
        if !layer.accepts(&tile_context)? {
            continue;
        }
        let text = match layer.raw_layout("text-field") {
            None => continue,
            Some(Value::String(tokens)) => resolve_tokens(tokens, feature),
            Some(_) => match layer.value("text-field", &tile_context)? {
                None | Some(Value::Null) => continue,
                Some(value) => to_string(&value),
            },
        };
        let text = match layer
            .string(false, "text-transform", "none", &tile_context)?
            .as_str()
        {
            "uppercase" => text.to_uppercase(),
            "lowercase" => text.to_lowercase(),
            _ => text,
        };
        if text.is_empty() {
            continue;
        }
        let stack = match layer.value("text-font", &tile_context)? {
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
        let size = layer.number(false, "text-size", 16.0, &tile_context)?;
        let font_scale = size / ONE_EM;
        let anchor =
            SymbolAnchor::parse(&layer.string(false, "text-anchor", "center", &tile_context)?)
                .ok_or_else(|| format!("{}: invalid text-anchor", layer.id))?;
        let justify = match layer
            .string(false, "text-justify", "center", &tile_context)?
            .as_str()
        {
            "auto" => anchor.justification(),
            "left" => 0.0,
            "right" => 1.0,
            _ => 0.5,
        };
        let offset = match layer.value("text-offset", &tile_context)? {
            Some(Value::Array(values)) if values.len() == 2 => [
                values[0].as_f64().unwrap_or(0.0) * ONE_EM,
                values[1].as_f64().unwrap_or(0.0) * ONE_EM,
            ],
            _ => [0.0, 0.0],
        };
        let options = ShapeOptions {
            stack: &stack,
            max_width: layer.number(false, "text-max-width", 10.0, &tile_context)? * ONE_EM,
            line_height: layer.number(false, "text-line-height", 1.2, &tile_context)? * ONE_EM,
            anchor,
            justify,
            spacing: layer.number(false, "text-letter-spacing", 0.0, &tile_context)? * ONE_EM,
            translate: offset,
        };
        let Some(shaping) = shape_text(&text, glyphs, &options) else {
            continue;
        };
        let padding = layer.number(false, "text-padding", 2.0, &tile_context)?;
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
        let paint = TextPaint {
            color: layer
                .color(
                    "text-color",
                    Rgba::parse("#000").unwrap_or(Rgba::TRANSPARENT),
                    &tile_context,
                )?
                .premultiplied(),
            halo_color: layer
                .color("text-halo-color", Rgba::TRANSPARENT, &tile_context)?
                .premultiplied(),
            halo_width: layer.number(true, "text-halo-width", 0.0, &tile_context)? as f32,
            halo_blur: layer.number(true, "text-halo-blur", 0.0, &tile_context)? as f32,
            opacity: layer.number(true, "text-opacity", 1.0, &tile_context)? as f32,
        };
        let packed_size = (js_round(size * 128.0) / 128.0) as f32;
        for anchor in anchors(feature, scale) {
            // addSymbolAtAnchor: neighbouring tiles own anchors in their buffers.
            if anchor[0] < 0.0 || anchor[0] >= EXTENT || anchor[1] < 0.0 || anchor[1] >= EXTENT {
                continue;
            }
            instances.push(SymbolInstance {
                anchor: [anchor[0].trunc() / EXTENT, anchor[1].trunc() / EXTENT],
                collision_box,
                glyphs: quads.clone(),
                size: packed_size,
                stack: stack.clone(),
                paint: paint.clone(),
                feature_index,
            });
        }
    }
    Ok(instances)
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
