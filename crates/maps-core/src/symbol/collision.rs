//! Symbol collision, ported from MapLibre 6.15 `grid_index.ts`, `collision_index.ts` and the
//! box path of `placement.ts`: viewport-aligned point labels are placed top layer first, tiles
//! in MapLibre's symbol order, each label's padded box tested against those already placed.

use super::layout::{LayerBucket, TileStyleBuckets};
use crate::TileId;

/// Collision grids extend this far past the viewport (MapLibre `viewportPadding`).
pub const VIEWPORT_PADDING: f64 = 100.0;
const CELL_SIZE: f64 = 25.0;
/// Labels whose anchor is this foreshortened under pitch are not placed.
const PERSPECTIVE_RATIO_CUTOFF: f64 = 0.6;

/// `GridIndex` for boxes.
pub struct GridIndex {
    width: f64,
    height: f64,
    x_cells: usize,
    y_cells: usize,
    cells: Vec<Vec<usize>>,
    boxes: Vec<[f64; 4]>,
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

    /// Whether `b` overlaps any inserted box (every overlap mode here is `never`).
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
                for uid in &self.cells[self.x_cells * y + x] {
                    let other = self.boxes[*uid];
                    if b[0] <= other[2] + EPSILON
                        && b[1] <= other[3] + EPSILON
                        && b[2] >= other[0] - EPSILON
                        && b[3] >= other[1] - EPSILON
                    {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// `CollisionIndex` for viewport-aligned boxes.
pub struct CollisionIndex {
    grid: GridIndex,
    ignored: GridIndex,
    grid_right: f64,
    grid_bottom: f64,
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
            grid_right,
            grid_bottom,
        }
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
        let inside_grid =
            b[2] >= 0.0 && b[0] < self.grid_right && b[3] >= 0.0 && b[1] < self.grid_bottom;
        if perspective_ratio < PERSPECTIVE_RATIO_CUTOFF || !inside_grid {
            return None;
        }
        if !allow_overlap && self.grid.hit_test(b) {
            return None;
        }
        Some(b)
    }

    pub fn insert(&mut self, b: [f64; 4], ignore_placement: bool) {
        if ignore_placement {
            self.ignored.insert(b);
        } else {
            self.grid.insert(b);
        }
    }
}

/// A tile's symbols as placement sees them.
pub struct PlacementTile<'a> {
    pub tile: TileId,
    pub buckets: &'a TileStyleBuckets,
    /// Tile-normalized point to (viewport CSS px, perspective ratio); `None` behind the camera.
    pub project: &'a dyn Fn([f64; 2]) -> Option<([f64; 2], f64)>,
}

/// One label that won its place, with where its anchor projects.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacedSymbol {
    pub tile: usize,
    pub layer: usize,
    pub instance: usize,
    pub anchor: [f64; 2],
    pub perspective_ratio: f64,
}

/// MapLibre's symbol tile order (`getRenderableIds(true)`): zoom ascending, then bottom to
/// top and right to left in the rotated frame. Returns indices into `tiles`.
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

/// Places every symbol layer, top layer first. `tiles` must already be in
/// [`symbol_tile_order`]. Returns placed symbols per layer in placement order.
#[must_use]
pub fn place_symbols(
    tiles: &[PlacementTile<'_>],
    layer_count: usize,
    width: f64,
    height: f64,
) -> Vec<Vec<PlacedSymbol>> {
    let mut index = CollisionIndex::new(width, height);
    let mut placed = vec![Vec::new(); layer_count];
    for layer in (0..layer_count).rev() {
        for (tile_index, tile) in tiles.iter().enumerate() {
            let Some(LayerBucket::Symbols {
                instances,
                allow_overlap,
                ignore_placement,
            }) = tile.buckets.layers.get(layer)
            else {
                continue;
            };
            for (instance_index, instance) in instances.iter().enumerate() {
                let Some((anchor, ratio)) = (tile.project)(instance.anchor) else {
                    continue;
                };
                let Some(b) =
                    index.place_box(anchor, ratio, instance.collision_box, *allow_overlap)
                else {
                    continue;
                };
                index.insert(b, *ignore_placement);
                placed[layer].push(PlacedSymbol {
                    tile: tile_index,
                    layer,
                    instance: instance_index,
                    anchor,
                    perspective_ratio: ratio,
                });
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
}
