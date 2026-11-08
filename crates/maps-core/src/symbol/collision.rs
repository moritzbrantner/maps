//! Symbol collision, ported from MapLibre 6.15 `grid_index.ts`, `collision_index.ts` and
//! `placement.ts`: labels are placed top layer first, tiles in MapLibre's symbol order, each
//! point label's padded box and each line label's circles along its line (#346) tested
//! against those already placed.

use std::collections::HashMap;

use super::layout::{EXTENT, LayerBucket, SymbolInstance, TileStyleBuckets, VariableText};
use super::line_anchors::clip_line;
use super::projection::{
    LineGlyphs, LineLabelContext, PathInterpolator, SymbolAlignment, TileProjection,
};
use super::shaping::SymbolAnchor;
use super::variable_anchors::layout_shift;
use crate::TileId;

/// Collision grids extend this far past the viewport (MapLibre `viewportPadding`).
pub const VIEWPORT_PADDING: f64 = 100.0;
const CELL_SIZE: f64 = 25.0;
/// Labels whose anchor is this foreshortened under pitch are not placed.
const PERSPECTIVE_RATIO_CUTOFF: f64 = 0.6;

/// `GridIndex` for boxes and (line label) circles.
pub struct GridIndex {
    width: f64,
    height: f64,
    x_cells: usize,
    y_cells: usize,
    cells: Vec<Vec<usize>>,
    boxes: Vec<[f64; 4]>,
    circle_cells: Vec<Vec<usize>>,
    /// (x, y, radius).
    circles: Vec<[f64; 3]>,
}

/// `_circleAndRectCollide`.
fn circle_and_rect_collide(circle: [f64; 3], b: [f64; 4]) -> bool {
    let [x, y, radius] = circle;
    let half_width = (b[2] - b[0]) / 2.0;
    let dist_x = (x - (b[0] + half_width)).abs();
    if dist_x > half_width + radius {
        return false;
    }
    let half_height = (b[3] - b[1]) / 2.0;
    let dist_y = (y - (b[1] + half_height)).abs();
    if dist_y > half_height + radius {
        return false;
    }
    if dist_x <= half_width || dist_y <= half_height {
        return true;
    }
    let (dx, dy) = (dist_x - half_width, dist_y - half_height);
    dx * dx + dy * dy <= radius * radius
}

impl GridIndex {
    #[must_use]
    pub fn new(width: f64, height: f64) -> Self {
        let x_cells = (width / CELL_SIZE).ceil().max(1.0) as usize;
        let y_cells = (height / CELL_SIZE).ceil().max(1.0) as usize;
        Self {
            width,
            height,
            x_cells,
            y_cells,
            cells: vec![Vec::new(); x_cells * y_cells],
            boxes: Vec::new(),
            circle_cells: vec![Vec::new(); x_cells * y_cells],
            circles: Vec::new(),
        }
    }

    fn cell_range(&self, b: [f64; 4]) -> (usize, usize, usize, usize) {
        let x = |v: f64| {
            ((v * self.x_cells as f64 / self.width).floor().max(0.0) as usize).min(self.x_cells - 1)
        };
        let y = |v: f64| {
            ((v * self.y_cells as f64 / self.height).floor().max(0.0) as usize)
                .min(self.y_cells - 1)
        };
        (x(b[0]), y(b[1]), x(b[2]), y(b[3]))
    }

    pub fn insert(&mut self, b: [f64; 4]) {
        let uid = self.boxes.len();
        self.boxes.push(b);
        let (x1, y1, x2, y2) = self.cell_range(b);
        for x in x1..=x2 {
            for y in y1..=y2 {
                self.cells[self.x_cells * y + x].push(uid);
            }
        }
    }

    /// `insertCircle`: into every cell of its circumscribing square.
    pub fn insert_circle(&mut self, circle: [f64; 3]) {
        let uid = self.circles.len();
        self.circles.push(circle);
        let [x, y, r] = circle;
        let (x1, y1, x2, y2) = self.cell_range([x - r, y - r, x + r, y + r]);
        for cx in x1..=x2 {
            for cy in y1..=y2 {
                self.circle_cells[self.x_cells * cy + cx].push(uid);
            }
        }
    }

    /// Whether `b` overlaps any inserted box or circle (every overlap mode here is `never`).
    #[must_use]
    pub fn hit_test(&self, b: [f64; 4]) -> bool {
        if b[2] < 0.0 || b[0] > self.width || b[3] < 0.0 || b[1] > self.height {
            return false;
        }
        if b[0] <= 0.0 && b[1] <= 0.0 && self.width <= b[2] && self.height <= b[3] {
            return true;
        }
        const EPSILON: f64 = 1e-6;
        let (x1, y1, x2, y2) = self.cell_range(b);
        for x in x1..=x2 {
            for y in y1..=y2 {
                let cell = self.x_cells * y + x;
                for uid in &self.cells[cell] {
                    let other = self.boxes[*uid];
                    if b[0] <= other[2] + EPSILON
                        && b[1] <= other[3] + EPSILON
                        && b[2] >= other[0] - EPSILON
                        && b[3] >= other[1] - EPSILON
                    {
                        return true;
                    }
                }
                if self.circle_cells[cell]
                    .iter()
                    .any(|uid| circle_and_rect_collide(self.circles[*uid], b))
                {
                    return true;
                }
            }
        }
        false
    }

    /// `hitTestCircle`: whether the circle overlaps any inserted box or circle.
    #[must_use]
    pub fn hit_test_circle(&self, circle: [f64; 3]) -> bool {
        let [x, y, r] = circle;
        let b = [x - r, y - r, x + r, y + r];
        if b[2] < 0.0 || b[0] > self.width || b[3] < 0.0 || b[1] > self.height {
            return false;
        }
        let (x1, y1, x2, y2) = self.cell_range(b);
        for cx in x1..=x2 {
            for cy in y1..=y2 {
                let cell = self.x_cells * cy + cx;
                if self.cells[cell]
                    .iter()
                    .any(|uid| circle_and_rect_collide(circle, self.boxes[*uid]))
                {
                    return true;
                }
                if self.circle_cells[cell].iter().any(|uid| {
                    let [ox, oy, or] = self.circles[*uid];
                    let (dx, dy, radii) = (ox - x, oy - y, r + or);
                    radii * radii > dx * dx + dy * dy
                }) {
                    return true;
                }
            }
        }
        false
    }
}

/// `CollisionIndex` for viewport-aligned boxes and line label circles.
pub struct CollisionIndex {
    grid: GridIndex,
    ignored: GridIndex,
    width: f64,
    height: f64,
    grid_right: f64,
    grid_bottom: f64,
}

/// A line label as `placeCollisionCircles` sees it.
pub struct LineCollision<'a> {
    pub context: &'a LineLabelContext<'a>,
    pub glyphs: &'a LineGlyphs<'a>,
    /// `text-size` at the drawn zoom.
    pub font_size: f64,
    /// At the layout text size, in CSS px.
    pub circle_diameter: f64,
    /// `text-padding`.
    pub padding: f64,
    pub allow_overlap: bool,
}

/// A label's anchor and how its collision box meets the map (`placeCollisionBox`).
pub struct AlignedLabel<'a> {
    pub projection: &'a TileProjection<'a>,
    /// Tile-normalized.
    pub anchor: [f64; 2],
    pub alignment: SymbolAlignment,
    /// Clockwise, radians.
    pub bearing: f64,
}

impl CollisionIndex {
    #[must_use]
    pub fn new(width: f64, height: f64) -> Self {
        let (grid_right, grid_bottom) = (
            width + 2.0 * VIEWPORT_PADDING,
            height + 2.0 * VIEWPORT_PADDING,
        );
        Self {
            grid: GridIndex::new(grid_right, grid_bottom),
            ignored: GridIndex::new(grid_right, grid_bottom),
            width,
            height,
            grid_right,
            grid_bottom,
        }
    }

    fn inside_grid(&self, b: [f64; 4]) -> bool {
        b[2] >= 0.0 && b[0] < self.grid_right && b[3] >= 0.0 && b[1] < self.grid_bottom
    }

    /// `placeCollisionBox` fast path: `anchor` in viewport CSS px. Returns the grid box when
    /// the label fits.
    #[must_use]
    pub fn place_box(
        &self,
        anchor: [f64; 2],
        perspective_ratio: f64,
        collision_box: [f64; 4],
        allow_overlap: bool,
    ) -> Option<[f64; 4]> {
        let (x, y) = (anchor[0] + VIEWPORT_PADDING, anchor[1] + VIEWPORT_PADDING);
        let b = [
            x + collision_box[0] * perspective_ratio,
            y + collision_box[1] * perspective_ratio,
            x + collision_box[2] * perspective_ratio,
            y + collision_box[3] * perspective_ratio,
        ];
        if perspective_ratio < PERSPECTIVE_RATIO_CUTOFF || !self.inside_grid(b) {
            return None;
        }
        if !allow_overlap && self.grid.hit_test(b) {
            return None;
        }
        Some(b)
    }

    /// `placeCollisionBox` for one label: `collision_box` in CSS px around its anchor, moved
    /// by a variable anchor's `shift`. Viewport-aligned labels take the fast path. Others
    /// are `_projectCollisionBox`: along [`TileProjection::label_axes`], on the viewport
    /// (scaled by the perspective ratio) or laid on the map plane, their corners and edge
    /// midpoints are projected and the grid box is around them.
    #[must_use]
    pub fn place_aligned_box(
        &self,
        label: &AlignedLabel<'_>,
        collision_box: [f64; 4],
        shift: Option<[f64; 2]>,
        allow_overlap: bool,
    ) -> Option<[f64; 4]> {
        let projection = label.projection;
        let (point, w) = (projection.project)(label.anchor);
        if w <= 0.0 {
            return None;
        }
        let ratio = projection.perspective_ratio(w);
        let [dx, dy] = shift.unwrap_or([0.0, 0.0]);
        let [x1, y1, x2, y2] = [
            collision_box[0] + dx,
            collision_box[1] + dy,
            collision_box[2] + dx,
            collision_box[3] + dy,
        ];
        let alignment = label.alignment;
        if !alignment.rotate_with_map && !alignment.pitch_with_map {
            return self.place_box(point, ratio, [x1, y1, x2, y2], allow_overlap);
        }
        let axes = projection.label_axes(label.anchor, alignment, label.bearing);
        let offsets = [
            [x1, y1],
            [(x1 + x2) / 2.0, y1],
            [x2, y1],
            [x2, (y1 + y2) / 2.0],
            [x2, y2],
            [(x1 + x2) / 2.0, y2],
            [x1, y2],
            [x1, (y1 + y2) / 2.0],
        ];
        let mut points = Vec::with_capacity(offsets.len());
        if alignment.pitch_with_map {
            // Tile-space offsets: CSS px at the drawn zoom, grown with the distance as the
            // shader's perspective ratio grows them, which variable anchors do without.
            let distance = if shift.is_some() {
                1.0
            } else {
                projection.size_ratio(w, true)
            };
            let scale = distance / projection.tile_px;
            let mut visible = false;
            for offset in offsets {
                let [x, y] = axes.apply(offset);
                let (projected, w) = (projection.project)([
                    label.anchor[0] + x * scale,
                    label.anchor[1] + y * scale,
                ]);
                visible |= w > 0.0;
                points.push(projected);
            }
            if !visible {
                return None;
            }
        } else {
            for [x, y] in offsets {
                let [x, y] = axes.apply([x * ratio, y * ratio]);
                points.push([point[0] + x, point[1] + y]);
            }
        }
        let mut b = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for [x, y] in points {
            b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        }
        let b = [
            b[0] + VIEWPORT_PADDING,
            b[1] + VIEWPORT_PADDING,
            b[2] + VIEWPORT_PADDING,
            b[3] + VIEWPORT_PADDING,
        ];
        if ratio < PERSPECTIVE_RATIO_CUTOFF || !self.inside_grid(b) {
            return None;
        }
        if !allow_overlap && self.grid.hit_test(b) {
            return None;
        }
        Some(b)
    }

    /// `placeCollisionCircles`: circles along the label's projected path, in grid px; `None`
    /// when the label does not fit its line, collides, is outside the grid or too far away.
    #[must_use]
    pub fn place_circles(&self, label: &LineCollision<'_>) -> Option<Vec<[f64; 3]>> {
        let context = label.context;
        let anchor_uv = [context.anchor[0] / EXTENT, context.anchor[1] / EXTENT];
        let (_, w) = (context.projection.project)(anchor_uv);
        let ratio = context.projection.perspective_ratio(w);
        let font_size = if context.pitch_with_map {
            label.font_size / ratio
        } else {
            label.font_size * ratio
        };
        let path = super::projection::line_label_path(font_size / 24.0, label.glyphs, context)?;
        let radius = label.circle_diameter * 0.5 * ratio + label.padding;
        let (min, max) = (
            [-VIEWPORT_PADDING, -VIEWPORT_PADDING],
            [
                self.width + VIEWPORT_PADDING,
                self.height + VIEWPORT_PADDING,
            ],
        );
        // A path on the map plane goes to the viewport; none of it may be behind the camera.
        let path: Vec<[f64; 2]> = if context.pitch_with_map {
            let projected: Vec<_> = path
                .iter()
                .map(|point| context.to_viewport(*point))
                .collect();
            if projected.iter().any(|(_, w)| *w <= 0.0) {
                Vec::new()
            } else {
                projected.into_iter().map(|(point, _)| point).collect()
            }
        } else {
            path
        };
        let segments = if path.is_empty() {
            Vec::new()
        } else {
            let lo = path.iter().fold([f64::INFINITY; 2], |acc, p| {
                [acc[0].min(p[0]), acc[1].min(p[1])]
            });
            let hi = path.iter().fold([f64::NEG_INFINITY; 2], |acc, p| {
                [acc[0].max(p[0]), acc[1].max(p[1])]
            });
            if lo[0] >= min[0] && hi[0] <= max[0] && lo[1] >= min[1] && hi[1] <= max[1] {
                vec![path]
            } else if hi[0] < min[0] || lo[0] > max[0] || hi[1] < min[1] || lo[1] > max[1] {
                Vec::new()
            } else {
                clip_line(&[path], min[0], min[1], max[0], max[1])
            }
        };
        let circle_distance = radius * 2.5;
        let mut circles = Vec::new();
        let mut in_grid = false;
        for segment in &segments {
            let interpolator = PathInterpolator::new(segment, radius * 0.25);
            let count = if interpolator.length <= 0.5 * radius {
                1
            } else {
                (interpolator.padded_length / circle_distance).ceil() as usize + 1
            };
            for index in 0..count {
                let t = index as f64 / (count.saturating_sub(1).max(1)) as f64;
                let position = interpolator.lerp(t);
                let (x, y) = (
                    position[0] + VIEWPORT_PADDING,
                    position[1] + VIEWPORT_PADDING,
                );
                circles.push([x, y, radius]);
                in_grid |= self.inside_grid([x - radius, y - radius, x + radius, y + radius]);
                if !label.allow_overlap && self.grid.hit_test_circle([x, y, radius]) {
                    return None;
                }
            }
        }
        (in_grid && ratio >= PERSPECTIVE_RATIO_CUTOFF && !circles.is_empty()).then_some(circles)
    }

    pub fn insert(&mut self, b: [f64; 4], ignore_placement: bool) {
        if ignore_placement {
            self.ignored.insert(b);
        } else {
            self.grid.insert(b);
        }
    }

    pub fn insert_circles(&mut self, circles: &[[f64; 3]], ignore_placement: bool) {
        let grid = if ignore_placement {
            &mut self.ignored
        } else {
            &mut self.grid
        };
        for circle in circles {
            grid.insert_circle(*circle);
        }
    }
}

/// A tile's symbols as placement sees them.
pub struct PlacementTile<'a> {
    pub tile: TileId,
    pub buckets: &'a TileStyleBuckets,
    pub projection: TileProjection<'a>,
}

/// One symbol that shows its text, its icon or both (MapLibre's `JointPlacement`), with where
/// its anchor projects.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacedSymbol {
    pub tile: usize,
    pub layer: usize,
    pub instance: usize,
    /// The perspective ratio of the anchor moved by `text-translate`.
    pub perspective_ratio: f64,
    pub text: bool,
    pub icon: bool,
    /// The chosen entry of the text's [`VariableText::anchors`].
    pub variable_anchor: Option<usize>,
}

/// The anchor each variable label took in the last placement, by tile, layer and instance, so
/// the next placement tries it first (MapLibre's `prevPlacement.variableOffsets`).
pub type VariableAnchorMemory = HashMap<(TileId, usize, usize), SymbolAnchor>;

/// MapLibre's `placeBoxForVariableAnchors` for one label: the anchors in style order, the
/// last placement's anchor first, then, with `text-allow-overlap`, again ignoring collisions.
/// An icon that fits its text (`icon_box`) must fit at the same shift. Returns the anchor's
/// index, the shift in CSS px at the layout text size, and the text's grid box.
#[allow(clippy::too_many_arguments)]
fn place_variable_text(
    index: &CollisionIndex,
    variable: &VariableText,
    previous: Option<SymbolAnchor>,
    label: &AlignedLabel<'_>,
    collision_box: [f64; 4],
    allow_overlap: bool,
    icon_box: Option<(&AlignedLabel<'_>, [f64; 4])>,
) -> Option<(usize, [f64; 2], [f64; 4])> {
    let (width, height) = (
        collision_box[2] - collision_box[0],
        collision_box[3] - collision_box[1],
    );
    let mut prefer = previous;
    let mut overlap = false;
    let passes = usize::from(previous.is_some()) + if allow_overlap { 2 } else { 1 };
    for _ in 0..passes {
        for (choice, &(candidate, offset)) in variable.anchors.iter().enumerate() {
            if prefer.is_some_and(|preferred| preferred != candidate) {
                continue;
            }
            let shift = layout_shift(candidate, width, height, offset, variable.box_scale);
            let Some(b) = index.place_aligned_box(label, collision_box, Some(shift), overlap)
            else {
                continue;
            };
            if let Some((icon_label, icon_box)) = icon_box
                && index
                    .place_aligned_box(icon_label, icon_box, Some(shift), overlap)
                    .is_none()
            {
                continue;
            }
            return Some((choice, shift, b));
        }
        if prefer.is_some() {
            prefer = None;
        } else {
            overlap = allow_overlap;
        }
    }
    None
}

/// MapLibre's symbol tile order (`getRenderableIds(true)`), which symbols draw in reversed:
/// zoom ascending, then bottom to top and right to left in the rotated frame. Returns indices
/// into `tiles`.
#[must_use]
pub fn symbol_tile_order(tiles: &[TileId], bearing_radians: f64) -> Vec<usize> {
    let rotated = |tile: TileId| {
        let (sin, cos) = (-bearing_radians).sin_cos();
        let (x, y) = (f64::from(tile.x), f64::from(tile.y));
        (x * cos - y * sin, x * sin + y * cos)
    };
    let mut order: Vec<usize> = (0..tiles.len()).collect();
    order.sort_by(|a, b| {
        let (ta, tb) = (tiles[*a], tiles[*b]);
        let ((ax, ay), (bx, by)) = (rotated(ta), rotated(tb));
        ta.z.cmp(&tb.z)
            .then(by.total_cmp(&ay))
            .then(bx.total_cmp(&ax))
    });
    order
}

/// Places every symbol layer, top layer first, at the camera `zoom` and `bearing` (clockwise,
/// radians), tiles in MapLibre's placement order (`Style._updatePlacement`: zoom descending,
/// then `isLessThan`: x, then y ascending). Returns placed symbols per layer in placement
/// order, `tile` indexing `tiles`. `memory` carries variable labels' anchors between frames.
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn place_symbols(
    tiles: &[PlacementTile<'_>],
    layer_count: usize,
    width: f64,
    height: f64,
    zoom: f64,
    bearing: f64,
    memory: &mut VariableAnchorMemory,
) -> Vec<Vec<PlacedSymbol>> {
    let previous = std::mem::take(memory);
    let mut index = CollisionIndex::new(width, height);
    let mut placed = vec![Vec::new(); layer_count];
    let mut order: Vec<usize> = (0..tiles.len()).collect();
    order.sort_by(|a, b| {
        let (a, b) = (tiles[*a].tile, tiles[*b].tile);
        b.z.cmp(&a.z).then(a.x.cmp(&b.x)).then(a.y.cmp(&b.y))
    });
    for layer in (0..layer_count).rev() {
        for &tile_index in &order {
            let tile = &tiles[tile_index];
            let Some(LayerBucket::Symbols(bucket)) = tile.buckets.layers.get(layer) else {
                continue;
            };
            // Symbols whose overlap settings show them wherever they land.
            let always_text = bucket.text_allow_overlap
                && (bucket.icon_allow_overlap || !bucket.has_icons() || bucket.icon_optional);
            let always_icon = bucket.icon_allow_overlap
                && (bucket.text_allow_overlap || !bucket.has_text() || bucket.text_optional);
            let text_size = bucket.text_size.at_zoom(zoom);
            // `text-translate` and `icon-translate` move the anchors in the tile.
            let text_shift = bucket.text_translate.uv(bearing, tile.projection.tile_px);
            let icon_shift = bucket.icon_translate.uv(bearing, tile.projection.tile_px);
            let text_project = tile.projection.shifted(text_shift);
            let icon_project = tile.projection.shifted(icon_shift);
            let text_projection = tile.projection.with(&text_project);
            let icon_projection = tile.projection.with(&icon_project);
            for (instance_index, instance) in bucket.instances.iter().enumerate() {
                let memory_key = (tile.tile, layer, instance_index);
                let (Some((_, ratio)), Some(_)) = (
                    text_projection.anchor(instance.anchor),
                    icon_projection.anchor(instance.anchor),
                ) else {
                    continue;
                };
                let text_label = AlignedLabel {
                    projection: &text_projection,
                    anchor: instance.anchor,
                    alignment: bucket.text_alignment(),
                    bearing,
                };
                // Placement reads the text alignments for icons too.
                let icon_label = AlignedLabel {
                    projection: &icon_projection,
                    anchor: instance.anchor,
                    alignment: bucket.text_alignment(),
                    bearing,
                };
                let mut text_circles = None;
                let mut variable_choice = None;
                let mut variable_shift = None;
                // An icon fitted to variable text moves with it and must fit with it.
                let fitted_icon_box = |instance: &SymbolInstance| {
                    (bucket.icon_text_fit && !bucket.icon_allow_overlap)
                        .then_some(instance.icon.as_ref())
                        .flatten()
                        .map(|icon| (&icon_label, icon.collision_box))
                };
                let text_box = match (&instance.text, &instance.line) {
                    (Some(text), Some(symbol_line)) if text.line.is_some() => {
                        let line = text.line.as_ref().expect("line label");
                        let context = LineLabelContext {
                            projection: &text_projection,
                            pitch_with_map: bucket.pitch_with_map,
                            line: &symbol_line.points,
                            anchor: [instance.anchor[0] * EXTENT, instance.anchor[1] * EXTENT],
                            segment: symbol_line.segment,
                            rotate_to_line: true,
                        };
                        let glyphs = LineGlyphs {
                            offsets: &line.offsets,
                            line_offset: line.line_offset,
                        };
                        text_circles = line.circle_diameter.and_then(|diameter| {
                            index.place_circles(&LineCollision {
                                context: &context,
                                glyphs: &glyphs,
                                font_size: bucket.text_size.for_feature(text_size, text.sizes),
                                circle_diameter: diameter,
                                padding: bucket.text_padding,
                                allow_overlap: bucket.text_allow_overlap,
                            })
                        });
                        None
                    }
                    (Some(text), _) if text.variable.is_some() => {
                        let variable = text.variable.as_ref().expect("variable label");
                        let prior = previous.get(&memory_key).copied();
                        let placed = place_variable_text(
                            &index,
                            variable,
                            prior,
                            &text_label,
                            text.collision_box,
                            bucket.text_allow_overlap,
                            fitted_icon_box(instance),
                        );
                        match placed {
                            Some((choice, shift, b)) => {
                                variable_choice = Some(choice);
                                variable_shift = Some(shift);
                                memory.insert(memory_key, variable.anchors[choice].0);
                                Some(b)
                            }
                            None => {
                                if let Some(prior) = prior {
                                    memory.insert(memory_key, prior);
                                }
                                None
                            }
                        }
                    }
                    (Some(text), _) => index.place_aligned_box(
                        &text_label,
                        text.collision_box,
                        None,
                        bucket.text_allow_overlap,
                    ),
                    (None, _) => None,
                };
                // An icon fitted to its text moves with the chosen anchor.
                let icon_shift = variable_shift.filter(|_| bucket.icon_text_fit);
                let icon_box = instance.icon.as_ref().and_then(|icon| {
                    index.place_aligned_box(
                        &icon_label,
                        icon.collision_box,
                        icon_shift,
                        bucket.icon_allow_overlap,
                    )
                });
                let (mut place_text, mut place_icon) = (
                    text_box.is_some()
                        || text_circles.is_some()
                        || (bucket.text_allow_overlap
                            && instance
                                .text
                                .as_ref()
                                .is_some_and(|text| text.line.is_some())),
                    icon_box.is_some(),
                );
                let icon_without_text = bucket.text_optional || instance.text.is_none();
                let text_without_icon = bucket.icon_optional || instance.icon.is_none();
                if !icon_without_text && !text_without_icon {
                    place_text = place_text && place_icon;
                    place_icon = place_text;
                } else if !text_without_icon {
                    place_text = place_icon && place_text;
                } else if !icon_without_text {
                    place_icon = place_icon && place_text;
                }
                if let (true, Some(b)) = (place_text, text_box) {
                    index.insert(b, bucket.text_ignore_placement);
                }
                if let (true, Some(b)) = (place_icon, icon_box) {
                    index.insert(b, bucket.icon_ignore_placement);
                }
                if let (true, Some(circles)) = (place_text, &text_circles) {
                    index.insert_circles(circles, bucket.text_ignore_placement);
                }
                // A variable label without an anchor has nowhere to draw.
                let variable_unplaced = variable_choice.is_none()
                    && instance
                        .text
                        .as_ref()
                        .is_some_and(|text| text.variable.is_some());
                let text =
                    instance.text.is_some() && (place_text || always_text) && !variable_unplaced;
                let icon = instance.icon.is_some() && (place_icon || always_icon);
                if text || icon {
                    placed[layer].push(PlacedSymbol {
                        tile: tile_index,
                        layer,
                        instance: instance_index,
                        perspective_ratio: ratio,
                        text,
                        icon,
                        variable_anchor: if text { variable_choice } else { None },
                    });
                }
            }
        }
    }
    placed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::symbol::layout::SymbolBucket;

    #[test]
    fn overlapping_boxes_collide_and_separate_ones_do_not() {
        let mut index = CollisionIndex::new(200.0, 100.0);
        let label = [-20.0, -8.0, 20.0, 8.0];
        let first = index.place_box([50.0, 50.0], 1.0, label, false).unwrap();
        index.insert(first, false);
        assert!(index.place_box([70.0, 55.0], 1.0, label, false).is_none());
        assert!(index.place_box([70.0, 55.0], 1.0, label, true).is_some());
        assert!(index.place_box([150.0, 50.0], 1.0, label, false).is_some());
        // Outside the padded grid.
        assert!(index.place_box([-400.0, 50.0], 1.0, label, false).is_none());
    }

    #[test]
    fn map_aligned_boxes_turn_with_the_map_and_lie_on_its_plane() {
        let index = CollisionIndex::new(512.0, 512.0);
        let icon = [-10.0, -5.0, 10.0, 5.0];
        let aligned = |projection, pitch_with_map| AlignedLabel {
            projection,
            anchor: [0.5, 0.5],
            alignment: SymbolAlignment {
                rotate_with_map: true,
                pitch_with_map,
            },
            bearing: 0.0,
        };
        // North up: the box keeps its shape on and off the map plane.
        let flat = |uv: [f64; 2]| ([uv[0] * 512.0, uv[1] * 512.0], 1.0);
        let north_up = TileProjection {
            project: &flat,
            center_w: 1.0,
            tile_px: 512.0,
        };
        let expected = [346.0, 351.0, 366.0, 361.0];
        for pitch_with_map in [false, true] {
            let b = index
                .place_aligned_box(&aligned(&north_up, pitch_with_map), icon, None, false)
                .unwrap();
            for (actual, expected) in b.iter().zip(expected) {
                assert!((actual - expected).abs() < 1e-9, "{b:?}");
            }
        }
        // Map east pointing down the screen (bearing 90°): the box stands upright.
        let turned = |uv: [f64; 2]| ([512.0 - uv[1] * 512.0, uv[0] * 512.0], 1.0);
        let east_down = TileProjection {
            project: &turned,
            center_w: 1.0,
            tile_px: 512.0,
        };
        for pitch_with_map in [false, true] {
            let b = index
                .place_aligned_box(&aligned(&east_down, pitch_with_map), icon, None, false)
                .unwrap();
            for (actual, expected) in b.iter().zip([351.0, 346.0, 361.0, 366.0]) {
                assert!((actual - expected).abs() < 1e-9, "{b:?}");
            }
        }
    }

    #[test]
    fn map_plane_boxes_stay_along_the_viewport_without_map_rotation() {
        let index = CollisionIndex::new(512.0, 512.0);
        let icon = [-10.0, -5.0, 10.0, 5.0];
        // Map east pointing down the screen: the camera faces west of north.
        let turned = |uv: [f64; 2]| ([512.0 - uv[1] * 512.0, uv[0] * 512.0], 1.0);
        let east_down = TileProjection {
            project: &turned,
            center_w: 1.0,
            tile_px: 512.0,
        };
        let label = AlignedLabel {
            projection: &east_down,
            anchor: [0.5, 0.5],
            alignment: SymbolAlignment {
                rotate_with_map: false,
                pitch_with_map: true,
            },
            bearing: -std::f64::consts::FRAC_PI_2,
        };
        let b = index.place_aligned_box(&label, icon, None, false).unwrap();
        for (actual, expected) in b.iter().zip([346.0, 351.0, 366.0, 361.0]) {
            assert!((actual - expected).abs() < 1e-9, "{b:?}");
        }
    }

    #[test]
    fn map_plane_boxes_scale_with_distance_unless_a_variable_anchor_shifts_them() {
        let index = CollisionIndex::new(512.0, 512.0);
        let icon = [-10.0, -5.0, 10.0, 5.0];
        // Three times the centre distance: the shader's map-plane ratio is 2.
        let far = |uv: [f64; 2]| ([uv[0] * 512.0, uv[1] * 512.0], 3.0);
        let projection = TileProjection {
            project: &far,
            center_w: 1.0,
            tile_px: 512.0,
        };
        let label = AlignedLabel {
            projection: &projection,
            anchor: [0.5, 0.5],
            alignment: SymbolAlignment {
                rotate_with_map: true,
                pitch_with_map: true,
            },
            bearing: 0.0,
        };
        let plain = index.place_aligned_box(&label, icon, None, false).unwrap();
        assert!((plain[2] - plain[0] - 40.0).abs() < 1e-9, "{plain:?}");
        let shifted = index
            .place_aligned_box(&label, icon, Some([0.0, 0.0]), false)
            .unwrap();
        assert!((shifted[2] - shifted[0] - 20.0).abs() < 1e-9, "{shifted:?}");
    }

    #[test]
    fn translations_move_anchors_along_the_tile_or_the_turned_viewport() {
        use crate::symbol::layout::SymbolTranslate;
        let map = SymbolTranslate {
            offset: [10.0, 0.0],
            viewport: false,
        };
        assert_eq!(
            map.uv(std::f64::consts::FRAC_PI_2, 512.0),
            [10.0 / 512.0, 0.0]
        );
        // Viewport right under a 90° bearing is the tile's south.
        let viewport = SymbolTranslate {
            viewport: true,
            ..map
        };
        let [x, y] = viewport.uv(std::f64::consts::FRAC_PI_2, 512.0);
        assert!(x.abs() < 1e-12 && (y - 10.0 / 512.0).abs() < 1e-12);
    }

    #[test]
    fn circles_collide_with_boxes_and_circles() {
        let mut grid = GridIndex::new(200.0, 200.0);
        grid.insert([0.0, 0.0, 10.0, 10.0]);
        grid.insert_circle([100.0, 100.0, 10.0]);
        assert!(grid.hit_test_circle([15.0, 5.0, 6.0]));
        // Diagonally off the box corner: the square around the circle overlaps, not the circle.
        assert!(!grid.hit_test_circle([17.0, 17.0, 8.0]));
        assert!(grid.hit_test_circle([115.0, 100.0, 6.0]));
        assert!(!grid.hit_test_circle([117.0, 100.0, 6.0]));
        assert!(grid.hit_test([105.0, 95.0, 120.0, 105.0]));
    }

    /// `place_symbols` over one tile holding `bucket`.
    fn variable_placement(
        bucket: SymbolBucket,
        memory: &mut VariableAnchorMemory,
    ) -> Vec<PlacedSymbol> {
        let buckets = TileStyleBuckets {
            layers: vec![LayerBucket::Symbols(Box::new(bucket))],
            ..TileStyleBuckets::default()
        };
        let project = |uv: [f64; 2]| ([uv[0] * 400.0, uv[1] * 400.0], 1.0);
        let tiles = [PlacementTile {
            tile: TileId::new(0, 0, 0).unwrap(),
            buckets: &buckets,
            projection: TileProjection {
                project: &project,
                center_w: 1.0,
                tile_px: 400.0,
            },
        }];
        place_symbols(&tiles, 1, 400.0, 400.0, 0.0, 0.0, memory).remove(0)
    }

    /// An offset clearing a 20 px box centred on the anchor, towards a `left` anchor's side.
    fn far(anchor: SymbolAnchor) -> [f64; 2] {
        if anchor == SymbolAnchor::Left {
            [30.0, 0.0]
        } else {
            [0.0, 0.0]
        }
    }

    fn variable_instance(anchors: &[SymbolAnchor]) -> SymbolInstance {
        let paint = crate::symbol::layout::SymbolPaint {
            color: [0.0; 4],
            halo_color: [0.0; 4],
            halo_width: 0.0,
            halo_blur: 0.0,
            opacity: 1.0,
        };
        SymbolInstance {
            anchor: [0.5, 0.5],
            line: None,
            text: Some(crate::symbol::layout::SymbolText {
                collision_box: [-10.0, -5.0, 10.0, 5.0],
                glyphs: Vec::new(),
                sizes: [16.0; 2],
                stack: String::new(),
                paint: [paint.clone(), paint],
                line: None,
                variable: Some(VariableText {
                    anchors: anchors
                        .iter()
                        .map(|anchor| (*anchor, far(*anchor)))
                        .collect(),
                    box_scale: 1.0,
                    justified: Vec::new(),
                }),
            }),
            icon: None,
            feature_index: 0,
        }
    }

    #[test]
    fn variable_labels_take_the_first_anchor_that_fits() {
        // The first label takes the centre; the second is the same point, so `center` hits
        // it and `left` (its box to the right) does not.
        let mut memory = VariableAnchorMemory::default();
        let placed = variable_placement(
            SymbolBucket {
                instances: vec![
                    variable_instance(&[SymbolAnchor::Center]),
                    variable_instance(&[SymbolAnchor::Center, SymbolAnchor::Left]),
                ],
                variable_anchors: true,
                ..SymbolBucket::default()
            },
            &mut memory,
        );
        assert_eq!(
            placed
                .iter()
                .map(|symbol| (symbol.instance, symbol.variable_anchor))
                .collect::<Vec<_>>(),
            vec![(0, Some(0)), (1, Some(1))]
        );
        assert_eq!(
            memory[&(TileId::new(0, 0, 0).unwrap(), 0, 1)],
            SymbolAnchor::Left
        );
    }

    #[test]
    fn a_variable_label_prefers_its_last_anchor_while_it_still_fits() {
        let bucket = || SymbolBucket {
            instances: vec![variable_instance(&[
                SymbolAnchor::Center,
                SymbolAnchor::Left,
                SymbolAnchor::Right,
            ])],
            variable_anchors: true,
            ..SymbolBucket::default()
        };
        let key = (TileId::new(0, 0, 0).unwrap(), 0, 0);
        // The free centre would win a first placement, but the last anchor is tried first.
        let mut memory = VariableAnchorMemory::from([(key, SymbolAnchor::Right)]);
        let placed = variable_placement(bucket(), &mut memory);
        assert_eq!(placed[0].variable_anchor, Some(2));
        assert_eq!(memory[&key], SymbolAnchor::Right);
    }

    #[test]
    fn a_variable_label_with_no_fitting_anchor_is_hidden_and_keeps_its_memory() {
        let key = (TileId::new(0, 0, 0).unwrap(), 0, 1);
        let mut memory = VariableAnchorMemory::from([(key, SymbolAnchor::Left)]);
        let placed = variable_placement(
            SymbolBucket {
                instances: vec![
                    variable_instance(&[SymbolAnchor::Center]),
                    variable_instance(&[SymbolAnchor::Center]),
                ],
                variable_anchors: true,
                ..SymbolBucket::default()
            },
            &mut memory,
        );
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].instance, 0);
        assert_eq!(memory[&key], SymbolAnchor::Left);
        // With `text-allow-overlap` the second pass ignores collisions.
        let placed = variable_placement(
            SymbolBucket {
                instances: vec![
                    variable_instance(&[SymbolAnchor::Center]),
                    variable_instance(&[SymbolAnchor::Center]),
                ],
                variable_anchors: true,
                text_allow_overlap: true,
                ..SymbolBucket::default()
            },
            &mut VariableAnchorMemory::default(),
        );
        assert_eq!(placed.len(), 2);
        assert_eq!(placed[1].variable_anchor, Some(0));
    }

    #[test]
    fn an_icon_fitted_to_variable_text_must_fit_at_the_same_shift() {
        // A fitted icon around each text: the second can't sit on the first at `center`, so
        // it moves with `left` and both its boxes fit.
        let with_icon = |instance: SymbolInstance| {
            let paint = instance.text.as_ref().unwrap().paint.clone();
            SymbolInstance {
                icon: Some(crate::symbol::layout::SymbolIcon {
                    image: "shield".to_owned(),
                    quads: Vec::new(),
                    collision_box: [-14.0, -8.0, 14.0, 8.0],
                    line_offset: [0.0; 2],
                    sizes: [1.0; 2],
                    pixel_ratio: 1.0,
                    paint,
                }),
                ..instance
            }
        };
        let placed = variable_placement(
            SymbolBucket {
                instances: vec![
                    with_icon(variable_instance(&[SymbolAnchor::Center])),
                    with_icon(variable_instance(&[
                        SymbolAnchor::Center,
                        SymbolAnchor::Left,
                    ])),
                ],
                icon_text_fit: true,
                variable_anchors: true,
                ..SymbolBucket::default()
            },
            &mut VariableAnchorMemory::default(),
        );
        assert_eq!(
            placed
                .iter()
                .map(|symbol| (symbol.text, symbol.icon, symbol.variable_anchor))
                .collect::<Vec<_>>(),
            vec![(true, true, Some(0)), (true, true, Some(1))]
        );
    }

    #[test]
    fn icons_and_text_place_jointly_unless_one_is_optional() {
        use crate::symbol::layout::{SymbolIcon, SymbolPaint, SymbolText};
        let paint = SymbolPaint {
            color: [0.0; 4],
            halo_color: [0.0; 4],
            halo_width: 0.0,
            halo_blur: 0.0,
            opacity: 1.0,
        };
        // Two symbols on one anchor: the second's text hits the first's, its icon (offset
        // far right) does not.
        let symbol = |icon_box: [f64; 4]| SymbolInstance {
            anchor: [0.5, 0.5],
            line: None,
            text: Some(SymbolText {
                collision_box: [-10.0, -5.0, 10.0, 5.0],
                glyphs: Vec::new(),
                sizes: [16.0; 2],
                stack: String::new(),
                paint: [paint.clone(), paint.clone()],
                line: None,
                variable: None,
            }),
            icon: Some(SymbolIcon {
                image: "dot".to_owned(),
                quads: Vec::new(),
                collision_box: icon_box,
                line_offset: [0.0; 2],
                sizes: [1.0; 2],
                pixel_ratio: 1.0,
                paint: [paint.clone(), paint.clone()],
            }),
            feature_index: 0,
        };
        let place = |text_optional: bool| {
            let buckets = TileStyleBuckets {
                layers: vec![LayerBucket::Symbols(Box::new(SymbolBucket {
                    instances: vec![
                        symbol([-4.0, -4.0, 4.0, 4.0]),
                        symbol([40.0, -4.0, 48.0, 4.0]),
                    ],
                    text_optional,
                    ..SymbolBucket::default()
                }))],
                ..TileStyleBuckets::default()
            };
            let project = |uv: [f64; 2]| ([uv[0] * 200.0, uv[1] * 100.0], 1.0);
            let tiles = [PlacementTile {
                tile: TileId::new(0, 0, 0).unwrap(),
                buckets: &buckets,
                projection: TileProjection {
                    project: &project,
                    center_w: 1.0,
                    tile_px: 200.0,
                },
            }];
            place_symbols(&tiles, 1, 200.0, 100.0, 0.0, 0.0, &mut Default::default())[0]
                .iter()
                .map(|symbol| (symbol.instance, symbol.text, symbol.icon))
                .collect::<Vec<_>>()
        };
        assert_eq!(place(false), vec![(0, true, true)]);
        assert_eq!(place(true), vec![(0, true, true), (1, false, true)]);
    }
}
