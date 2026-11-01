//! Line label projection (#346), ported from MapLibre 6.15 `projection.ts`
//! (`updateLineLabels`, `placeGlyphsAlongLine`, `placeGlyphAlongLine` and the offset-line
//! helpers) and `path_interpolator.ts`: each frame a line label's glyphs walk its line,
//! projected to the label plane, from the anchor by their offsets along the text.
//!
//! The label plane is the viewport in CSS px (`text-pitch-alignment: viewport`) or the tile
//! in CSS px at the drawn zoom (`map`, which pitches with the map; MapLibre's
//! `pitchedLabelPlaneMatrix` for `rotation-alignment: map`).

use super::layout::EXTENT;

type Point = [f64; 2];

fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1]]
}

fn add(a: Point, b: Point) -> Point {
    [a[0] + b[0], a[1] + b[1]]
}

fn scale(a: Point, factor: f64) -> Point {
    [a[0] * factor, a[1] * factor]
}

fn mag(a: Point) -> f64 {
    a[0].hypot(a[1])
}

fn unit(a: Point) -> Point {
    scale(a, 1.0 / mag(a))
}

/// How one tile's points reach the viewport this frame.
pub struct TileProjection<'a> {
    /// Tile-normalized point (`0..1`) to viewport CSS px and clip `w`, the signed distance
    /// from the camera (the px are meaningless when it is not positive).
    pub project: &'a dyn Fn([f64; 2]) -> ([f64; 2], f64),
    /// The clip `w` of the viewport centre: MapLibre's `cameraToCenterDistance`.
    pub center_w: f64,
    /// The tile's size in CSS px at the drawn zoom.
    pub tile_px: f64,
}

impl TileProjection<'_> {
    /// `getPerspectiveRatio`.
    #[must_use]
    pub fn perspective_ratio(&self, w: f64) -> f64 {
        0.5 + 0.5 * self.center_w / w
    }

    /// A tile-normalized anchor in viewport px with its perspective ratio; `None` behind the
    /// camera.
    #[must_use]
    pub fn anchor(&self, uv: [f64; 2]) -> Option<([f64; 2], f64)> {
        let (point, w) = (self.project)(uv);
        (w > 0.0).then(|| (point, self.perspective_ratio(w)))
    }
}

/// One line label being projected: its line and anchor in tile units.
pub struct LineLabelContext<'a> {
    pub projection: &'a TileProjection<'a>,
    pub pitch_with_map: bool,
    pub line: &'a [[f64; 2]],
    pub anchor: [f64; 2],
    /// The anchor lies between `line[segment]` and `line[segment + 1]`.
    pub segment: usize,
}

impl LineLabelContext<'_> {
    /// `projectTileCoordinatesToLabelPlane`: the label-plane point and its clip `w` (1 on
    /// the pitched plane, which is never behind the camera).
    #[must_use]
    pub fn to_label_plane(&self, tile: Point) -> (Point, f64) {
        let uv = [tile[0] / EXTENT, tile[1] / EXTENT];
        if self.pitch_with_map {
            (scale(uv, self.projection.tile_px), 1.0)
        } else {
            (self.projection.project)(uv)
        }
    }

    /// A label-plane point in viewport px and its clip `w`.
    #[must_use]
    pub fn to_viewport(&self, point: Point) -> (Point, f64) {
        if self.pitch_with_map {
            (self.projection.project)(scale(point, 1.0 / self.projection.tile_px))
        } else {
            (point, 1.0)
        }
    }
}

/// `ProjectionCache`: label-plane line vertices (and their offset-line equivalents) of one
/// label, reused by every glyph.
struct ProjectionCache {
    projections: Vec<Option<Point>>,
    offsets: Vec<Option<Point>>,
    anchor: Option<Point>,
}

impl ProjectionCache {
    fn new(length: usize) -> Self {
        Self {
            projections: vec![None; length],
            offsets: vec![None; length],
            anchor: None,
        }
    }
}

/// `ProjectionSyntheticVertexArgs`.
#[derive(Clone, Copy)]
struct Synthetic {
    distance_from_anchor: f64,
    previous_vertex: Point,
    direction: isize,
    abs_offset_x: f64,
}

/// `projectTruncatedLineSegmentToLabelPlane`: a point `minimum_length` from
/// `previous_projected` along the projected direction of `previous_tile -> current_tile`.
fn truncated_segment(
    context: &LineLabelContext<'_>,
    previous_tile: Point,
    current_tile: Point,
    previous_projected: Point,
    minimum_length: f64,
) -> Point {
    let unit_vertex = add(previous_tile, unit(sub(previous_tile, current_tile)));
    let projected_unit = context.to_label_plane(unit_vertex).0;
    let segment = sub(previous_projected, projected_unit);
    add(
        previous_projected,
        scale(segment, minimum_length / mag(segment)),
    )
}

/// `projectLineVertexToLabelPlane`, with a synthetic vertex for one behind the camera.
fn project_vertex(
    index: usize,
    context: &LineLabelContext<'_>,
    cache: &mut ProjectionCache,
    synthetic: Synthetic,
) -> Point {
    if let Some(point) = cache.projections[index] {
        return point;
    }
    let current = context.line[index];
    let (point, w) = context.to_label_plane(current);
    if w > 0.0 {
        cache.projections[index] = Some(point);
        return point;
    }
    let previous_tile = if synthetic.distance_from_anchor == 0.0 {
        context.anchor
    } else {
        context.line[(index as isize - synthetic.direction) as usize]
    };
    let minimum_length = synthetic.abs_offset_x - synthetic.distance_from_anchor + 1.0;
    truncated_segment(
        context,
        previous_tile,
        current,
        synthetic.previous_vertex,
        minimum_length,
    )
}

/// `transformToOffsetNormal`.
fn offset_normal(segment: Point, offset: f64, direction: isize) -> Point {
    let [x, y] = unit(segment);
    scale([-y, x], offset * direction as f64)
}

/// `findLineIntersection`; `None` for parallel lines.
fn line_intersection(a1: Point, a2: Point, b1: Point, b2: Point) -> Option<Point> {
    let (a_dy, a_dx) = (a2[1] - a1[1], a2[0] - a1[0]);
    let (b_dy, b_dx) = (b2[1] - b1[1], b2[0] - b1[0]);
    let denominator = b_dy * a_dx - b_dx * a_dy;
    if denominator == 0.0 {
        return None;
    }
    let (origin_dy, origin_dx) = (a1[1] - b1[1], a1[0] - b1[0]);
    let t = (b_dx * origin_dy - b_dy * origin_dx) / denominator;
    Some([a1[0] + t * a_dx, a1[1] + t * a_dy])
}

/// `findOffsetIntersectionPoint`: where the offset segments before and after a vertex meet.
#[allow(clippy::too_many_arguments)]
fn offset_intersection(
    index: usize,
    previous_normal: Point,
    current_vertex: Point,
    offset_previous: Point,
    line_offset_y: f64,
    context: &LineLabelContext<'_>,
    cache: &mut ProjectionCache,
    synthetic: Synthetic,
) -> Point {
    if let Some(point) = cache.offsets[index] {
        return point;
    }
    let offset_current = add(current_vertex, previous_normal);
    let next_index = index as isize + synthetic.direction;
    if next_index < 0 || next_index >= context.line.len() as isize {
        cache.offsets[index] = Some(offset_current);
        return offset_current;
    }
    let next = project_vertex(next_index as usize, context, cache, synthetic);
    let normal = offset_normal(
        sub(next, current_vertex),
        line_offset_y,
        synthetic.direction,
    );
    let point = line_intersection(
        offset_previous,
        offset_current,
        add(current_vertex, normal),
        add(next, normal),
    )
    .unwrap_or(offset_current);
    cache.offsets[index] = Some(point);
    point
}

/// A glyph placed on the label plane.
#[derive(Clone, Debug, PartialEq)]
pub struct PlacedGlyph {
    pub point: Point,
    pub angle: f64,
    /// The label-plane path from the anchor to the glyph (collision circles only).
    pub path: Vec<Point>,
}

/// `placeGlyphAlongLine`: walks the projected line from the anchor until the distance
/// equals `offset_x`; `None` when the line ends first.
#[allow(clippy::too_many_arguments)]
fn place_glyph(
    offset_x: f64,
    line_offset_x: f64,
    line_offset_y: f64,
    flip: bool,
    context: &LineLabelContext<'_>,
    cache: &mut ProjectionCache,
    rotate_to_line: bool,
) -> Option<PlacedGlyph> {
    let combined = if flip {
        offset_x - line_offset_x
    } else {
        offset_x + line_offset_x
    };
    let mut direction: isize = if combined > 0.0 { 1 } else { -1 };
    let mut angle = 0.0;
    if flip {
        direction *= -1;
        angle = std::f64::consts::PI;
    }
    if direction < 0 {
        angle += std::f64::consts::PI;
    }
    let mut index = context.segment as isize + if direction > 0 { 0 } else { 1 };
    let anchor = match cache.anchor {
        Some(anchor) => anchor,
        None => {
            let anchor = context.to_label_plane(context.anchor).0;
            cache.anchor = Some(anchor);
            anchor
        }
    };
    let mut current = anchor;
    let mut previous = anchor;
    let mut offset_intersection_point: Option<Point> = None;
    let mut offset_previous: Option<Point> = None;
    let mut distance_from_anchor = 0.0;
    let mut segment_distance = 0.0;
    let abs_offset_x = combined.abs();
    let mut path = Vec::new();
    let mut segment = [0.0, 0.0];
    let length = context.line.len() as isize;
    while distance_from_anchor + segment_distance <= abs_offset_x {
        index += direction;
        if index < 0 || index >= length {
            return None;
        }
        distance_from_anchor += segment_distance;
        previous = current;
        offset_previous = offset_intersection_point;
        let synthetic = Synthetic {
            distance_from_anchor,
            previous_vertex: previous,
            direction,
            abs_offset_x,
        };
        current = project_vertex(index as usize, context, cache, synthetic);
        if line_offset_y == 0.0 {
            path.push(previous);
            segment = sub(current, previous);
        } else {
            let previous_to_current = sub(current, previous);
            let normal = if mag(previous_to_current) == 0.0 {
                // The anchor sits on the vertex: the normal of the next segment.
                let next_index = index + direction;
                if next_index < 0 || next_index >= length {
                    return None;
                }
                let next = project_vertex(next_index as usize, context, cache, synthetic);
                offset_normal(sub(next, current), line_offset_y, direction)
            } else {
                offset_normal(previous_to_current, line_offset_y, direction)
            };
            let start = *offset_previous.get_or_insert(add(previous, normal));
            let end = offset_intersection(
                index as usize,
                normal,
                current,
                start,
                line_offset_y,
                context,
                cache,
                synthetic,
            );
            offset_intersection_point = Some(end);
            path.push(start);
            segment = sub(end, start);
        }
        segment_distance = mag(segment);
    }
    let t = (abs_offset_x - distance_from_anchor) / segment_distance;
    let point = add(scale(segment, t), offset_previous.unwrap_or(previous));
    let segment_angle = angle + (current[1] - previous[1]).atan2(current[0] - previous[0]);
    path.push(point);
    Some(PlacedGlyph {
        point,
        angle: if rotate_to_line { segment_angle } else { 0.0 },
        path,
    })
}

/// A line label's text as projection needs it.
pub struct LineGlyphs<'a> {
    /// Each glyph's centre along the text (`glyphOffsetArray`), in glyph units.
    pub offsets: &'a [f32],
    /// `text-offset` in glyph units: along the line and away from it.
    pub line_offset: [f64; 2],
}

/// `placeFirstAndLastGlyph`.
fn place_first_and_last(
    font_scale: f64,
    glyphs: &LineGlyphs<'_>,
    line_offset: [f64; 2],
    flip: bool,
    rotate_to_line: bool,
    context: &LineLabelContext<'_>,
    cache: &mut ProjectionCache,
) -> Option<(PlacedGlyph, PlacedGlyph)> {
    let (first, last) = (glyphs.offsets.first()?, glyphs.offsets.last()?);
    let place = |offset: f32, cache: &mut ProjectionCache| {
        place_glyph(
            font_scale * f64::from(offset),
            line_offset[0],
            line_offset[1],
            flip,
            context,
            cache,
            rotate_to_line,
        )
    };
    let first = place(*first, cache)?;
    let last = place(*last, cache)?;
    Some((first, last))
}

enum GlyphsOnLine {
    Placed(Vec<(Point, f64)>),
    NotEnoughRoom,
    NeedsFlipping,
}

/// `placeGlyphsAlongLine` for horizontal-only text.
fn place_glyphs(
    font_size: f64,
    glyphs: &LineGlyphs<'_>,
    flip: bool,
    keep_upright: bool,
    context: &LineLabelContext<'_>,
) -> GlyphsOnLine {
    let font_scale = font_size / 24.0;
    let line_offset = scale(glyphs.line_offset, font_scale);
    let mut cache = ProjectionCache::new(context.line.len());
    // `requiresOrientationChange` for horizontal-only text: upright reads left to right.
    let reversed = |a: Point, b: Point| context.to_viewport(a).0[0] > context.to_viewport(b).0[0];
    let mut placed = Vec::with_capacity(glyphs.offsets.len());
    if glyphs.offsets.len() > 1 {
        let Some((first, last)) = place_first_and_last(
            font_scale,
            glyphs,
            line_offset,
            flip,
            true,
            context,
            &mut cache,
        ) else {
            return GlyphsOnLine::NotEnoughRoom;
        };
        if keep_upright && !flip && reversed(first.point, last.point) {
            return GlyphsOnLine::NeedsFlipping;
        }
        placed.push((first.point, first.angle));
        for offset in &glyphs.offsets[1..glyphs.offsets.len() - 1] {
            let Some(glyph) = place_glyph(
                font_scale * f64::from(*offset),
                line_offset[0],
                line_offset[1],
                flip,
                context,
                &mut cache,
                true,
            ) else {
                return GlyphsOnLine::NotEnoughRoom;
            };
            placed.push((glyph.point, glyph.angle));
        }
        placed.push((last.point, last.angle));
    } else {
        if keep_upright && !flip {
            let a = context.to_label_plane(context.anchor).0;
            let end = context.line[context.segment + 1];
            let (projected, w) = context.to_label_plane(end);
            let b = if w > 0.0 {
                projected
            } else {
                truncated_segment(context, context.anchor, end, a, 1.0)
            };
            if reversed(a, b) {
                return GlyphsOnLine::NeedsFlipping;
            }
        }
        let Some(offset) = glyphs.offsets.first() else {
            return GlyphsOnLine::NotEnoughRoom;
        };
        let Some(glyph) = place_glyph(
            font_scale * f64::from(*offset),
            line_offset[0],
            line_offset[1],
            flip,
            context,
            &mut cache,
            true,
        ) else {
            return GlyphsOnLine::NotEnoughRoom;
        };
        placed.push((glyph.point, glyph.angle));
    }
    GlyphsOnLine::Placed(placed)
}

/// `updateLineLabels` for one placed label: its glyphs' label-plane points and angles, or
/// `None` when the label is hidden this frame (anchor far off screen, or it no longer fits
/// its line). `font_size` is the label's size at the drawn zoom; `buffer` the off-screen
/// distance in viewport px the anchor may be.
#[must_use]
pub fn line_label_glyphs(
    font_size: f64,
    glyphs: &LineGlyphs<'_>,
    keep_upright: bool,
    context: &LineLabelContext<'_>,
    viewport: [f64; 2],
    buffer: f64,
) -> Option<Vec<(Point, f64)>> {
    let uv = [context.anchor[0] / EXTENT, context.anchor[1] / EXTENT];
    let (point, w) = (context.projection.project)(uv);
    let visible = w > 0.0
        && point[0] >= -buffer
        && point[0] <= viewport[0] + buffer
        && point[1] >= -buffer
        && point[1] <= viewport[1] + buffer;
    if !visible {
        return None;
    }
    let ratio = context.projection.perspective_ratio(w);
    let size = if context.pitch_with_map {
        font_size / ratio
    } else {
        font_size * ratio
    };
    match place_glyphs(size, glyphs, false, keep_upright, context) {
        GlyphsOnLine::Placed(placed) => Some(placed),
        GlyphsOnLine::NotEnoughRoom => None,
        GlyphsOnLine::NeedsFlipping => {
            match place_glyphs(size, glyphs, true, keep_upright, context) {
                GlyphsOnLine::Placed(placed) => Some(placed),
                _ => None,
            }
        }
    }
}

/// The label-plane path a line label covers, from its first glyph back through the anchor
/// to its last (`placeCollisionCircles`); `None` when it does not fit its line.
#[must_use]
pub fn line_label_path(
    font_scale: f64,
    glyphs: &LineGlyphs<'_>,
    context: &LineLabelContext<'_>,
) -> Option<Vec<Point>> {
    let mut cache = ProjectionCache::new(context.line.len());
    let line_offset = scale(glyphs.line_offset, font_scale);
    let (first, last) = place_first_and_last(
        font_scale,
        glyphs,
        line_offset,
        false,
        false,
        context,
        &mut cache,
    )?;
    let mut path: Vec<Point> = first.path[1..].iter().rev().copied().collect();
    path.extend_from_slice(&last.path[1..]);
    Some(path)
}

/// `PathInterpolator`: points at fractions of a path's length, padded at both ends.
pub struct PathInterpolator<'a> {
    points: &'a [Point],
    distances: Vec<f64>,
    pub length: f64,
    pub padded_length: f64,
    padding: f64,
}

impl<'a> PathInterpolator<'a> {
    #[must_use]
    pub fn new(points: &'a [Point], padding: f64) -> Self {
        let mut distances = vec![0.0];
        for pair in points.windows(2) {
            distances.push(distances[distances.len() - 1] + mag(sub(pair[1], pair[0])));
        }
        let length = distances[distances.len() - 1];
        let padding = padding.min(length * 0.5);
        Self {
            points,
            distances,
            length,
            padded_length: length - padding * 2.0,
            padding,
        }
    }

    #[must_use]
    pub fn lerp(&self, t: f64) -> Point {
        if self.points.len() == 1 {
            return self.points[0];
        }
        let t = t.clamp(0.0, 1.0);
        let target = t * self.padded_length + self.padding;
        let mut index = 1;
        let mut distance = self.distances[index];
        while distance < target && index < self.distances.len() {
            index += 1;
            distance = self.distances.get(index).copied().unwrap_or(f64::NAN);
        }
        let index = index.min(self.points.len() - 1);
        let distance = self.distances[index];
        let previous = self.distances[index - 1];
        let segment = distance - previous;
        let t = if segment > 0.0 {
            (target - previous) / segment
        } else {
            0.0
        };
        add(
            scale(self.points[index - 1], 1.0 - t),
            scale(self.points[index], t),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An unpitched 512 px tile at the viewport origin: viewport px = tile px.
    fn flat(uv: [f64; 2]) -> ([f64; 2], f64) {
        ([uv[0] * 512.0, uv[1] * 512.0], 1.0)
    }

    #[test]
    fn glyphs_follow_the_line_and_keep_upright() {
        let projection = TileProjection {
            project: &flat,
            center_w: 1.0,
            tile_px: 512.0,
        };
        // A right-to-left line with a corner: 16 tile units per px.
        let line = [[4000.0, 1600.0], [1600.0, 1600.0], [1600.0, 4000.0]];
        let context = LineLabelContext {
            projection: &projection,
            pitch_with_map: false,
            line: &line,
            anchor: [2400.0, 1600.0],
            segment: 0,
        };
        let glyphs = LineGlyphs {
            offsets: &[-20.0, 0.0, 20.0],
            line_offset: [0.0, 0.0],
        };
        let placed =
            line_label_glyphs(24.0, &glyphs, true, &context, [512.0, 512.0], 256.0).unwrap();
        // Flipped to read left to right: the first glyph left of the anchor at 150 px.
        assert!((placed[0].0[0] - 130.0).abs() < 1e-9, "{placed:?}");
        assert!((placed[2].0[0] - 170.0).abs() < 1e-9);
        assert!(
            placed
                .iter()
                .all(|(_, angle)| (angle.cos() - 1.0).abs() < 1e-9)
        );
        // Without keep-upright the text runs along the line: upside down, around the corner.
        let placed =
            line_label_glyphs(24.0, &glyphs, false, &context, [512.0, 512.0], 256.0).unwrap();
        assert!((placed[2].0[0] - 130.0).abs() < 1e-9);
        // 50 px of line before the corner: a glyph 60 px out has turned it.
        let glyphs = LineGlyphs {
            offsets: &[0.0, 60.0],
            line_offset: [0.0, 0.0],
        };
        let placed =
            line_label_glyphs(24.0, &glyphs, false, &context, [512.0, 512.0], 256.0).unwrap();
        assert!((placed[1].0[0] - 100.0).abs() < 1e-9 && (placed[1].0[1] - 110.0).abs() < 1e-9);
        assert!((placed[1].1 - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    }
}
