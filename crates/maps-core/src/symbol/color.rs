//! CSS colors as the style specification accepts them: hex, `rgb[a]()`, `hsl[a]()` and the
//! named colors tileset styles commonly use.

/// Straight (not premultiplied) RGBA in `0..=1`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Rgba {
    pub const TRANSPARENT: Self = Self {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.0,
    };

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim().to_ascii_lowercase();
        if let Some(hex) = text.strip_prefix('#') {
            return parse_hex(hex);
        }
        if let Some(named) = named(&text) {
            return Some(named);
        }
        let (name, rest) = text.split_once('(')?;
        let body = rest.strip_suffix(')')?;
        let parts: Vec<&str> = body
            .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
            .filter(|part| !part.is_empty())
            .collect();
        let alpha = |index: usize| -> Option<f64> {
            parts.get(index).map_or(Some(1.0), |part| {
                part.strip_suffix('%').map_or_else(
                    || part.parse().ok(),
                    |p| p.parse::<f64>().ok().map(|v| v / 100.0),
                )
            })
        };
        match name {
            "rgb" | "rgba" if parts.len() >= 3 => {
                let channel = |part: &str| -> Option<f64> {
                    part.strip_suffix('%').map_or_else(
                        || part.parse::<f64>().ok().map(|v| v / 255.0),
                        |p| p.parse::<f64>().ok().map(|v| v / 100.0),
                    )
                };
                Some(Self {
                    r: channel(parts[0])?.clamp(0.0, 1.0),
                    g: channel(parts[1])?.clamp(0.0, 1.0),
                    b: channel(parts[2])?.clamp(0.0, 1.0),
                    a: alpha(3)?.clamp(0.0, 1.0),
                })
            }
            "hsl" | "hsla" if parts.len() >= 3 => {
                let hue = parts[0].trim_end_matches("deg").parse::<f64>().ok()?;
                let saturation = parts[1].strip_suffix('%')?.parse::<f64>().ok()? / 100.0;
                let lightness = parts[2].strip_suffix('%')?.parse::<f64>().ok()? / 100.0;
                let [r, g, b] =
                    hsl_to_rgb(hue, saturation.clamp(0.0, 1.0), lightness.clamp(0.0, 1.0));
                Some(Self {
                    r,
                    g,
                    b,
                    a: alpha(3)?.clamp(0.0, 1.0),
                })
            }
            _ => None,
        }
    }

    /// Premultiplied components, as MapLibre's `Color` and its shaders hold them.
    #[must_use]
    pub fn premultiplied(self) -> [f32; 4] {
        [
            (self.r * self.a) as f32,
            (self.g * self.a) as f32,
            (self.b * self.a) as f32,
            self.a as f32,
        ]
    }

    #[must_use]
    pub fn straight(self) -> [f32; 4] {
        [self.r as f32, self.g as f32, self.b as f32, self.a as f32]
    }

    #[must_use]
    pub fn to_css(self) -> String {
        format!(
            "rgba({},{},{},{})",
            self.r * 255.0,
            self.g * 255.0,
            self.b * 255.0,
            self.a
        )
    }
}

fn parse_hex(hex: &str) -> Option<Rgba> {
    let digits: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<_>>()?;
    let channels: Vec<f64> = match digits.len() {
        3 | 4 => digits.iter().map(|d| f64::from(d * 17) / 255.0).collect(),
        6 | 8 => digits
            .chunks(2)
            .map(|pair| f64::from(pair[0] * 16 + pair[1]) / 255.0)
            .collect(),
        _ => return None,
    };
    Some(Rgba {
        r: channels[0],
        g: channels[1],
        b: channels[2],
        a: channels.get(3).copied().unwrap_or(1.0),
    })
}

fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> [f64; 3] {
    let hue = hue.rem_euclid(360.0) / 360.0;
    let q = if lightness <= 0.5 {
        lightness * (1.0 + saturation)
    } else {
        lightness + saturation - lightness * saturation
    };
    let p = 2.0 * lightness - q;
    let channel = |t: f64| {
        let t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [
        channel(hue + 1.0 / 3.0),
        channel(hue),
        channel(hue - 1.0 / 3.0),
    ]
}

fn named(name: &str) -> Option<Rgba> {
    let hex = match name {
        "transparent" => return Some(Rgba::TRANSPARENT),
        "black" => "000000",
        "white" => "ffffff",
        "red" => "ff0000",
        "green" => "008000",
        "blue" => "0000ff",
        "yellow" => "ffff00",
        "orange" => "ffa500",
        "gray" | "grey" => "808080",
        "silver" => "c0c0c0",
        "navy" => "000080",
        "teal" => "008080",
        "purple" => "800080",
        "maroon" => "800000",
        "olive" => "808000",
        "lime" => "00ff00",
        "aqua" | "cyan" => "00ffff",
        "fuchsia" | "magenta" => "ff00ff",
        _ => return None,
    };
    parse_hex(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_style_colors() {
        assert_eq!(Rgba::parse("#fff").unwrap().r, 1.0);
        assert_eq!(
            Rgba::parse("#1e3a8a").unwrap().b,
            f64::from(0x8a_u8) / 255.0
        );
        assert_eq!(Rgba::parse("rgba(255, 0, 0, 0.5)").unwrap().a, 0.5);
        assert!((Rgba::parse("hsl(120, 100%, 50%)").unwrap().g - 1.0).abs() < 1e-9);
        assert_eq!(Rgba::parse("white").unwrap().g, 1.0);
        assert!(Rgba::parse("nonsense").is_none());
    }
}
