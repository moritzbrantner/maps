//! The MapLibre style parts Maps draws for relief (#324): `raster-dem` sources, `hillshade`
//! layers and the style's `terrain`, with MapLibre 6.15's defaults.

use serde_json::Value;

use super::dem::DemEncoding;
use crate::symbol::color::Rgba;

/// A `raster` or `raster-dem` tile source the relief planner covers.
#[derive(Clone, Debug, PartialEq)]
pub struct TileSourceSpec {
    pub id: String,
    pub tile_size: f64,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// `Some` for `raster-dem`.
    pub encoding: Option<DemEncoding>,
}

/// `hillshade-method`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HillshadeMethod {
    Standard = 0,
    Combined = 1,
    Igor = 2,
    Multidirectional = 3,
    Basic = 4,
}

/// One light of a hillshade layer: direction and altitude in radians, premultiplied colors.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HillshadeLight {
    pub direction: f64,
    pub altitude: f64,
    pub shadow: [f32; 4],
    pub highlight: [f32; 4],
}

/// A `hillshade` style layer's evaluated (constant) paint.
#[derive(Clone, Debug, PartialEq)]
pub struct HillshadeLayer {
    pub id: String,
    /// Index into [`ReliefStyle::sources`].
    pub source: usize,
    pub exaggeration: f64,
    pub accent: [f32; 4],
    pub method: HillshadeMethod,
    pub viewport_anchor: bool,
    pub lights: Vec<HillshadeLight>,
    /// `resampling: nearest`.
    pub nearest: bool,
}

/// The style's `terrain`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainSpec {
    /// Index into [`ReliefStyle::sources`].
    pub source: usize,
    pub exaggeration: f64,
}

/// Raster base, DEM sources, hillshade layers and terrain of one style.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReliefStyle {
    pub sources: Vec<TileSourceSpec>,
    /// The style's raster layer source, drawn into terrain tiles under terrain.
    pub raster: Option<usize>,
    pub hillshade: Vec<HillshadeLayer>,
    pub terrain: Option<TerrainSpec>,
}

impl ReliefStyle {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.hillshade.is_empty() && self.terrain.is_none()
    }

    /// Reads `{sources, layers, terrain}` of a MapLibre style. Only the raster layer, hillshade
    /// layers and their sources are read; other layers are left to their owners.
    pub fn parse(json: &str) -> Result<Self, String> {
        let style: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let sources = style.get("sources").and_then(Value::as_object);
        let mut relief = Self::default();
        let source_index = |relief: &mut Self, id: &str| -> Result<usize, String> {
            if let Some(index) = relief.sources.iter().position(|source| source.id == id) {
                return Ok(index);
            }
            let source = sources
                .and_then(|sources| sources.get(id))
                .ok_or_else(|| format!("style source {id:?} does not exist"))?;
            let kind = source
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let number = |name: &str, default: f64| {
                source.get(name).and_then(Value::as_f64).unwrap_or(default)
            };
            let encoding = match kind {
                "raster" => None,
                "raster-dem" => Some(
                    DemEncoding::parse(
                        source.get("encoding").and_then(Value::as_str),
                        number("redFactor", 1.0),
                        number("greenFactor", 1.0),
                        number("blueFactor", 1.0),
                        number("baseShift", 0.0),
                    )
                    .ok_or_else(|| format!("source {id:?}: unsupported raster-dem encoding"))?,
                ),
                other => return Err(format!("source {id:?}: {other:?} is not a raster source")),
            };
            relief.sources.push(TileSourceSpec {
                id: id.to_owned(),
                tile_size: number("tileSize", 512.0),
                min_zoom: number("minzoom", 0.0).clamp(0.0, 24.0) as u8,
                max_zoom: number("maxzoom", 22.0).clamp(0.0, 24.0) as u8,
                encoding,
            });
            Ok(relief.sources.len() - 1)
        };

        for layer in style
            .get("layers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = layer.get("id").and_then(Value::as_str).unwrap_or_default();
            let source = layer.get("source").and_then(Value::as_str);
            match layer.get("type").and_then(Value::as_str) {
                Some("raster") => {
                    if let Some(source) = source {
                        relief.raster = Some(source_index(&mut relief, source)?);
                    }
                }
                Some("hillshade") => {
                    let source =
                        source.ok_or_else(|| format!("hillshade layer {id:?} has no source"))?;
                    let index = source_index(&mut relief, source)?;
                    if relief.sources[index].encoding.is_none() {
                        return Err(format!("hillshade layer {id:?} needs a raster-dem source"));
                    }
                    relief
                        .hillshade
                        .push(parse_hillshade(id, index, layer.get("paint"))?);
                }
                _ => {}
            }
        }
        if let Some(terrain) = style.get("terrain").filter(|terrain| !terrain.is_null()) {
            let source = terrain
                .get("source")
                .and_then(Value::as_str)
                .ok_or("terrain has no source")?;
            let index = source_index(&mut relief, source)?;
            if relief.sources[index].encoding.is_none() {
                return Err("terrain needs a raster-dem source".to_owned());
            }
            relief.terrain = Some(TerrainSpec {
                source: index,
                exaggeration: terrain
                    .get("exaggeration")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0),
            });
        }
        Ok(relief)
    }
}

fn parse_hillshade(
    id: &str,
    source: usize,
    paint: Option<&Value>,
) -> Result<HillshadeLayer, String> {
    let get = |name: &str| paint.and_then(|paint| paint.get(name));
    let unsupported = |name: &str| format!("hillshade layer {id:?}: {name} must be a constant");
    let number = |name: &str, default: f64| -> Result<f64, String> {
        get(name).map_or(Ok(default), |value| {
            value.as_f64().ok_or_else(|| unsupported(name))
        })
    };
    let numbers = |name: &str, default: f64| -> Result<Vec<f64>, String> {
        match get(name) {
            None => Ok(vec![default]),
            Some(Value::Number(number)) => Ok(vec![number.as_f64().unwrap_or(default)]),
            // A literal array; an expression starts with its operator name.
            Some(Value::Array(values))
                if values.iter().all(Value::is_number) && !values.is_empty() =>
            {
                Ok(values.iter().filter_map(Value::as_f64).collect())
            }
            Some(_) => Err(unsupported(name)),
        }
    };
    let color = |value: &Value| -> Result<[f32; 4], String> {
        value
            .as_str()
            .and_then(Rgba::parse)
            .map(Rgba::premultiplied)
            .ok_or_else(|| format!("hillshade layer {id:?}: unsupported color {value}"))
    };
    let colors = |name: &str, default: &str| -> Result<Vec<[f32; 4]>, String> {
        match get(name) {
            None => Ok(vec![color(&Value::from(default))?]),
            Some(Value::Array(values))
                if values.iter().all(Value::is_string) && !values.is_empty() =>
            {
                values.iter().map(color).collect()
            }
            Some(value) => Ok(vec![color(value)?]),
        }
    };
    let keyword = |name: &str, default: &'static str| -> Result<String, String> {
        get(name).map_or(Ok(default.to_owned()), |value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| unsupported(name))
        })
    };

    let direction = numbers("hillshade-illumination-direction", 335.0)?;
    let altitude = numbers("hillshade-illumination-altitude", 45.0)?;
    let highlight = colors("hillshade-highlight-color", "#FFFFFF")?;
    let shadow = colors("hillshade-shadow-color", "#000000")?;
    let count = direction
        .len()
        .max(altitude.len())
        .max(highlight.len())
        .max(shadow.len());
    let at = |values: &[f64], index: usize| values[index.min(values.len() - 1)];
    let lights = (0..count)
        .map(|index| HillshadeLight {
            direction: at(&direction, index).to_radians(),
            altitude: at(&altitude, index).to_radians(),
            shadow: shadow[index.min(shadow.len() - 1)],
            highlight: highlight[index.min(highlight.len() - 1)],
        })
        .collect();
    let method = match keyword("hillshade-method", "standard")?.as_str() {
        "standard" => HillshadeMethod::Standard,
        "basic" => HillshadeMethod::Basic,
        "combined" => HillshadeMethod::Combined,
        "igor" => HillshadeMethod::Igor,
        "multidirectional" => HillshadeMethod::Multidirectional,
        other => return Err(format!("hillshade layer {id:?}: unknown method {other:?}")),
    };
    Ok(HillshadeLayer {
        id: id.to_owned(),
        source,
        exaggeration: number("hillshade-exaggeration", 0.5)?,
        accent: color(get("hillshade-accent-color").unwrap_or(&Value::from("#000000")))?,
        method,
        viewport_anchor: keyword("hillshade-illumination-anchor", "viewport")? == "viewport",
        lights,
        nearest: keyword("resampling", "linear")? == "nearest",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_oracle_relief_style() {
        let style = ReliefStyle::parse(
            r##"{
              "version": 8,
              "sources": {
                "oracle": {"type": "raster", "tileSize": 256, "maxzoom": 19, "tiles": ["t"]},
                "dem-hillshade": {"type": "raster-dem", "encoding": "terrarium", "tileSize": 256, "maxzoom": 12, "tiles": ["d"]},
                "dem-terrain": {"type": "raster-dem", "encoding": "terrarium", "tileSize": 256, "maxzoom": 12, "tiles": ["d"]}
              },
              "layers": [
                {"id": "oracle-raster", "source": "oracle", "type": "raster"},
                {"id": "hillshade", "source": "dem-hillshade", "type": "hillshade",
                 "paint": {"hillshade-exaggeration": 0.6, "hillshade-shadow-color": "#3b3b3b"}}
              ],
              "terrain": {"source": "dem-terrain", "exaggeration": 1.2}
            }"##,
        )
        .unwrap();
        assert_eq!(style.sources.len(), 3);
        assert_eq!(style.raster, Some(0));
        let layer = &style.hillshade[0];
        assert_eq!(layer.exaggeration, 0.6);
        assert_eq!(layer.method, HillshadeMethod::Standard);
        assert!(layer.viewport_anchor);
        assert_eq!(layer.lights.len(), 1);
        assert!((layer.lights[0].direction - 335_f64.to_radians()).abs() < 1e-12);
        assert_eq!(style.terrain.unwrap().exaggeration, 1.2);
        assert_eq!(
            style.sources[style.terrain.unwrap().source].id,
            "dem-terrain"
        );
    }

    #[test]
    fn rejects_expressions() {
        let error = ReliefStyle::parse(
            r#"{"sources": {"d": {"type": "raster-dem"}}, "layers": [{"id": "h", "type": "hillshade",
            "source": "d", "paint": {"hillshade-exaggeration": ["get", "x"]}}]}"#,
        )
        .unwrap_err();
        assert!(error.contains("constant"), "{error}");
    }
}
