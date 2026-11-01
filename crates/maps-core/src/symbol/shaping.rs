//! Horizontal text shaping, ported from MapLibre 6.15 `shaping.ts` and `tagged_string.ts`:
//! least-badness line breaking at `text-max-width`, letter spacing, per-line justification,
//! anchor alignment and the `text-offset` translated bounding box. One font stack per label,
//! one code point per glyph; bidirectional, vertical and ideographic layout are not ported.

use super::glyphs::{GlyphMetrics, GlyphStore};

pub const ONE_EM: f64 = 24.0;
const SHAPING_DEFAULT_OFFSET: f64 = -17.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SymbolAnchor {
    Center,
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl SymbolAnchor {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "center" => Self::Center,
            "left" => Self::Left,
            "right" => Self::Right,
            "top" => Self::Top,
            "bottom" => Self::Bottom,
            "top-left" => Self::TopLeft,
            "top-right" => Self::TopRight,
            "bottom-left" => Self::BottomLeft,
            "bottom-right" => Self::BottomRight,
            _ => return None,
        })
    }

    /// `getAnchorAlignment`: (horizontal, vertical) in `0, 0.5, 1`.
    #[must_use]
    pub fn alignment(self) -> (f64, f64) {
        let horizontal = match self {
            Self::Right | Self::TopRight | Self::BottomRight => 1.0,
            Self::Left | Self::TopLeft | Self::BottomLeft => 0.0,
            _ => 0.5,
        };
        let vertical = match self {
            Self::Bottom | Self::BottomRight | Self::BottomLeft => 1.0,
            Self::Top | Self::TopRight | Self::TopLeft => 0.0,
            _ => 0.5,
        };
        (horizontal, vertical)
    }

    /// `getAnchorJustification` for `text-justify: auto`.
    #[must_use]
    pub fn justification(self) -> f64 {
        self.alignment().0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PositionedGlyph {
    pub codepoint: u32,
    pub x: f64,
    pub y: f64,
    pub metrics: GlyphMetrics,
    /// Whether the glyph has ink (an atlas bin); spaces only advance.
    pub has_bitmap: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shaping {
    pub lines: Vec<Vec<PositionedGlyph>>,
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}

pub struct ShapeOptions<'a> {
    pub stack: &'a str,
    pub max_width: f64,
    pub line_height: f64,
    pub anchor: SymbolAnchor,
    /// 0 left, 0.5 center, 1 right.
    pub justify: f64,
    pub spacing: f64,
    pub translate: [f64; 2],
}

fn is_whitespace(c: char) -> bool {
    // JavaScript `/\s/u`.
    c.is_whitespace() || c == '\u{feff}'
}

fn breakable(codepoint: u32) -> bool {
    matches!(
        codepoint,
        0x0a | 0x0d
            | 0x20
            | 0x26
            | 0x29
            | 0x2b
            | 0x2d
            | 0x2f
            | 0xad
            | 0xb7
            | 0x200b
            | 0x2010
            | 0x2013
            | 0x2027
    )
}

struct Break {
    index: usize,
    x: f64,
    prior: Option<usize>,
    badness: f64,
}

fn badness(line_width: f64, target_width: f64, penalty: f64, is_last: bool) -> f64 {
    let raggedness = (line_width - target_width).powi(2);
    if is_last {
        if line_width < target_width {
            raggedness / 2.0
        } else {
            raggedness * 2.0
        }
    } else {
        raggedness + penalty.abs() * penalty
    }
}

fn penalty(codepoint: u32, next: u32) -> f64 {
    let mut penalty = 0.0;
    if codepoint == 0x0a || codepoint == 0x0d {
        penalty -= 10000.0;
    }
    if codepoint == 0x28 || codepoint == 0xff08 {
        penalty += 50.0;
    }
    if next == 0x29 || next == 0xff09 {
        penalty += 50.0;
    }
    penalty
}

fn evaluate_break(
    breaks: &[Break],
    index: usize,
    x: f64,
    target_width: f64,
    penalty: f64,
    is_last: bool,
) -> Break {
    let mut prior = None;
    let mut best = badness(x, target_width, penalty, is_last);
    for (candidate, potential) in breaks.iter().enumerate() {
        let value = badness(x - potential.x, target_width, penalty, is_last) + potential.badness;
        if value <= best {
            prior = Some(candidate);
            best = value;
        }
    }
    Break {
        index,
        x,
        prior,
        badness: best,
    }
}

impl ShapeOptions<'_> {
    fn advance(&self, glyphs: &GlyphStore, c: char) -> f64 {
        glyphs
            .glyph(self.stack, u32::from(c))
            .map_or(0.0, |glyph| f64::from(glyph.metrics.advance) + self.spacing)
    }

    /// `TaggedString.determineLineBreaks`.
    fn line_breaks(&self, chars: &[char], glyphs: &GlyphStore) -> Vec<usize> {
        let total: f64 = chars.iter().map(|c| self.advance(glyphs, *c)).sum();
        let has_newline = chars.iter().any(|c| *c == '\n' || *c == '\r');
        if self.spacing >= 0.0 && total > 0.0 && total <= self.max_width && !has_newline {
            return vec![chars.len()];
        }
        let target = total / (total / self.max_width).ceil().max(1.0);
        let mut breaks: Vec<Break> = Vec::new();
        let mut x = 0.0;
        for (index, c) in chars.iter().enumerate() {
            if index > 0 {
                let previous = u32::from(chars[index - 1]);
                let codepoint = u32::from(*c);
                if breakable(previous) || (index + 1 < chars.len() && codepoint == 0x28) {
                    let next = evaluate_break(
                        &breaks,
                        index,
                        x,
                        target,
                        penalty(previous, codepoint),
                        false,
                    );
                    breaks.push(next);
                }
            }
            if !is_whitespace(*c) {
                x += self.advance(glyphs, *c);
            }
        }
        let last = evaluate_break(&breaks, chars.len(), x, target, 0.0, true);
        let mut result = vec![last.index];
        let mut prior = last.prior;
        while let Some(index) = prior {
            result.push(breaks[index].index);
            prior = breaks[index].prior;
        }
        result.reverse();
        result
    }
}

/// `shapeText` for one horizontal text section; `None` when no glyph was placed.
#[must_use]
pub fn shape_text(text: &str, glyphs: &GlyphStore, options: &ShapeOptions<'_>) -> Option<Shaping> {
    let chars: Vec<char> = text.chars().collect();
    let breaks = options.line_breaks(&chars, glyphs);
    let mut lines: Vec<&[char]> = Vec::new();
    let mut start = 0;
    for end in breaks {
        lines.push(&chars[start..end]);
        start = end;
    }
    if start < chars.len() {
        lines.push(&chars[start..]);
    }

    let mut shaping = Shaping {
        lines: Vec::new(),
        top: options.translate[1],
        bottom: options.translate[1],
        left: options.translate[0],
        right: options.translate[0],
    };
    let mut y = 0.0;
    let mut max_line_length: f64 = 0.0;
    let mut max_line_height: f64 = 0.0;
    for line in &lines {
        let trimmed_start = line
            .iter()
            .position(|c| !is_whitespace(*c))
            .unwrap_or(line.len());
        let trimmed_end = line
            .iter()
            .rposition(|c| !is_whitespace(*c))
            .map_or(trimmed_start, |end| end + 1);
        let line = &line[trimmed_start..trimmed_end];
        let mut positioned = Vec::new();
        if line.is_empty() {
            y += options.line_height;
            shaping.lines.push(positioned);
            continue;
        }
        let mut x = 0.0;
        for c in line {
            let codepoint = u32::from(*c);
            let Some(glyph) = glyphs.glyph(options.stack, codepoint) else {
                continue;
            };
            positioned.push(PositionedGlyph {
                codepoint,
                x,
                y: y + SHAPING_DEFAULT_OFFSET,
                metrics: glyph.metrics,
                has_bitmap: !glyph.bitmap.is_empty(),
            });
            x += f64::from(glyph.metrics.advance) + options.spacing;
        }
        if let Some(last) = positioned.last() {
            let line_length = x - options.spacing;
            max_line_length = max_line_length.max(line_length);
            // justifyLine
            if options.justify != 0.0 {
                let indent = (last.x + f64::from(last.metrics.advance)) * options.justify;
                for glyph in &mut positioned {
                    glyph.x -= indent;
                }
            }
        }
        y += options.line_height;
        max_line_height = max_line_height.max(options.line_height);
        shaping.lines.push(positioned);
    }
    if shaping.lines.iter().all(Vec::is_empty) {
        return None;
    }

    // align
    let (horizontal, vertical) = options.anchor.alignment();
    let shift_x = (options.justify - horizontal) * max_line_length;
    let shift_y = if max_line_height == options.line_height {
        -vertical * lines.len() as f64 * options.line_height + 0.5 * options.line_height
    } else {
        -y * vertical - SHAPING_DEFAULT_OFFSET
    };
    for glyph in shaping.lines.iter_mut().flatten() {
        glyph.x += shift_x;
        glyph.y += shift_y;
    }
    shaping.top += -vertical * y;
    shaping.bottom = shaping.top + y;
    shaping.left += -horizontal * max_line_length;
    shaping.right = shaping.left + max_line_length;
    Some(shaping)
}
