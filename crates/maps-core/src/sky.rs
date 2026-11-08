//! The style's `sky` above the horizon line, ported from MapLibre 6.16 (`style/sky.ts`,
//! `webgl/program/sky_program.ts`, `sky.fragment.glsl`).
//!
//! A style without `sky` draws nothing there: MapLibre clears the band to transparent, so the
//! page behind the map shows through. This module is the one evaluation of the sky for every
//! renderer; style-driven fog (#352) reads its `fog-color` and blends from here too.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::matrix_camera::screen_horizon_y;
use crate::symbol::color::Rgba;
use crate::symbol::expression::{EvaluationContext, evaluate};

const DEFAULT_SKY_COLOR: &str = "#88C6FC";
const DEFAULT_HORIZON_COLOR: &str = "#ffffff";
const DEFAULT_SKY_HORIZON_BLEND: f64 = 0.8;

/// The evaluated sky colors and the blend, premultiplied as MapLibre's `Color`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkyPaint {
    pub sky_color: [f32; 4],
    pub horizon_color: [f32; 4],
    pub sky_horizon_blend: f64,
}

impl SkyPaint {
    /// The paint of a style without `sky`: the transparent reset of `Sky.setSky`.
    pub const TRANSPARENT: Self = Self {
        sky_color: [0.0; 4],
        horizon_color: [0.0; 4],
        sky_horizon_blend: DEFAULT_SKY_HORIZON_BLEND,
    };
}

/// One frame's sky draw, in CSS pixels of the viewport.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkyPass {
    /// The horizon line, measured down from the viewport's top edge. Positive when it is in view.
    pub horizon_y: f64,
    /// CSS pixels above the horizon line over which the horizon color fades to the sky color.
    pub horizon_blend: f64,
    pub sky_color: [f32; 4],
    pub horizon_color: [f32; 4],
}

impl SkyPass {
    /// Whether the band draws anything but transparency.
    #[must_use]
    pub fn is_visible(&self) -> bool {
        self.sky_color[3] > 0.0 || self.horizon_color[3] > 0.0
    }
}

/// A style's `sky` block, kept unevaluated because its properties may be zoom curves.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SkyStyle {
    spec: Option<SkySpec>,
}

#[derive(Clone, Debug, PartialEq)]
struct SkySpec {
    sky_color: Value,
    horizon_color: Value,
    sky_horizon_blend: Value,
}

impl SkyStyle {
    /// Reads `{"sky": {...}}` of a MapLibre style. An empty string or an absent `sky` is no sky.
    pub fn parse(json: &str) -> Result<Self, String> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        let style: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let Some(sky) = style.get("sky").filter(|sky| !sky.is_null()) else {
            return Ok(Self::default());
        };
        let property = |name: &str, default: Value| sky.get(name).cloned().unwrap_or(default);
        let parsed = Self {
            spec: Some(SkySpec {
                sky_color: property("sky-color", Value::from(DEFAULT_SKY_COLOR)),
                horizon_color: property("horizon-color", Value::from(DEFAULT_HORIZON_COLOR)),
                sky_horizon_blend: property(
                    "sky-horizon-blend",
                    Value::from(DEFAULT_SKY_HORIZON_BLEND),
                ),
            }),
        };
        // Bad colors and expressions are rejected here, not in the frame loop.
        parsed.paint(0.0)?;
        Ok(parsed)
    }

    /// The sky at a camera zoom.
    pub fn paint(&self, zoom: f64) -> Result<SkyPaint, String> {
        let Some(spec) = &self.spec else {
            return Ok(SkyPaint::TRANSPARENT);
        };
        let properties = BTreeMap::new();
        let context = EvaluationContext {
            zoom,
            properties: &properties,
            id: None,
            geometry_type: "Point",
        };
        let color = |value: &Value| -> Result<[f32; 4], String> {
            let evaluated = evaluate(value, &context)?;
            let text = evaluated
                .as_str()
                .ok_or_else(|| format!("sky color must be a string, got {evaluated}"))?;
            Rgba::parse(text)
                .map(Rgba::premultiplied)
                .ok_or_else(|| format!("invalid sky color {text:?}"))
        };
        let blend = evaluate(&spec.sky_horizon_blend, &context)?
            .as_f64()
            .ok_or("`sky-horizon-blend` must be a number")?;
        Ok(SkyPaint {
            sky_color: color(&spec.sky_color)?,
            horizon_color: color(&spec.horizon_color)?,
            sky_horizon_blend: blend.clamp(0.0, 1.0),
        })
    }
}

/// The sky band of a camera, or `None` when the horizon line is at or above the viewport top
/// (nothing above it is in view). MapLibre's `skyUniformValues` without roll or globe.
#[must_use]
pub fn sky_pass(paint: &SkyPaint, viewport_height: f64, pitch_degrees: f64) -> Option<SkyPass> {
    let horizon_y = screen_horizon_y(viewport_height, pitch_degrees);
    (horizon_y > 0.0).then_some(SkyPass {
        horizon_y,
        horizon_blend: paint.sky_horizon_blend * viewport_height / 2.0,
        sky_color: paint.sky_color,
        horizon_color: paint.horizon_color,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matrix_camera::mercator_horizon;

    fn assert_color(actual: [f32; 4], expected: [f32; 4]) {
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < 1e-3, "{actual:?} != {expected:?}");
        }
    }

    #[test]
    fn a_style_without_sky_is_transparent() {
        for style in ["", "{}", r#"{"sky":null}"#] {
            let sky = SkyStyle::parse(style).unwrap();
            assert_eq!(sky.paint(5.0).unwrap(), SkyPaint::TRANSPARENT);
        }
        let band = sky_pass(&SkyPaint::TRANSPARENT, 480.0, 75.0).unwrap();
        assert!(!band.is_visible());
    }

    #[test]
    fn an_empty_sky_takes_the_style_spec_defaults() {
        let paint = SkyStyle::parse(r#"{"sky":{}}"#)
            .unwrap()
            .paint(5.0)
            .unwrap();
        assert_color(paint.sky_color, [0.533, 0.776, 0.988, 1.0]);
        assert_color(paint.horizon_color, [1.0, 1.0, 1.0, 1.0]);
        assert_eq!(paint.sky_horizon_blend, 0.8);
    }

    #[test]
    fn colors_are_premultiplied_and_properties_follow_the_zoom() {
        let style = SkyStyle::parse(
            r##"{"sky":{"sky-color":"rgba(255,0,0,0.5)","horizon-color":"#00ff00",
            "sky-horizon-blend":["interpolate",["linear"],["zoom"],0,0,10,1]}}"##,
        )
        .unwrap();
        let paint = style.paint(5.0).unwrap();
        assert_color(paint.sky_color, [0.5, 0.0, 0.0, 0.5]);
        assert_color(paint.horizon_color, [0.0, 1.0, 0.0, 1.0]);
        assert!((paint.sky_horizon_blend - 0.5).abs() < 1e-9);
        assert_eq!(style.paint(20.0).unwrap().sky_horizon_blend, 1.0);
    }

    #[test]
    fn invalid_values_are_rejected() {
        assert!(SkyStyle::parse("not json").is_err());
        assert!(SkyStyle::parse(r#"{"sky":{"sky-color":"nope"}}"#).is_err());
        assert!(SkyStyle::parse(r#"{"sky":{"sky-horizon-blend":"wide"}}"#).is_err());
    }

    #[test]
    fn the_band_starts_at_maplibres_horizon_line() {
        let paint = SkyPaint {
            sky_color: [0.1, 0.2, 0.3, 1.0],
            horizon_color: [1.0; 4],
            sky_horizon_blend: 0.5,
        };
        // The Mercator horizon reaches into a 480 px viewport past about 68.6° of pitch.
        assert_eq!(sky_pass(&paint, 480.0, 60.0), None);
        let band = sky_pass(&paint, 480.0, 75.0).unwrap();
        assert_eq!(band.horizon_y, 240.0 - mercator_horizon(480.0, 75.0));
        assert_eq!(band.horizon_blend, 120.0);
        assert!(band.is_visible());
        let steep = sky_pass(&paint, 480.0, 85.0).unwrap();
        assert!(steep.horizon_y > band.horizon_y);
    }
}
