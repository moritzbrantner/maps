//! Symbol collision, ported from MapLibre 6.15 `grid_index.ts`, `collision_index.ts` and
//! `placement.ts`: labels are placed top layer first, tiles in MapLibre's symbol order, each
//! point label's padded box and each line label's circles along its line (#346) tested
//! against those already placed.

use super::layout::{EXTENT, LayerBucket, TileStyleBuckets};
use super::line_anchors::clip_line;
use super::projection::{LineGlyphs, LineLabelContext, PathInterpolator, TileProjection};
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
    pub anchor: [f64; 2],
    pub perspective_ratio: f64,
    pub text: bool,
    pub icon: bool,
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

/// Places every symbol layer, top layer first, at the camera `zoom`, tiles in MapLibre's
/// placement order (`Style._updatePlacement`: zoom descending, then `isLessThan`: x, then y
/// ascending). Returns placed symbols per layer in placement order, `tile` indexing `tiles`.
#[must_use]
pub fn place_symbols(
    tiles: &[PlacementTile<'_>],
    layer_count: usize,
    width: f64,
    height: f64,
    zoom: f64,
) -> Vec<Vec<PlacedSymbol>> {
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
            for (instance_index, instance) in bucket.instances.iter().enumerate() {
                let Some((anchor, ratio)) = tile.projection.anchor(instance.anchor) else {
                    continue;
                };
                let mut text_circles = None;
                let text_box = match &instance.text {
                    Some(text) if text.line.is_some() => {
                        let line = text.line.as_ref().expect("line label");
                        let context = LineLabelContext {
                            projection: &tile.projection,
                            pitch_with_map: bucket.pitch_with_map,
                            line: &line.line,
                            anchor: [instance.anchor[0] * EXTENT, instance.anchor[1] * EXTENT],
                            segment: line.segment,
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
                    Some(text) => index.place_box(
                        anchor,
                        ratio,
                        text.collision_box,
                        bucket.text_allow_overlap,
                    ),
                    None => None,
                };
                let icon_box = instance.icon.as_ref().and_then(|icon| {
                    index.place_box(anchor, ratio, icon.collision_box, bucket.icon_allow_overlap)
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
                let text = instance.text.is_some() && (place_text || always_text);
                let icon = instance.icon.is_some() && (place_icon || always_icon);
                if text || icon {
                    placed[layer].push(PlacedSymbol {
                        tile: tile_index,
                        layer,
                        instance: instance_index,
                        anchor,
                        perspective_ratio: ratio,
                        text,
                        icon,
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

    #[test]
    fn icons_and_text_place_jointly_unless_one_is_optional() {
        use crate::symbol::layout::{
            SymbolBucket, SymbolIcon, SymbolInstance, SymbolPaint, SymbolText,
        };
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
            text: Some(SymbolText {
                collision_box: [-10.0, -5.0, 10.0, 5.0],
                glyphs: Vec::new(),
                sizes: [16.0; 2],
                stack: String::new(),
                paint: [paint.clone(), paint.clone()],
                line: None,
            }),
            icon: Some(SymbolIcon {
                image: "dot".to_owned(),
                tl: [0.0; 2],
                br: [0.0; 2],
                collision_box: icon_box,
                sizes: [1.0; 2],
                pixel_ratio: 1.0,
                paint: [paint.clone(), paint.clone()],
            }),
            feature_index: 0,
        };
        let place = |text_optional: bool| {
            let buckets = TileStyleBuckets {
                layers: vec![LayerBucket::Symbols(SymbolBucket {
                    instances: vec![
                        symbol([-4.0, -4.0, 4.0, 4.0]),
                        symbol([40.0, -4.0, 48.0, 4.0]),
                    ],
                    text_optional,
                    ..SymbolBucket::default()
                })],
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
            place_symbols(&tiles, 1, 200.0, 100.0, 0.0)[0]
                .iter()
                .map(|symbol| (symbol.instance, symbol.text, symbol.icon))
                .collect::<Vec<_>>()
        };
        assert_eq!(place(false), vec![(0, true, true)]);
        assert_eq!(place(true), vec![(0, true, true), (1, false, true)]);
    }
}
