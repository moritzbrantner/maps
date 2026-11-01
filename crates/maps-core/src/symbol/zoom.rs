//! Zoom-dependent symbol sizes and paint (#346), ported from MapLibre 6.15: the style spec's
//! `findZoomCurve`, `symbol_size.ts` (`getSizeData`, `evaluateSizeForZoom`,
//! `evaluateSizeForFeature`) and the paint binders of `program_configuration.ts`. Buckets keep
//! what MapLibre keeps per tile (sizes at the covering stops, paint at the tile zoom and one
//! above); frames evaluate the rest at the camera zoom.

use serde_json::Value;

use super::color::Rgba;
use super::expression::{EvaluationContext, interpolation_factor, is_expression, uses_zoom};
use super::layout::SymbolPaint;
use super::shaping::ONE_EM;
use super::style::StyleLayer;

/// The zoom curve of a camera or composite function: a top-level `interpolate` or `step`
/// whose input is `["zoom"]`.
#[derive(Clone, Debug, PartialEq)]
pub struct ZoomCurve {
    /// Stop inputs; a step's first stop is `-inf`, as in MapLibre.
    pub stops: Vec<f64>,
    /// The interpolation base (1 for linear); `None` for `step`, which does not interpolate.
    pub base: Option<f64>,
}

impl ZoomCurve {
    /// `findZoomCurve`. `Ok(None)` when the value does not depend on the zoom; an error when
    /// the zoom is read anywhere but the input of a top-level curve, as MapLibre rejects it.
    pub fn find(value: &Value) -> Result<Option<Self>, String> {
        if !uses_zoom(value) {
            return Ok(None);
        }
        let misplaced = || {
            Err("\"zoom\" may only be the input of a top-level \"step\" or \"interpolate\"".into())
        };
        let Value::Array(items) = value else {
            return misplaced();
        };
        let is_zoom = |value: Option<&Value>| matches!(value, Some(Value::Array(input)) if input.len() == 1 && input[0] == "zoom");
        match items.first().and_then(Value::as_str) {
            Some("interpolate") if is_zoom(items.get(2)) => {
                let kind = items.get(1).and_then(Value::as_array);
                let base = match kind.and_then(|kind| kind.first()).and_then(Value::as_str) {
                    Some("linear") => 1.0,
                    Some("exponential") => kind
                        .and_then(|kind| kind.get(1))
                        .and_then(Value::as_f64)
                        .ok_or("exponential interpolation needs a base")?,
                    other => return Err(format!("unsupported interpolation {other:?}")),
                };
                let pairs = &items[3..];
                if pairs.len() < 2 || !pairs.len().is_multiple_of(2) {
                    return Err("`interpolate` needs stop/output pairs".into());
                }
                if pairs.chunks(2).any(|pair| uses_zoom(&pair[1])) {
                    return misplaced();
                }
                let stops = pairs
                    .chunks(2)
                    .map(|pair| {
                        pair[0]
                            .as_f64()
                            .ok_or("`interpolate` stops must be numbers")
                    })
                    .collect::<Result<_, _>>()?;
                Ok(Some(Self {
                    stops,
                    base: Some(base),
                }))
            }
            Some("step") if is_zoom(items.get(1)) => {
                let rest = &items[2..];
                if rest.len().is_multiple_of(2) {
                    return Err("`step` needs a base output and stop/output pairs".into());
                }
                if uses_zoom(&rest[0]) || rest[1..].chunks(2).any(|pair| uses_zoom(&pair[1])) {
                    return misplaced();
                }
                let mut stops = vec![f64::NEG_INFINITY];
                for pair in rest[1..].chunks(2) {
                    stops.push(pair[0].as_f64().ok_or("`step` stops must be numbers")?);
                }
                Ok(Some(Self { stops, base: None }))
            }
            _ => misplaced(),
        }
    }

    /// `Interpolate.interpolationFactor` for this curve; a step never interpolates.
    #[must_use]
    pub fn factor(&self, zoom: f64, lower: f64, upper: f64) -> f64 {
        match self.base {
            None => 0.0,
            Some(base) => {
                let t = interpolation_factor(zoom, base, lower, upper);
                if t.is_finite() { t } else { 0.0 }
            }
        }
    }
}

/// Whether a style value reads the feature (a source or composite function).
#[must_use]
pub fn uses_feature(value: &Value) -> bool {
    let Value::Array(items) = value else {
        return false;
    };
    if !is_expression(value) {
        return false;
    }
    match items[0].as_str().unwrap_or_default() {
        "literal" => false,
        "get" | "has" | "!has" | "id" | "geometry-type" | "properties" => true,
        _ => items[1..].iter().any(uses_feature),
    }
}

/// How a property varies, as MapLibre's `StylePropertyExpression.kind`.
#[derive(Clone, Debug, PartialEq)]
pub enum PropertyKind {
    Constant,
    Source,
    Camera(ZoomCurve),
    Composite(ZoomCurve),
}

impl PropertyKind {
    /// The kind of an (absent: constant default) property value.
    pub fn of(value: Option<&Value>) -> Result<Self, String> {
        let Some(value) = value else {
            return Ok(Self::Constant);
        };
        let feature = uses_feature(value);
        Ok(match (ZoomCurve::find(value)?, feature) {
            (None, false) => Self::Constant,
            (None, true) => Self::Source,
            (Some(curve), false) => Self::Camera(curve),
            (Some(curve), true) => Self::Composite(curve),
        })
    }

    /// `constantOr`: whether one value holds for every feature at a given zoom.
    #[must_use]
    pub fn is_feature_constant(&self) -> bool {
        matches!(self, Self::Constant | Self::Camera(_))
    }
}

/// MapLibre's per-bucket `SizeData` for `text-size` or `icon-size`.
#[derive(Clone, Debug, PartialEq)]
pub enum SizeData {
    Constant {
        layout_size: f64,
    },
    Source,
    Camera {
        curve: ZoomCurve,
        /// The size at each zoom stop.
        sizes: Vec<f64>,
        layout_size: f64,
    },
    /// Features keep their sizes at `min_zoom` and `max_zoom`.
    Composite {
        curve: ZoomCurve,
        min_zoom: f64,
        max_zoom: f64,
    },
}

impl Default for SizeData {
    fn default() -> Self {
        Self::Constant { layout_size: 1.0 }
    }
}

/// `{uSizeT, uSize}`: a bucket's size uniforms at the drawn zoom.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ZoomedSize {
    pub size_t: f64,
    pub size: f64,
}

/// Evaluation at a zoom MapLibre may name as `-inf` (a step's first stop).
fn finite_zoom(zoom: f64) -> f64 {
    zoom.clamp(f64::MIN, f64::MAX)
}

impl SizeData {
    /// `getSizeData` for a bucket at `tile_zoom`; `evaluate` gives the feature-less value at a
    /// zoom (camera and constant sizes only read it).
    pub fn new(
        kind: &PropertyKind,
        tile_zoom: f64,
        evaluate: impl Fn(f64) -> Result<f64, String>,
    ) -> Result<Self, String> {
        Ok(match kind {
            PropertyKind::Constant => Self::Constant {
                layout_size: evaluate(tile_zoom + 1.0)?,
            },
            PropertyKind::Source => Self::Source,
            PropertyKind::Composite(curve) => {
                let (min_zoom, max_zoom) = covering_zoom_stops(&curve.stops, tile_zoom);
                Self::Composite {
                    curve: curve.clone(),
                    min_zoom,
                    max_zoom,
                }
            }
            PropertyKind::Camera(curve) => {
                // A step's first stop is `-inf`: its base value is sampled below the second.
                let sizes = curve
                    .stops
                    .iter()
                    .map(|stop| {
                        let zoom = if *stop == f64::NEG_INFINITY {
                            curve.stops.get(1).copied().unwrap_or(0.0) - 1.0
                        } else {
                            *stop
                        };
                        evaluate(zoom)
                    })
                    .collect::<Result<_, _>>()?;
                Self::Camera {
                    curve: curve.clone(),
                    sizes,
                    layout_size: evaluate(tile_zoom + 1.0)?,
                }
            }
        })
    }

    /// The zooms a feature's two sizes are evaluated at (composite sizes only).
    #[must_use]
    pub fn feature_zooms(&self) -> Option<[f64; 2]> {
        match self {
            Self::Composite {
                min_zoom, max_zoom, ..
            } => Some([finite_zoom(*min_zoom), finite_zoom(*max_zoom)]),
            _ => None,
        }
    }

    /// `evaluateSizeForZoom`. Camera sizes are capped at the layout size the tile's
    /// collision boxes were built for.
    #[must_use]
    pub fn at_zoom(&self, zoom: f64) -> ZoomedSize {
        match self {
            Self::Constant { layout_size } => ZoomedSize {
                size_t: 0.0,
                size: *layout_size,
            },
            Self::Source => ZoomedSize::default(),
            Self::Camera {
                curve,
                sizes,
                layout_size,
            } => {
                let stops = &curve.stops;
                let mut lower = stops.len() - 1;
                while lower > 0 && stops[lower] > zoom {
                    lower -= 1;
                }
                let upper = (lower + 1).min(stops.len() - 1);
                let t = curve
                    .factor(zoom, stops[lower], stops[upper])
                    .clamp(0.0, 1.0);
                ZoomedSize {
                    size_t: 0.0,
                    size: (sizes[lower] * (1.0 - t) + sizes[upper] * t).min(*layout_size),
                }
            }
            Self::Composite {
                curve,
                min_zoom,
                max_zoom,
            } => ZoomedSize {
                size_t: curve.factor(zoom, *min_zoom, *max_zoom).clamp(0.0, 1.0),
                size: 0.0,
            },
        }
    }

    /// `evaluateSizeForFeature`: `sizes` are the feature's (packed) sizes at the bucket's two
    /// zooms (the same size twice for source sizes).
    #[must_use]
    pub fn for_feature(&self, zoomed: ZoomedSize, sizes: [f32; 2]) -> f64 {
        match self {
            Self::Source => f64::from(sizes[0]),
            Self::Composite { .. } => {
                let (lower, upper) = (f64::from(sizes[0]), f64::from(sizes[1]));
                lower + (upper - lower) * zoomed.size_t
            }
            _ => zoomed.size,
        }
    }
}

/// `getCoveringZoomStops`: the pair of stops covering `[tile_zoom, tile_zoom + 1]`.
fn covering_zoom_stops(stops: &[f64], tile_zoom: f64) -> (f64, f64) {
    let mut lower = 0;
    while lower < stops.len() && stops[lower] <= tile_zoom {
        lower += 1;
    }
    let lower = lower.saturating_sub(1);
    let mut upper = lower;
    while upper < stops.len() && stops[upper] < tile_zoom + 1.0 {
        upper += 1;
    }
    let upper = upper.min(stops.len() - 1);
    (stops[lower], stops[upper])
}

/// A size as the shader receives it: `SIZE_PACK_FACTOR` (128) steps, capped at 255 px.
#[must_use]
pub fn packed_size(size: f64) -> f32 {
    ((size * 128.0).round().min(255.0 * 128.0) / 128.0) as f32
}

/// One symbol paint property at the drawn zoom: a feature's value at the tile zoom mixed
/// toward its value one zoom above (`Mix(0)` for constant and source values), or the camera
/// function's value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Zoomed<T> {
    Mix(f32),
    Value(T),
}

/// The `text-*` or `icon-*` paint of a layer at the drawn zoom (MapLibre's paint binders).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ZoomedPaint {
    color: Zoomed<[f32; 4]>,
    halo_color: Zoomed<[f32; 4]>,
    halo_width: Zoomed<f32>,
    halo_blur: Zoomed<f32>,
    opacity: Zoomed<f32>,
}

fn probe_properties() -> &'static std::collections::BTreeMap<String, Value> {
    static EMPTY: std::sync::OnceLock<std::collections::BTreeMap<String, Value>> =
        std::sync::OnceLock::new();
    EMPTY.get_or_init(Default::default)
}

/// The context of a feature-constant value at `zoom`.
#[must_use]
pub fn camera_context(zoom: f64) -> EvaluationContext<'static> {
    EvaluationContext {
        zoom,
        properties: probe_properties(),
        id: None,
        geometry_type: "Point",
    }
}

/// The paint of a symbol part, evaluated in one context; colors premultiplied.
pub fn symbol_paint(
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

impl ZoomedPaint {
    /// `prefix` paint of `layer` at the camera `zoom` for a bucket laid out at `tile_zoom`.
    pub fn new(
        layer: &StyleLayer,
        prefix: &str,
        zoom: f64,
        tile_zoom: f64,
    ) -> Result<Self, String> {
        let camera = symbol_paint(layer, prefix, &camera_context(zoom))?;
        let zoomed = |name: &str| -> Result<Zoomed<()>, String> {
            Ok(
                match PropertyKind::of(layer.raw_paint(&format!("{prefix}-{name}")))? {
                    PropertyKind::Constant | PropertyKind::Source => Zoomed::Mix(0.0),
                    PropertyKind::Camera(_) => Zoomed::Value(()),
                    // `CompositeExpressionBinder`: between the tile zoom and one above.
                    PropertyKind::Composite(curve) => Zoomed::Mix(
                        curve
                            .factor(zoom, tile_zoom, tile_zoom + 1.0)
                            .clamp(0.0, 1.0) as f32,
                    ),
                },
            )
        };
        let with = |zoomed: Zoomed<()>, value| match zoomed {
            Zoomed::Mix(t) => Zoomed::Mix(t),
            Zoomed::Value(()) => Zoomed::Value(value),
        };
        let with4 = |zoomed: Zoomed<()>, value: [f32; 4]| match zoomed {
            Zoomed::Mix(t) => Zoomed::Mix(t),
            Zoomed::Value(()) => Zoomed::Value(value),
        };
        Ok(Self {
            color: with4(zoomed("color")?, camera.color),
            halo_color: with4(zoomed("halo-color")?, camera.halo_color),
            halo_width: with(zoomed("halo-width")?, camera.halo_width),
            halo_blur: with(zoomed("halo-blur")?, camera.halo_blur),
            opacity: with(zoomed("opacity")?, camera.opacity),
        })
    }

    /// A feature's paint at the drawn zoom from its paint at the tile zoom and one above.
    #[must_use]
    pub fn resolve(&self, paint: &[SymbolPaint; 2]) -> SymbolPaint {
        let [lower, upper] = paint;
        let number = |zoomed: Zoomed<f32>, a: f32, b: f32| match zoomed {
            Zoomed::Mix(t) => a + (b - a) * t,
            Zoomed::Value(value) => value,
        };
        let color = |zoomed: Zoomed<[f32; 4]>, a: [f32; 4], b: [f32; 4]| match zoomed {
            Zoomed::Mix(t) => std::array::from_fn(|index| a[index] + (b[index] - a[index]) * t),
            Zoomed::Value(value) => value,
        };
        SymbolPaint {
            color: color(self.color, lower.color, upper.color),
            halo_color: color(self.halo_color, lower.halo_color, upper.halo_color),
            halo_width: number(self.halo_width, lower.halo_width, upper.halo_width),
            halo_blur: number(self.halo_blur, lower.halo_blur, upper.halo_blur),
            opacity: number(self.opacity, lower.opacity, upper.opacity),
        }
    }
}

/// What `drawSymbols` and `drawLayerSymbols` read off a symbol layer at the drawn zoom.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SymbolDrawState {
    pub text: ZoomedPaint,
    pub icon: ZoomedPaint,
    /// `*-opacity` is the constant 0 at this zoom: the part is not drawn.
    pub text_hidden: bool,
    pub icon_hidden: bool,
    /// `hasHalo`: `*-halo-width` is not the constant 0.
    pub text_halo: bool,
    pub icon_halo: bool,
    /// `isGlyphOverlap`: negative letter spacing, or a halo width over 1 (any data-driven
    /// one): halos then draw in their own pass before the fills, per tile.
    pub text_halo_pass: bool,
    pub icon_halo_pass: bool,
    /// `icon-size` is the constant 1: plain icons may then sample `NEAREST`.
    pub icon_size_one: bool,
}

impl SymbolDrawState {
    pub fn new(layer: &StyleLayer, zoom: f64, tile_zoom: f64) -> Result<Self, String> {
        let context = camera_context(zoom);
        // `constantOr`: the value at this zoom when every feature shares it.
        let constant = |paint: bool, key: &str, default: f64| -> Result<Option<f64>, String> {
            let raw = if paint {
                layer.raw_paint(key)
            } else {
                layer.raw_layout(key)
            };
            Ok(if PropertyKind::of(raw)?.is_feature_constant() {
                Some(layer.number(paint, key, default, &context)?)
            } else {
                None
            })
        };
        let letter_spacing = constant(false, "text-letter-spacing", 0.0)?.unwrap_or(0.0);
        let has_halo = |key: &str| -> Result<bool, String> {
            Ok(constant(true, key, 0.0)?.is_none_or(|width| width != 0.0))
        };
        let halo_pass = |key: &str| -> Result<bool, String> {
            Ok(letter_spacing * ONE_EM < 0.0
                || constant(true, key, 0.0)?.unwrap_or(f64::INFINITY) > 1.0)
        };
        Ok(Self {
            text: ZoomedPaint::new(layer, "text", zoom, tile_zoom)?,
            icon: ZoomedPaint::new(layer, "icon", zoom, tile_zoom)?,
            text_hidden: constant(true, "text-opacity", 1.0)? == Some(0.0),
            icon_hidden: constant(true, "icon-opacity", 1.0)? == Some(0.0),
            text_halo: has_halo("text-halo-width")?,
            icon_halo: has_halo("icon-halo-width")?,
            text_halo_pass: halo_pass("text-halo-width")?,
            icon_halo_pass: halo_pass("icon-halo-width")?,
            icon_size_one: constant(false, "icon-size", 1.0)? == Some(1.0),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn camera_sizes_interpolate_at_the_drawn_zoom_capped_at_the_layout_size() {
        let value = json!(["interpolate", ["linear"], ["zoom"], 5, 10, 10, 20]);
        let kind = PropertyKind::of(Some(&value)).unwrap();
        let curve = ZoomCurve::find(&value).unwrap().unwrap();
        assert!(matches!(kind, PropertyKind::Camera(_)));
        let size = |zoom: f64| 10.0 + 2.0 * (zoom - 5.0).clamp(0.0, 5.0);
        let data = SizeData::new(&kind, 7.0, |zoom| Ok(size(zoom))).unwrap();
        assert_eq!(
            data,
            SizeData::Camera {
                curve,
                sizes: vec![10.0, 20.0],
                layout_size: 16.0,
            }
        );
        assert!((data.at_zoom(7.5).size - 15.0).abs() < 1e-9);
        // Over zoom 8 the tile's collision boxes would be too small: the size stops at them.
        assert_eq!(data.at_zoom(9.0).size, 16.0);
    }

    #[test]
    fn composite_sizes_blend_the_covering_stops() {
        let value = json!([
            "interpolate",
            ["linear"],
            ["zoom"],
            6,
            ["get", "a"],
            8,
            ["get", "b"],
            12,
            1
        ]);
        let kind = PropertyKind::of(Some(&value)).unwrap();
        let data = SizeData::new(&kind, 7.0, |_| unreachable!()).unwrap();
        assert_eq!(data.feature_zooms(), Some([6.0, 8.0]));
        let zoomed = data.at_zoom(7.5);
        assert!((zoomed.size_t - 0.75).abs() < 1e-9);
        assert!((data.for_feature(zoomed, [10.0, 14.0]) - 13.0).abs() < 1e-6);
    }

    #[test]
    fn zoom_reads_only_as_the_input_of_a_top_level_curve() {
        assert!(ZoomCurve::find(&json!(["+", ["zoom"], 1])).is_err());
        assert!(
            ZoomCurve::find(&json!([
                "interpolate",
                ["linear"],
                ["get", "n"],
                1,
                ["zoom"],
                2,
                3
            ]))
            .is_err()
        );
        let step = ZoomCurve::find(&json!(["step", ["zoom"], 1, 8, 2]))
            .unwrap()
            .unwrap();
        assert_eq!(step.stops, vec![f64::NEG_INFINITY, 8.0]);
        assert_eq!(step.base, None);
        assert_eq!(
            PropertyKind::of(Some(&json!(["get", "n"]))).unwrap(),
            PropertyKind::Source
        );
    }
}
