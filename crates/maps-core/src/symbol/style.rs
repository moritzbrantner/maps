//! MapLibre style-specification `fill` (#323), `line` (#322), `circle` and `symbol` layers
//! drawn over a Maps Tileset.
//!
//! Layers are parsed from style JSON and validated against the properties Maps implements;
//! anything else is rejected with its name rather than silently drawn differently.

use serde_json::{Map, Value};

use super::color::Rgba;
use super::expression::{EvaluationContext, evaluate, is_expression, uses_zoom};

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
const LINE_PAINT: &[&str] = &["line-color", "line-opacity", "line-width", "line-dasharray"];
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
];
const SYMBOL_PAINT: &[&str] = &[
    "text-color",
    "text-opacity",
    "text-halo-color",
    "text-halo-width",
    "text-halo-blur",
    "icon-opacity",
    "icon-color",
    "icon-halo-color",
    "icon-halo-width",
    "icon-halo-blur",
];
/// Properties whose value must be the same at every zoom: Maps evaluates them per tile, and
/// MapLibre re-evaluates these at the camera zoom (`text-size`) or each frame (paint).
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
    "text-size",
    "circle-radius",
    "circle-color",
    "circle-opacity",
    "circle-blur",
    "circle-stroke-width",
    "circle-stroke-color",
    "circle-stroke-opacity",
    "text-color",
    "text-opacity",
    "text-halo-color",
    "text-halo-width",
    "text-halo-blur",
    "icon-size",
    "icon-opacity",
    "icon-color",
    "icon-halo-color",
    "icon-halo-width",
    "icon-halo-blur",
];

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
                if value.is_object() {
                    return Err(format!(
                        "layer {id}: legacy function for {key} is not supported"
                    ));
                }
                validate_operators(value).map_err(|error| format!("layer {id}: {key}: {error}"))?;
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
        only("symbol-placement", &["point"])?;
        only("text-rotation-alignment", &["auto", "viewport"])?;
        only("text-pitch-alignment", &["auto", "viewport"])?;
        only("icon-rotation-alignment", &["auto", "viewport"])?;
        only("icon-pitch-alignment", &["auto", "viewport"])?;
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

/// Rejects expressions with operators Maps does not evaluate. String arrays without an
/// operator head (`text-font`) are literals, and `literal` arguments are not inspected.
fn validate_operators(value: &Value) -> Result<(), String> {
    let Value::Array(items) = value else {
        return Ok(());
    };
    match items.first() {
        Some(Value::String(op)) if is_expression(value) => {
            if op == "literal" {
                return Ok(());
            }
            items[1..].iter().try_for_each(validate_operators)
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
    fn rejects_what_maps_does_not_draw() {
        let parse = |json: &str| StyleLayer::parse_all(json).map(|layers| layers.len());
        assert_eq!(
            parse(
                r#"[{"id":"a","type":"symbol","source-layer":"p","filter":["==","kind","lake"],"layout":{"text-field":"{name}","text-font":["Noto Sans"]}}]"#
            ),
            Ok(1)
        );
        for rejected in [
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"icon-image":"x","icon-text-fit":"both"}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"icon-image":"x","icon-rotate":45}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"icon-size":["interpolate",["linear"],["zoom"],5,1,10,2]}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"symbol-placement":"line"}}]"#,
            r#"[{"id":"a","type":"symbol","source-layer":"p","layout":{"text-size":["interpolate",["linear"],["zoom"],5,10,10,20]}}]"#,
            r#"[{"id":"a","type":"circle","source-layer":"p","paint":{"circle-radius":["sqrt",["get","n"]]}}]"#,
            r#"[{"id":"a","type":"fill","source-layer":"p","paint":{"fill-translate":[1,1]}}]"#,
            r#"[{"id":"a","type":"fill","source-layer":"p","paint":{"fill-pattern":["step",["zoom"],"a",9,"b"]}}]"#,
            r#"[{"id":"a","type":"fill-extrusion","source-layer":"p"}]"#,
        ] {
            assert!(parse(rejected).is_err(), "{rejected}");
        }
    }
}
