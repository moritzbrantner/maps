//! MapLibre style-specification `fill` (#323), `line` (#322), `circle` and `symbol` layers
//! drawn over a Maps Tileset.
//!
//! Layers are parsed from style JSON and validated against the properties Maps implements;
//! anything else is rejected with its name rather than silently drawn differently.

use serde_json::{Map, Value};

use super::color::Rgba;
use super::expression::{EvaluationContext, evaluate, is_expression, uses_zoom};
use super::variable_anchors;
use super::zoom::{ZoomCurve, camera_context, uses_feature};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StyleLayerKind {
    Fill,
    Line,
    Circle,
    Symbol,
}

#[derive(Clone, Debug)]
pub struct StyleLayer {
    pub id: String,
    pub kind: StyleLayerKind,
    pub source_layer: String,
    pub filter: Option<Value>,
    pub min_zoom: f64,
    pub max_zoom: f64,
    pub visible: bool,
    layout: Map<String, Value>,
    paint: Map<String, Value>,
}

const FILL_LAYOUT: &[&str] = &["visibility"];
const FILL_PAINT: &[&str] = &[
    "fill-antialias",
    "fill-opacity",
    "fill-color",
    "fill-outline-color",
    "fill-pattern",
];
const LINE_LAYOUT: &[&str] = &[
    "visibility",
    "line-cap",
    "line-join",
    "line-miter-limit",
    "line-round-limit",
];
const LINE_PAINT: &[&str] = &[
    "line-color",
    "line-opacity",
    "line-width",
    "line-dasharray",
    "line-pattern",
];
const CIRCLE_LAYOUT: &[&str] = &["visibility"];
const CIRCLE_PAINT: &[&str] = &[
    "circle-radius",
    "circle-color",
    "circle-opacity",
    "circle-blur",
    "circle-stroke-width",
    "circle-stroke-color",
    "circle-stroke-opacity",
];
const SYMBOL_LAYOUT: &[&str] = &[
    "visibility",
    "symbol-placement",
    "symbol-spacing",
    "symbol-sort-key",
    "symbol-z-order",
    "text-field",
    "text-font",
    "text-size",
    "text-max-width",
    "text-line-height",
    "text-letter-spacing",
    "text-justify",
    "text-anchor",
    "text-offset",
    "text-padding",
    "text-allow-overlap",
    "text-ignore-placement",
    "text-optional",
    "text-transform",
    "text-rotation-alignment",
    "text-pitch-alignment",
    "text-max-angle",
    "text-keep-upright",
    "text-rotate",
    "text-variable-anchor",
    "text-variable-anchor-offset",
    "text-radial-offset",
    "icon-image",
    "icon-size",
    "icon-anchor",
    "icon-offset",
    "icon-padding",
    "icon-allow-overlap",
    "icon-ignore-placement",
    "icon-optional",
    "icon-keep-upright",
    "icon-rotation-alignment",
    "icon-pitch-alignment",
    "icon-rotate",
    "icon-text-fit",
    "icon-text-fit-padding",
];
const SYMBOL_PAINT: &[&str] = &[
    "text-color",
    "text-opacity",
    "text-halo-color",
    "text-halo-width",
    "text-halo-blur",
    "text-translate",
    "text-translate-anchor",
    "icon-opacity",
    "icon-color",
    "icon-halo-color",
    "icon-halo-width",
    "icon-halo-blur",
    "icon-translate",
    "icon-translate-anchor",
];
/// Properties whose value must be the same at every zoom: Maps evaluates them per tile, and
/// MapLibre re-evaluates these each frame. Symbol sizes and paint follow the camera zoom
/// (`symbol::zoom`); other layout properties are evaluated at the tile zoom, as MapLibre's
/// worker does.
const ZOOM_CONSTANT: &[&str] = &[
    "fill-antialias",
    "fill-opacity",
    "fill-color",
    "fill-outline-color",
    "fill-pattern",
    "line-color",
    "line-opacity",
    "line-width",
    "line-dasharray",
    "line-pattern",
    "circle-radius",
    "circle-color",
    "circle-opacity",
    "circle-blur",
    "circle-stroke-width",
    "circle-stroke-color",
    "circle-stroke-opacity",
    // The style specification evaluates sort keys from feature data only.
    "symbol-sort-key",
];
/// Layout properties MapLibre reads as one value for the whole layer.
const LAYER_CONSTANT: &[&str] = &[
    "symbol-placement",
    "symbol-z-order",
    "text-rotation-alignment",
    "text-pitch-alignment",
    "icon-rotation-alignment",
    "icon-pitch-alignment",
    "text-keep-upright",
    "icon-keep-upright",
    "icon-text-fit",
    "icon-text-fit-padding",
];
/// Properties the style specification evaluates from the zoom only, never from feature data.
const FEATURE_CONSTANT: &[&str] = &[
    "text-variable-anchor",
    "text-translate",
    "text-translate-anchor",
    "icon-translate",
    "icon-translate-anchor",
];
/// Properties whose values do not interpolate: a zoom curve for them must be a `step`.
const STEPPED: &[&str] = &[
    "text-variable-anchor",
    "text-translate-anchor",
    "icon-translate-anchor",
];

/// A symbol layer's `{prefix}-rotation-alignment` and `{prefix}-pitch-alignment` as MapLibre
/// resolves `auto` (`SymbolStyleLayer.recalculate`): rotation follows the placement, pitch
/// follows the rotation.
fn resolved_alignment(layout: &Map<String, Value>, prefix: &str) -> (String, String) {
    let value = |key: String| layout.get(&key).and_then(Value::as_str).unwrap_or("auto");
    let along_line = layout
        .get("symbol-placement")
        .and_then(Value::as_str)
        .is_some_and(|placement| placement != "point");
    let rotation = match value(format!("{prefix}-rotation-alignment")) {
        "auto" if along_line => "map",
        "auto" => "viewport",
        other => other,
    };
    let pitch = match value(format!("{prefix}-pitch-alignment")) {
        "auto" if rotation == "map" => "map",
        "auto" => "viewport",
        other => other,
    };
    (rotation.to_owned(), pitch.to_owned())
}

impl StyleLayer {
    /// Parses one style layer object.
    pub fn parse(value: &Value) -> Result<Self, String> {
        let object = value.as_object().ok_or("a style layer must be an object")?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or("a style layer needs an id")?
            .to_owned();
        let kind = match object.get("type").and_then(Value::as_str) {
            Some("fill") => StyleLayerKind::Fill,
            Some("line") => StyleLayerKind::Line,
            Some("circle") => StyleLayerKind::Circle,
            Some("symbol") => StyleLayerKind::Symbol,
            other => return Err(format!("layer {id}: unsupported layer type {other:?}")),
        };
        let source_layer = object
            .get("source-layer")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("layer {id}: a source-layer is required"))?
            .to_owned();
        let section = |name: &str, allowed: &[&str]| -> Result<Map<String, Value>, String> {
            let section = match object.get(name) {
                None => Map::new(),
                Some(Value::Object(section)) => section.clone(),
                Some(_) => return Err(format!("layer {id}: {name} must be an object")),
            };
            for (key, value) in &section {
                if !allowed.contains(&key.as_str()) {
                    return Err(format!(
                        "layer {id}: {name} property {key} is not supported"
                    ));
                }
                if ZOOM_CONSTANT.contains(&key.as_str()) && uses_zoom(value) {
                    return Err(format!("layer {id}: zoom-dependent {key} is not supported"));
                }
                if LAYER_CONSTANT.contains(&key.as_str()) && is_expression(value) {
                    return Err(format!(
                        "layer {id}: an expression for {key} is not supported"
                    ));
                }
                if FEATURE_CONSTANT.contains(&key.as_str()) && uses_feature(value) {
                    return Err(format!("layer {id}: data-driven {key} is not supported"));
                }
                let curve = ZoomCurve::find(value)
                    .map_err(|error| format!("layer {id}: {key}: {error}"))?;
                if STEPPED.contains(&key.as_str())
                    && curve.is_some_and(|curve| curve.base.is_some())
                {
                    return Err(format!("layer {id}: {key} cannot be interpolated"));
                }
                if value.is_object() {
                    return Err(format!(
                        "layer {id}: legacy function for {key} is not supported"
                    ));
                }
                // A constant `[anchor, [x, y], ...]` reads like an expression but is a list.
                if key != "text-variable-anchor-offset" || is_expression(value) {
                    validate_operators(value)
                        .map_err(|error| format!("layer {id}: {key}: {error}"))?;
                }
            }
            Ok(section)
        };
        if let Some(filter) = object.get("filter") {
            validate_operators(filter).map_err(|error| format!("layer {id}: filter: {error}"))?;
        }
        let (layout_keys, paint_keys) = match kind {
            StyleLayerKind::Fill => (FILL_LAYOUT, FILL_PAINT),
            StyleLayerKind::Line => (LINE_LAYOUT, LINE_PAINT),
            StyleLayerKind::Circle => (CIRCLE_LAYOUT, CIRCLE_PAINT),
            StyleLayerKind::Symbol => (SYMBOL_LAYOUT, SYMBOL_PAINT),
        };
        let layout = section("layout", layout_keys)?;
        let paint = section("paint", paint_keys)?;
        let only = |key: &str, accepted: &[&str]| -> Result<(), String> {
            match layout.get(key).and_then(Value::as_str) {
                Some(value) if !accepted.contains(&value) => {
                    Err(format!("layer {id}: {key} {value} is not supported"))
                }
                _ => Ok(()),
            }
        };
        only("symbol-placement", &["point", "line", "line-center"])?;
        only("symbol-z-order", &["auto", "viewport-y", "source"])?;
        only(
            "text-rotation-alignment",
            &["auto", "viewport", "map", "viewport-glyph"],
        )?;
        only("text-pitch-alignment", &["auto", "viewport", "map"])?;
        only("icon-rotation-alignment", &["auto", "viewport", "map"])?;
        only("icon-pitch-alignment", &["auto", "viewport", "map"])?;
        let point = layout
            .get("symbol-placement")
            .and_then(Value::as_str)
            .is_none_or(|placement| placement == "point");
        only("icon-text-fit", &["none", "width", "height", "both"])?;
        for key in ["text-variable-anchor", "text-variable-anchor-offset"] {
            let Some(value) = layout.get(key) else {
                continue;
            };
            // Constant lists are checked here; expressions per feature at layout, where
            // MapLibre falls back to no list for a value that is not one.
            if !is_expression(value) {
                let parsed = if key == "text-variable-anchor" {
                    variable_anchors::parse_anchors(value).map(|_| ())
                } else {
                    variable_anchors::parse_anchor_offsets(value).map(|_| ())
                };
                parsed.map_err(|error| format!("layer {id}: {key}: {error}"))?;
            }
            // Variable anchors only apply to point labels.
            if !point {
                return Err(format!("layer {id}: {key} needs symbol-placement point"));
            }
        }
        // A fitted icon draws at its text's shifted anchor in the text's label plane, so it
        // must share that plane: MapLibre feeds it the other plane's coordinates otherwise.
        if (layout.contains_key("text-variable-anchor")
            || layout.contains_key("text-variable-anchor-offset"))
            && layout
                .get("icon-text-fit")
                .and_then(Value::as_str)
                .is_some_and(|fit| fit != "none")
            && resolved_alignment(&layout, "text").1 != resolved_alignment(&layout, "icon").1
        {
            return Err(format!(
                "layer {id}: icon-text-fit under variable anchors needs icons and text on the same plane"
            ));
        }
        // Translations follow the camera zoom: every stop of a zoom curve must give an
        // anchor or two numbers, as the style specification types them.
        for prefix in ["text", "icon"] {
            let anchor_key = format!("{prefix}-translate-anchor");
            for anchor in stop_values(paint.get(&anchor_key))? {
                if !matches!(anchor.as_str(), Some("map" | "viewport")) {
                    return Err(format!(
                        "layer {id}: {anchor_key} {anchor} is not supported"
                    ));
                }
            }
            let translate_key = format!("{prefix}-translate");
            for offset in stop_values(paint.get(&translate_key))? {
                if !matches!(offset.as_array().map(Vec::as_slice), Some([x, y]) if x.is_number() && y.is_number())
                {
                    return Err(format!(
                        "layer {id}: {translate_key} {offset} is not two numbers"
                    ));
                }
            }
        }
        let zoom =
            |key: &str, default: f64| object.get(key).and_then(Value::as_f64).unwrap_or(default);
        Ok(Self {
            visible: layout.get("visibility").and_then(Value::as_str) != Some("none"),
            filter: object.get("filter").cloned(),
            min_zoom: zoom("minzoom", 0.0),
            max_zoom: zoom("maxzoom", 24.0),
            id,
            kind,
            source_layer,
            layout,
            paint,
        })
    }

    /// Parses a JSON array of layers.
    pub fn parse_all(json: &str) -> Result<Vec<Self>, String> {
        let value: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        value
            .as_array()
            .ok_or("tileset layers must be an array")?
            .iter()
            .map(Self::parse)
            .collect()
    }

    pub fn accepts(&self, context: &EvaluationContext<'_>) -> Result<bool, String> {
        match &self.filter {
            None => Ok(true),
            // MapLibre: a filter that fails to evaluate excludes the feature.
            Some(filter) => Ok(evaluate(filter, context)
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false)),
        }
    }

    fn property(
        &self,
        paint: bool,
        key: &str,
        context: &EvaluationContext<'_>,
    ) -> Result<Option<Value>, String> {
        let section = if paint { &self.paint } else { &self.layout };
        // MapLibre: a value that fails to evaluate for a feature (a failed assertion, a
        // missing number) falls back to the property default. Unknown operators were
        // rejected when the layer was parsed.
        Ok(section
            .get(key)
            .and_then(|value| evaluate(value, context).ok())
            .filter(|value| !value.is_null()))
    }

    pub fn number(
        &self,
        paint: bool,
        key: &str,
        default: f64,
        context: &EvaluationContext<'_>,
    ) -> Result<f64, String> {
        Ok(self
            .property(paint, key, context)?
            .and_then(|value| value.as_f64())
            .unwrap_or(default))
    }

    pub fn string(
        &self,
        paint: bool,
        key: &str,
        default: &str,
        context: &EvaluationContext<'_>,
    ) -> Result<String, String> {
        Ok(self
            .property(paint, key, context)?
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| default.to_owned()))
    }

    pub fn boolean(
        &self,
        key: &str,
        default: bool,
        context: &EvaluationContext<'_>,
    ) -> Result<bool, String> {
        Ok(self
            .property(false, key, context)?
            .and_then(|value| value.as_bool())
            .unwrap_or(default))
    }

    pub fn color(
        &self,
        key: &str,
        default: Rgba,
        context: &EvaluationContext<'_>,
    ) -> Result<Rgba, String> {
        match self.property(true, key, context)? {
            None => Ok(default),
            Some(Value::String(text)) => Rgba::parse(&text)
                .ok_or_else(|| format!("{}: {key}: invalid color {text}", self.id)),
            Some(other) => Err(format!("{}: {key}: invalid color {other}", self.id)),
        }
    }

    /// The unevaluated paint value, e.g. to tell a data-driven `line-dasharray` from a constant.
    #[must_use]
    pub fn raw_paint(&self, key: &str) -> Option<&Value> {
        self.paint.get(key)
    }

    /// An evaluated paint value; `None` falls back to the property default.
    pub fn paint_value(
        &self,
        key: &str,
        context: &EvaluationContext<'_>,
    ) -> Result<Option<Value>, String> {
        self.property(true, key, context)
    }

    /// `{prefix}-rotation-alignment` and `{prefix}-pitch-alignment` with `auto` resolved.
    #[must_use]
    pub fn symbol_alignment(&self, prefix: &str) -> (String, String) {
        resolved_alignment(&self.layout, prefix)
    }

    /// The unevaluated layout value, e.g. to tell `{token}` strings from expressions.
    #[must_use]
    pub fn raw_layout(&self, key: &str) -> Option<&Value> {
        self.layout.get(key)
    }

    pub fn value(
        &self,
        key: &str,
        context: &EvaluationContext<'_>,
    ) -> Result<Option<Value>, String> {
        self.property(false, key, context)
    }
}

/// A feature-constant value at each stop of its zoom curve (the value itself without one).
fn stop_values(value: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let zooms = match ZoomCurve::find(value)? {
        None => vec![0.0],
        Some(curve) => curve
            .stops
            .iter()
            .map(|&stop| curve.sample_zoom(stop))
            .collect(),
    };
    zooms
        .into_iter()
        .map(|zoom| evaluate(value, &camera_context(zoom)))
        .collect()
}

/// Rejects expressions with operators Maps does not evaluate. String arrays without an
/// operator head (`text-font`) are literals, and `literal` arguments are not inspected.
fn validate_operators(value: &Value) -> Result<(), String> {
    let Value::Array(items) = value else {
        return Ok(());
    };
    match items.first() {
        Some(Value::String(op)) if is_expression(value) => {
            match op.as_str() {
                "literal" => Ok(()),
                // `["exponential", base]` names the interpolation, it is not an expression.
                "interpolate" => items.iter().skip(2).try_for_each(validate_operators),
                _ => items[1..].iter().try_for_each(validate_operators),
            }
        }
        Some(Value::String(op)) if !items.iter().all(Value::is_string) => {
            Err(format!("unsupported expression operator `{op}`"))
        }
        _ => items.iter().try_for_each(validate_operators),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_alignments_resolve_auto_from_placement_and_rotation() {
        let layer = |layout: &str| {
            StyleLayer::parse_all(&format!(
                r#"[{{"id":"a","type":"symbol","source-layer":"p","layout":{layout}}}]"#
            ))
            .map(|mut layers| layers.remove(0))
        };
        let alignment = |layout: &str, prefix: &str| {
            let (rotation, pitch) = layer(layout).unwrap().symbol_alignment(prefix);
            (rotation, pitch)
        };
        let expect = |a: &str, b: &str| (a.to_owned(), b.to_owned());
        assert_eq!(alignment("{}", "text"), expect("viewport", "viewport"));
        assert_eq!(
            alignment(r#"{"symbol-placement":"line"}"#, "text"),
            expect("map", "map")
        );
        assert_eq!(
            alignment(r#"{"text-rotation-alignment":"map"}"#, "text"),
            expect("map", "map")
        );
        assert_eq!(
            alignment(
                r#"{"text-rotation-alignment":"map","text-pitch-alignment":"viewport"}"#,
                "text"
            ),
            expect("map", "viewport")
        );
        assert_eq!(
            alignment(r#"{"text-pitch-alignment":"map"}"#, "text"),
            expect("viewport", "map")
        );
        assert_eq!(
            alignment(
                r#"{"symbol-placement":"line","text-rotation-alignment":"viewport-glyph"}"#,
                "text"
            ),
            expect("viewport-glyph", "viewport")
        );
        assert_eq!(
            alignment(r#"{"icon-rotation-alignment":"map"}"#, "icon"),
            expect("map", "map")
        );
        // `viewport-glyph` is for text only, and a fitted icon cannot leave its text's plane.
        assert!(layer(r#"{"icon-rotation-alignment":"viewport-glyph"}"#).is_err());
        assert!(
            layer(
                r#"{"icon-image":"x","icon-text-fit":"both","text-variable-anchor":["top"],"text-pitch-alignment":"map"}"#
            )
            .is_err()
        );
        assert!(
            layer(
                r#"{"icon-image":"x","icon-text-fit":"both","text-variable-anchor":["top"],"text-pitch-alignment":"map","icon-pitch-alignment":"map"}"#
            )
            .is_ok()
        );
    }

    #[test]
    fn rejects_what_maps_does_not_draw() {
        let parse = |json: &str| StyleLayer::parse_all(json).map(|layers| layers.len());
        assert_eq!(
            parse(
                r#"[{"id":"a","type":"symbol","source-layer":"p","filter":["==","kind","lake"],"layout":{"text-field":"{name}","text-font":["Noto Sans"]}}]"#
            ),
            Ok(1)
        );
        for layout in [
            r#"{"text-variable-anchor":["top","left"]}"#,
            r#"{"text-variable-anchor":["top"],"text-radial-offset":1}"#,
            r#"{"text-variable-anchor-offset":["center",[0,0],"top",[0,1]]}"#,
            r#"{"text-radial-offset":["get","r"]}"#,
            // Zoom-dependent anchors, data-driven or zoom-dependent anchor offsets (#346).
            r#"{"text-variable-anchor":["literal",["top","left"]]}"#,
            r#"{"text-variable-anchor":["step",["zoom"],["literal",["top"]],4,["literal",["left"]]]}"#,
            r#"{"text-variable-anchor-offset":["literal",["top",[0,1]]]}"#,
            r#"{"text-variable-anchor-offset":["step",["zoom"],["literal",["top",[0,1]]],4,["literal",["left",[1,0]]]]}"#,
            r#"{"text-variable-anchor-offset":["interpolate",["linear"],["zoom"],4,["literal",["top",[0,1]]],8,["literal",["top",[0,3]]]]}"#,
            r#"{"text-variable-anchor-offset":["match",["get","kind"],"city",["literal",["left",[1,0]]],["literal",["top",[0,1]]]]}"#,
        ] {
            assert_eq!(
                parse(&format!(
                    r#"[{{"id":"a","type":"symbol","source-layer":"p","layout":{layout}}}]"#
                )),
                Ok(1),
                "{layout}"
            );
        }
        for layout in [
            // Variable anchors only apply to point labels.
            r#"{"symbol-placement":"line","text-variable-anchor":["top"]}"#,
            r#"{"symbol-placement":"line-center","text-variable-anchor-offset":["top",[0,1]]}"#,
            // Malformed anchor lists.
            r#"{"text-variable-anchor":[]}"#,
            r#"{"text-variable-anchor":["middle"]}"#,
            r#"{"text-variable-anchor-offset":["top"]}"#,
            r#"{"text-variable-anchor-offset":["top",[0]]}"#,
            r#"{"symbol-placement":"line","text-variable-anchor-offset":["step",["zoom"],["literal",["top",[0,1]]],4,["literal",["left",[1,0]]]]}"#,
            // `text-variable-anchor` is not data-driven, and anchors do not interpolate.
            r#"{"text-variable-anchor":["match",["get","kind"],"city",["literal",["top"]],["literal",["left"]]]}"#,
            r#"{"text-variable-anchor":["interpolate",["linear"],["zoom"],4,["literal",["top"]],8,["literal",["left"]]]}"#,
        ] {
            assert!(
                parse(&format!(
                    r#"[{{"id":"a","type":"symbol","source-layer":"p","layout":{layout}}}]"#
                ))
                .is_err(),
                "{layout}"
            );
        }
        assert_eq!(
            parse(
                r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"symbol-placement":"line","icon-image":"x","icon-rotate":["get","r"],"icon-text-fit":"both","icon-text-fit-padding":[1,2,1,2],"text-rotate":15},"paint":{"icon-translate":[2,-1],"icon-translate-anchor":"viewport","text-translate":[0,3]}}]"#
            ),
            Ok(1)
        );
        // Exponential zoom curves.
        assert_eq!(
            parse(
                r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"text-size":["interpolate",["exponential",1.2],["zoom"],5,10,9,20]}}]"#
            ),
            Ok(1)
        );
        // Zoom-dependent translations and anchors (#346).
        assert_eq!(
            parse(
                r#"[{"id":"a","type":"symbol","source-layer":"p","paint":{"icon-translate":["literal",[1,2]],"text-translate":["interpolate",["exponential",1.5],["zoom"],5,["literal",[0,0]],9,["literal",[4,-8]]],"text-translate-anchor":["step",["zoom"],"map",7,"viewport"]}}]"#
            ),
            Ok(1)
        );
        for rejected in [
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"icon-image":"x","icon-text-fit":["step",["zoom"],"none",8,"both"]}}]"#,
            // Translations are not data-driven; their anchors do not interpolate (#346).
            r#"[{"id":"a","type":"symbol","source-layer":"p","paint":{"icon-translate":["match",["get","k"],"a",["literal",[1,2]],["literal",[0,0]]]}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","paint":{"text-translate-anchor":["match",["get","k"],"a","map","viewport"]}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","paint":{"text-translate-anchor":["interpolate",["linear"],["zoom"],4,"map",8,"viewport"]}}]"#,
            // A translation is two numbers at every zoom.
            r#"[{"id":"a","type":"symbol","source-layer":"p","paint":{"text-translate":["step",["zoom"],["literal",[1,2]],8,["literal",[1]]]}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"icon-size":["+",["zoom"],1]}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"symbol-placement":["step",["zoom"],"point",8,"line"]}}]"#,
            r#"[{"id":"a","type":"circle","source-layer":"p","paint":{"circle-radius":["sqrt",["get","n"]]}}]"#,
            r#"[{"id":"a","type":"fill","source-layer":"p","paint":{"fill-translate":[1,1]}}]"#,
            r#"[{"id":"a","type":"fill","source-layer":"p","paint":{"fill-pattern":["step",["zoom"],"a",9,"b"]}}]"#,
            r#"[{"id":"a","type":"line","source-layer":"p","paint":{"line-pattern":["step",["zoom"],"a",9,"b"]}}]"#,
            r#"[{"id":"a","type":"fill-extrusion","source-layer":"p"}]"#,
        ] {
            assert!(parse(rejected).is_err(), "{rejected}");
        }
    }

    #[test]
    fn symbol_order_takes_data_driven_sort_keys_and_a_constant_z_order() {
        let parse = |layout: &str| {
            StyleLayer::parse_all(&format!(
                r#"[{{"id":"a","type":"symbol","source-layer":"p","layout":{layout}}}]"#
            ))
        };
        for layout in [
            r#"{"symbol-sort-key":2}"#,
            r#"{"symbol-sort-key":["get","rank"]}"#,
            r#"{"symbol-sort-key":["-",0,["get","population"]]}"#,
            r#"{"symbol-z-order":"auto"}"#,
            r#"{"symbol-z-order":"viewport-y","symbol-sort-key":["get","rank"]}"#,
            r#"{"symbol-z-order":"source"}"#,
        ] {
            assert!(parse(layout).is_ok(), "{layout}");
        }
        for layout in [
            r#"{"symbol-z-order":"depth"}"#,
            r#"{"symbol-z-order":["step",["zoom"],"auto",8,"source"]}"#,
            r#"{"symbol-sort-key":["unknown-op",1]}"#,
            // The style specification takes feature data only for sort keys, as MapLibre.
            r#"{"symbol-sort-key":["interpolate",["linear"],["zoom"],4,["get","rank"],9,0]}"#,
            r#"{"symbol-sort-key":["step",["zoom"],1,8,2]}"#,
        ] {
            assert!(parse(layout).is_err(), "{layout}");
        }
    }
}
