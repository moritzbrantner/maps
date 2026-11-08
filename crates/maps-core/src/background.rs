//! The constant `background-color` of a background-only MapLibre style (#170).
//!
//! This is deliberately not style evaluation: `MapView` admits only a literal color here, and
//! every renderer draws the one value this module resolves. A style with no background keeps
//! each surface's cartographic default.

use serde_json::Value;

use crate::symbol::color::Rgba;

/// The style specification's default for a `background` layer without `background-color`.
const DEFAULT_BACKGROUND_COLOR: &str = "#000000";

/// Reads `{"background-color": "<css color>"}` into premultiplied RGBA.
///
/// An empty string is no background, the surface default. A missing color is the specification
/// default. Anything but a literal CSS color string fails closed.
pub fn parse_background_color(json: &str) -> Result<Option<[f32; 4]>, String> {
    if json.trim().is_empty() {
        return Ok(None);
    }
    let style: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let value = style
        .get("background-color")
        .cloned()
        .unwrap_or_else(|| Value::from(DEFAULT_BACKGROUND_COLOR));
    let text = value
        .as_str()
        .ok_or_else(|| format!("`background-color` must be a literal color, got {value}"))?;
    Rgba::parse(text)
        .map(Rgba::premultiplied)
        .map(Some)
        .ok_or_else(|| format!("invalid `background-color` {text:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_background_keeps_the_surface_default() {
        assert_eq!(parse_background_color("").unwrap(), None);
    }

    #[test]
    fn a_constant_color_is_premultiplied() {
        let color = parse_background_color(r#"{"background-color":"rgba(255,0,0,0.5)"}"#)
            .unwrap()
            .unwrap();
        assert_eq!(color, [0.5, 0.0, 0.0, 0.5]);
    }

    #[test]
    fn a_missing_color_is_the_specification_default() {
        assert_eq!(
            parse_background_color("{}").unwrap(),
            Some([0.0, 0.0, 0.0, 1.0])
        );
    }

    #[test]
    fn expressions_zoom_functions_and_invalid_colors_fail_closed() {
        for style in [
            r##"{"background-color":["interpolate",["linear"],["zoom"],0,"#000",8,"#fff"]}"##,
            r##"{"background-color":{"stops":[[0,"#000"],[8,"#fff"]]}}"##,
            r#"{"background-color":7}"#,
            r#"{"background-color":"not-a-color"}"#,
            "{",
        ] {
            assert!(parse_background_color(style).is_err(), "accepted {style}");
        }
    }
}
