//! MapLibre's GeoJSON source geometry for lines (#334): a port of `@maplibre/geojson-vt`.
//!
//! MapLibre tiles GeoJSON with geojson-vt before drawing it. That ranks every vertex once
//! with Douglas-Peucker (`simplify.ts`, at the source `maxzoom`), keeps per tile zoom only
//! the vertices whose rank beats that zoom's tolerance (`tile.ts` `addLine`), drops lines
//! shorter than the tolerance, and rounds what is left to the tile's 8192-unit grid
//! (`transform.ts`). With MapLibre's defaults (`tolerance` 0.375 px, `maxzoom` 18, 512 px
//! tiles) a line therefore deviates up to 0.375 px from its coordinates and snaps to 1/16 px.
//!
//! Coordinates here are Web Mercator world units (`[0, 1]`, +y south), as geojson-vt uses.

/// MapLibre's vector tile extent (`EXTENT`).
pub const GEOJSON_VT_EXTENT: f64 = 8192.0;
/// MapLibre's GeoJSON source default `maxzoom`, which it passes to geojson-vt.
pub const GEOJSON_VT_MAX_ZOOM: u8 = 18;
/// MapLibre's default `tolerance` of 0.375 px in tile units (`EXTENT / tileSize` = 16).
pub const GEOJSON_VT_TOLERANCE: f64 = 0.375 * GEOJSON_VT_EXTENT / 512.0;

/// A line ranked for per-zoom simplification.
#[derive(Clone, Debug, PartialEq)]
pub struct SimplifiedLine {
    points: Vec<[f64; 2]>,
    /// geojson-vt's squared importance per vertex: 1 at both ends, 0 when only the
    /// `maxzoom` tile keeps it.
    importance: Vec<f64>,
    /// Length in world units (`size` in geojson-vt).
    length: f64,
}

impl SimplifiedLine {
    /// Ranks `points` as geojson-vt's `convertLine` does.
    #[must_use]
    pub fn new(points: Vec<[f64; 2]>) -> Self {
        let length = points
            .windows(2)
            .map(|pair| (pair[1][0] - pair[0][0]).hypot(pair[1][1] - pair[0][1]))
            .sum();
        let mut importance = vec![0.0; points.len()];
        if let Some(last) = points.len().checked_sub(1) {
            importance[0] = 1.0;
            let tolerance =
                GEOJSON_VT_TOLERANCE / (f64::from(GEOJSON_VT_MAX_ZOOM).exp2() * GEOJSON_VT_EXTENT);
            simplify(&points, &mut importance, 0, last, tolerance * tolerance);
            importance[last] = 1.0;
        }
        Self {
            points,
            importance,
            length,
        }
    }

    /// The line as the zoom-`z` tile holds it: simplified, rounded to the tile grid and
    /// back in world units. Empty when geojson-vt drops the line as too short.
    #[must_use]
    pub fn at_zoom(&self, z: u8) -> Vec<[f64; 2]> {
        let z = z.min(GEOJSON_VT_MAX_ZOOM);
        let grid = f64::from(z).exp2() * GEOJSON_VT_EXTENT;
        let tolerance = if z == GEOJSON_VT_MAX_ZOOM {
            0.0
        } else {
            GEOJSON_VT_TOLERANCE / grid
        };
        if tolerance > 0.0 && self.length < tolerance {
            return Vec::new();
        }
        let sq_tolerance = tolerance * tolerance;
        // `Math.round`: coordinates are non-negative, so half away from zero is half up.
        let snap = |value: f64| (value * grid).round() / grid;
        self.points
            .iter()
            .zip(&self.importance)
            .filter(|&(_, &importance)| tolerance == 0.0 || importance > sq_tolerance)
            .map(|(&[x, y], _)| [snap(x), snap(y)])
            .collect()
    }
}

/// MapLibre's GeoJSON source `buffer` (128 px of a 512 px tile) as a tile fraction.
const GEOJSON_VT_BUFFER: f64 = 128.0 / 512.0;

/// One tile's part of a line, as the zoom-`z` GeoJSON tile `x`/`y` holds it (#322): clipped
/// to the tile and its buffer, simplified, in tile units (`[0, 8192]` inside the tile).
/// MapLibre measures dash distances from the start of each such piece.
#[derive(Clone, Debug, PartialEq)]
pub struct TileLinePiece {
    pub x: u32,
    pub y: u32,
    pub points: Vec<[f64; 2]>,
}

impl SimplifiedLine {
    /// The line cut into the zoom-`z` tiles it crosses, as geojson-vt's `clip` and
    /// `transform` do: points keep their rank, cuts at the buffered tile edges are always
    /// kept, then the tile's simplification and grid apply.
    #[must_use]
    pub fn tile_pieces(&self, z: u8) -> Vec<TileLinePiece> {
        let z = z.min(GEOJSON_VT_MAX_ZOOM);
        let tiles = f64::from(z).exp2();
        let tolerance = if z == GEOJSON_VT_MAX_ZOOM {
            0.0
        } else {
            GEOJSON_VT_TOLERANCE / (tiles * GEOJSON_VT_EXTENT)
        };
        if self.points.len() < 2 || (tolerance > 0.0 && self.length < tolerance) {
            return Vec::new();
        }
        let sq_tolerance = tolerance * tolerance;
        let line: Vec<[f64; 3]> = self
            .points
            .iter()
            .zip(&self.importance)
            .map(|(&[x, y], &importance)| [x * tiles, y * tiles, importance])
            .collect();
        let last_tile = tiles - 1.0;
        let tile_range = |values: &mut dyn Iterator<Item = f64>| {
            let (min, max) =
                values.fold((f64::MAX, f64::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)));
            let first = (min - GEOJSON_VT_BUFFER).floor().max(0.0);
            let last = (max + GEOJSON_VT_BUFFER).floor().min(last_tile);
            (first as u32, last as u32)
        };
        let mut pieces = Vec::new();
        let (x0, x1) = tile_range(&mut line.iter().map(|point| point[0]));
        for x in x0..=x1 {
            let start = f64::from(x) - GEOJSON_VT_BUFFER;
            for column in clip_line(&line, start, start + 1.0 + 2.0 * GEOJSON_VT_BUFFER, 0) {
                let (y0, y1) = tile_range(&mut column.iter().map(|point| point[1]));
                for y in y0..=y1 {
                    let start = f64::from(y) - GEOJSON_VT_BUFFER;
                    for slice in clip_line(&column, start, start + 1.0 + 2.0 * GEOJSON_VT_BUFFER, 1)
                    {
                        let points: Vec<[f64; 2]> = slice
                            .iter()
                            .filter(|point| tolerance == 0.0 || point[2] > sq_tolerance)
                            .map(|&[px, py, _]| {
                                [
                                    (GEOJSON_VT_EXTENT * (px - f64::from(x)) + 0.5).floor(),
                                    (GEOJSON_VT_EXTENT * (py - f64::from(y)) + 0.5).floor(),
                                ]
                            })
                            .collect();
                        if !points.is_empty() {
                            pieces.push(TileLinePiece { x, y, points });
                        }
                    }
                }
            }
        }
        pieces
    }
}

/// geojson-vt's `clipLine` for an open line between `start` and `end` on `axis`: the parts
/// inside, with cut points of importance 1.
fn clip_line(line: &[[f64; 3]], start: f64, end: f64, axis: usize) -> Vec<Vec<[f64; 3]>> {
    let mut slices = Vec::new();
    let mut slice: Vec<[f64; 3]> = Vec::new();
    let intersect = |a: [f64; 3], b: [f64; 3], at: f64| -> [f64; 3] {
        let t = (at - a[axis]) / (b[axis] - a[axis]);
        let other = 1 - axis;
        let mut point = [0.0, 0.0, 1.0];
        point[axis] = at;
        point[other] = a[other] + (b[other] - a[other]) * t;
        point
    };
    for pair in line.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let (av, bv) = (a[axis], b[axis]);
        let mut exited = false;
        if av < start {
            if bv >= start {
                slice.push(intersect(a, b, start));
            }
        } else if av > end {
            if bv <= end {
                slice.push(intersect(a, b, end));
            }
        } else {
            slice.push(a);
        }
        if bv < start && av >= start {
            slice.push(intersect(a, b, start));
            exited = true;
        }
        if bv > end && av <= end {
            slice.push(intersect(a, b, end));
            exited = true;
        }
        if exited {
            slices.push(std::mem::take(&mut slice));
        }
    }
    if let Some(&last) = line.last()
        && last[axis] >= start
        && last[axis] <= end
    {
        slice.push(last);
    }
    if !slice.is_empty() {
        slices.push(slice);
    }
    slices
}

/// geojson-vt's iterative Douglas-Peucker: each split vertex records its squared distance.
fn simplify(
    points: &[[f64; 2]],
    importance: &mut [f64],
    first: usize,
    last: usize,
    sq_tolerance: f64,
) {
    let mut stack = vec![(first, last)];
    while let Some((first, last)) = stack.pop() {
        let mut max_sq_distance = sq_tolerance;
        let mid = first + ((last - first) >> 1);
        let mut min_position_to_mid = last - first;
        let mut index = None;
        for i in first + 1..last {
            let distance = sq_segment_distance(points[i], points[first], points[last]);
            if distance > max_sq_distance {
                index = Some(i);
                max_sq_distance = distance;
            } else if distance == max_sq_distance {
                // geojson-vt#104: prefer a pivot near the middle for degenerate inputs.
                let position_to_mid = i.abs_diff(mid);
                if position_to_mid < min_position_to_mid {
                    index = Some(i);
                    min_position_to_mid = position_to_mid;
                }
            }
        }
        if max_sq_distance > sq_tolerance
            && let Some(index) = index
        {
            importance[index] = max_sq_distance;
            if index - first > 1 {
                stack.push((first, index));
            }
            if last - index > 1 {
                stack.push((index, last));
            }
        }
    }
}

fn sq_segment_distance(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let [mut x, mut y] = a;
    let (dx, dy) = (b[0] - x, b[1] - y);
    if dx != 0.0 || dy != 0.0 {
        let t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
        if t > 1.0 {
            [x, y] = b;
        } else if t > 0.0 {
            x += dx * t;
            y += dy * t;
        }
    }
    (point[0] - x).powi(2) + (point[1] - y).powi(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One zoom-`z` CSS px in world units.
    fn px(z: u8) -> f64 {
        1.0 / (512.0 * f64::from(z).exp2())
    }

    #[test]
    fn keeps_a_vertex_only_at_zooms_where_it_deviates_by_more_than_the_tolerance() {
        // The middle vertex sits 0.5 px off the chord at z8, 0.25 px at z7.
        let line = SimplifiedLine::new(vec![
            [0.5, 0.5],
            [0.5 + 50.0 * px(8), 0.5 + 0.5 * px(8)],
            [0.5 + 100.0 * px(8), 0.5],
        ]);
        assert_eq!(line.at_zoom(8).len(), 3);
        assert_eq!(line.at_zoom(7).len(), 2);
    }

    #[test]
    fn snaps_to_the_tile_grid_and_keeps_everything_at_maxzoom() {
        let points = vec![[0.3, 0.4], [0.3 + 1.0e-9, 0.4 + 2.0e-9], [0.31, 0.4]];
        let line = SimplifiedLine::new(points.clone());
        let grid = 8.0_f64.exp2() * GEOJSON_VT_EXTENT;
        for [x, y] in line.at_zoom(8) {
            assert_eq!((x * grid).fract(), 0.0);
            assert_eq!((y * grid).fract(), 0.0);
        }
        assert_eq!(line.at_zoom(20).len(), points.len());
    }

    #[test]
    fn tile_pieces_cut_the_line_at_each_buffered_tile_edge() {
        // A straight z8 line across three tiles, from mid tile 100 to mid tile 102.
        let tile = 1.0 / 256.0;
        let line = SimplifiedLine::new(vec![
            [100.5 * tile, 50.5 * tile],
            [102.5 * tile, 50.5 * tile],
        ]);
        let pieces = line.tile_pieces(8);
        let tiles: Vec<(u32, u32)> = pieces.iter().map(|piece| (piece.x, piece.y)).collect();
        assert_eq!(tiles, [(100, 50), (101, 50), (102, 50)]);
        assert_eq!(pieces[0].points, [[4096.0, 4096.0], [10240.0, 4096.0]]);
        // The middle tile holds the line from one buffer edge to the other.
        assert_eq!(pieces[1].points, [[-2048.0, 4096.0], [10240.0, 4096.0]]);
        assert_eq!(pieces[2].points, [[-2048.0, 4096.0], [4096.0, 4096.0]]);
    }

    #[test]
    fn drops_lines_shorter_than_the_tolerance() {
        let line = SimplifiedLine::new(vec![[0.5, 0.5], [0.5 + 0.2 * px(8), 0.5]]);
        assert!(line.at_zoom(8).is_empty());
        assert_eq!(line.at_zoom(18).len(), 2);
    }
}
