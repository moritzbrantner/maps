//! `text-variable-anchor`, `text-variable-anchor-offset` and `text-radial-offset`, ported from
//! MapLibre 6.16 `variable_text_anchor.ts`: each anchor's offset in glyph units, and the shift
//! a placed anchor gives its label (`calculateVariableLayoutShift` for collision,
//! `calculateVariableRenderShift` for drawing).

use serde_json::Value;

use super::shaping::{ONE_EM, SymbolAnchor};

/// The baseline correction MapLibre assumes for labels above or below their anchor
/// (`ONE_EM - 17`, shaping's `yOffset`).
const BASELINE_OFFSET: f64 = 7.0;

/// One anchor a label may take, with its offset.
pub type AnchorOffset = (SymbolAnchor, [f64; 2]);

/// `evaluateVariableOffset` with a radial offset in glyph units (`fromRadialOffset`).
#[must_use]
pub fn radial_offset(anchor: SymbolAnchor, radial: f64) -> [f64; 2] {
    use SymbolAnchor::{Bottom, BottomLeft, BottomRight, Left, Right, Top, TopLeft, TopRight};
    let radial = radial.max(0.0);
    let hypotenuse = radial / std::f64::consts::SQRT_2;
    let y = match anchor {
        TopRight | TopLeft => hypotenuse - BASELINE_OFFSET,
        BottomRight | BottomLeft => -hypotenuse + BASELINE_OFFSET,
        Bottom => -radial + BASELINE_OFFSET,
        Top => radial - BASELINE_OFFSET,
        _ => 0.0,
    };
    let x = match anchor {
        TopRight | BottomRight => -hypotenuse,
        TopLeft | BottomLeft => hypotenuse,
        Left => radial,
        Right => -radial,
        _ => 0.0,
    };
    [x, y]
}

/// `evaluateVariableOffset` with a `text-offset` in glyph units (`fromTextOffset`).
#[must_use]
pub fn text_offset(anchor: SymbolAnchor, offset: [f64; 2]) -> [f64; 2] {
    use SymbolAnchor::{Bottom, BottomLeft, BottomRight, Left, Right, Top, TopLeft, TopRight};
    let [x, y] = [offset[0].abs(), offset[1].abs()];
    [
        match anchor {
            TopRight | BottomRight | Right => -x,
            TopLeft | BottomLeft | Left => x,
            _ => 0.0,
        },
        match anchor {
            TopRight | TopLeft | Top => y - BASELINE_OFFSET,
            BottomRight | BottomLeft | Bottom => -y + BASELINE_OFFSET,
            _ => 0.0,
        },
    ]
}

/// A constant `text-variable-anchor`: anchors in the order placement tries them.
pub fn parse_anchors(value: &Value) -> Result<Vec<SymbolAnchor>, String> {
    let Value::Array(items) = value else {
        return Err("must be an array of anchors".to_owned());
    };
    if items.is_empty() {
        return Err("needs at least one anchor".to_owned());
    }
    items.iter().map(parse_anchor).collect()
}

/// A constant `text-variable-anchor-offset`: `[anchor, [x, y], ...]` in ems.
pub fn parse_anchor_offsets(value: &Value) -> Result<Vec<AnchorOffset>, String> {
    let Value::Array(items) = value else {
        return Err("must be an array of anchors and offsets".to_owned());
    };
    if items.is_empty() || items.len() % 2 != 0 {
        return Err("needs pairs of an anchor and an offset".to_owned());
    }
    items
        .as_chunks::<2>()
        .0
        .iter()
        .map(|[anchor, offset]| {
            let anchor = parse_anchor(anchor)?;
            match offset.as_array().map(Vec::as_slice) {
                Some([x, y]) if x.is_number() && y.is_number() => Ok((
                    anchor,
                    [x.as_f64().unwrap_or(0.0), y.as_f64().unwrap_or(0.0)],
                )),
                _ => Err(format!("invalid offset {offset}")),
            }
        })
        .collect()
}

fn parse_anchor(value: &Value) -> Result<SymbolAnchor, String> {
    value
        .as_str()
        .and_then(SymbolAnchor::parse)
        .ok_or_else(|| format!("invalid anchor {value}"))
}

/// `getTextVariableAnchorOffset`: `text-variable-anchor-offset` in glyph units with the
/// baseline shift above and below the anchor.
#[must_use]
pub fn em_offsets_to_glyph_units(anchors: &[AnchorOffset]) -> Vec<AnchorOffset> {
    use SymbolAnchor::{Bottom, BottomLeft, BottomRight, Top, TopLeft, TopRight};
    anchors
        .iter()
        .map(|&(anchor, [x, y])| {
            let baseline = match anchor {
                Top | TopLeft | TopRight => -BASELINE_OFFSET,
                Bottom | BottomLeft | BottomRight => BASELINE_OFFSET,
                _ => 0.0,
            };
            (anchor, [x * ONE_EM, y * ONE_EM + baseline])
        })
        .collect()
}

/// The part of a variable anchor's shift that comes from the label's box: `-(align - 0.5)`
/// of its width and height.
fn box_shift(anchor: SymbolAnchor, width: f64, height: f64) -> [f64; 2] {
    let (horizontal, vertical) = anchor.alignment();
    [-(horizontal - 0.5) * width, -(vertical - 0.5) * height]
}

/// `calculateVariableLayoutShift`: the shift of a box `width` by `height` CSS px at the layout
/// text size, `box_scale` being that size over 24.
#[must_use]
pub fn layout_shift(
    anchor: SymbolAnchor,
    width: f64,
    height: f64,
    offset: [f64; 2],
    box_scale: f64,
) -> [f64; 2] {
    let [x, y] = box_shift(anchor, width, height);
    [x + offset[0] * box_scale, y + offset[1] * box_scale]
}

/// `calculateVariableRenderShift`: the same shift at the drawn text size, `render_scale` being
/// that size (with the perspective ratio) over 24.
#[must_use]
pub fn render_shift(
    anchor: SymbolAnchor,
    width: f64,
    height: f64,
    offset: [f64; 2],
    box_scale: f64,
    render_scale: f64,
) -> [f64; 2] {
    let [x, y] = box_shift(anchor, width, height);
    [
        (x / box_scale + offset[0]) * render_scale,
        (y / box_scale + offset[1]) * render_scale,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn radial_offsets_lie_on_the_circle_with_the_baseline_correction() {
        let radial = 24.0;
        let diagonal = radial / std::f64::consts::SQRT_2;
        assert_eq!(radial_offset(SymbolAnchor::Center, radial), [0.0, 0.0]);
        assert_eq!(radial_offset(SymbolAnchor::Left, radial), [radial, 0.0]);
        assert_eq!(radial_offset(SymbolAnchor::Right, radial), [-radial, 0.0]);
        assert_eq!(
            radial_offset(SymbolAnchor::Top, radial),
            [0.0, radial - 7.0]
        );
        assert_eq!(
            radial_offset(SymbolAnchor::Bottom, radial),
            [0.0, -radial + 7.0]
        );
        assert_eq!(
            radial_offset(SymbolAnchor::TopLeft, radial),
            [diagonal, diagonal - 7.0]
        );
        assert_eq!(
            radial_offset(SymbolAnchor::BottomRight, radial),
            [-diagonal, -diagonal + 7.0]
        );
        // A negative radial offset counts as none.
        assert_eq!(radial_offset(SymbolAnchor::Left, -5.0), [0.0, 0.0]);
    }

    #[test]
    fn text_offsets_use_their_magnitude_towards_the_anchor() {
        let offset = [-12.0, 24.0];
        assert_eq!(text_offset(SymbolAnchor::Center, offset), [0.0, 0.0]);
        assert_eq!(text_offset(SymbolAnchor::Left, offset), [12.0, 0.0]);
        assert_eq!(text_offset(SymbolAnchor::Right, offset), [-12.0, 0.0]);
        assert_eq!(text_offset(SymbolAnchor::Top, offset), [0.0, 17.0]);
        assert_eq!(text_offset(SymbolAnchor::Bottom, offset), [0.0, -17.0]);
        assert_eq!(text_offset(SymbolAnchor::TopRight, [0.0, 0.0]), [0.0, -7.0]);
    }

    #[test]
    fn anchor_offsets_convert_ems_and_shift_the_baseline() {
        let anchors = [
            (SymbolAnchor::Top, [0.0, 1.0]),
            (SymbolAnchor::BottomLeft, [1.0, -1.0]),
            (SymbolAnchor::Left, [2.0, 0.5]),
        ];
        assert_eq!(
            em_offsets_to_glyph_units(&anchors),
            [
                (SymbolAnchor::Top, [0.0, 17.0]),
                (SymbolAnchor::BottomLeft, [24.0, -17.0]),
                (SymbolAnchor::Left, [48.0, 12.0]),
            ]
        );
    }

    #[test]
    fn shifts_move_the_box_past_the_anchor_at_layout_and_drawn_sizes() {
        // A 40 by 20 px box at `text-size` 24 (box scale 1), anchored at its left edge with a
        // 10 glyph unit offset: its centre goes half a width right, plus the offset.
        let shift = layout_shift(SymbolAnchor::Left, 40.0, 20.0, [10.0, 0.0], 1.0);
        assert_eq!(shift, [30.0, 0.0]);
        // Drawn at half the size the whole shift halves.
        let render = render_shift(SymbolAnchor::Left, 40.0, 20.0, [10.0, 0.0], 1.0, 0.5);
        assert_eq!(render, [15.0, 0.0]);
        // Under `text-size` 12 (box scale 0.5) the box and offset scale apart.
        assert_eq!(
            layout_shift(SymbolAnchor::Bottom, 40.0, 20.0, [0.0, -4.0], 0.5),
            [0.0, -12.0]
        );
        assert_eq!(
            render_shift(SymbolAnchor::Bottom, 40.0, 20.0, [0.0, -4.0], 0.5, 0.5),
            [0.0, -12.0]
        );
    }

    #[test]
    fn parses_constant_anchor_lists_and_refuses_the_rest() {
        assert_eq!(
            parse_anchors(&json!(["top", "bottom-left"])).unwrap(),
            [SymbolAnchor::Top, SymbolAnchor::BottomLeft]
        );
        assert!(parse_anchors(&json!([])).is_err());
        assert!(parse_anchors(&json!(["middle"])).is_err());
        assert!(parse_anchors(&json!("top")).is_err());
        assert_eq!(
            parse_anchor_offsets(&json!(["left", [1, 0], "top", [0, 1.5]])).unwrap(),
            [
                (SymbolAnchor::Left, [1.0, 0.0]),
                (SymbolAnchor::Top, [0.0, 1.5]),
            ]
        );
        assert!(parse_anchor_offsets(&json!(["left"])).is_err());
        assert!(parse_anchor_offsets(&json!(["left", [1]])).is_err());
        assert!(parse_anchor_offsets(&json!(["left", ["a", 1]])).is_err());
    }
}
