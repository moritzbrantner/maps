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
    fn drops_lines_shorter_than_the_tolerance() {
        let line = SimplifiedLine::new(vec![[0.5, 0.5], [0.5 + 0.2 * px(8), 0.5]]);
        assert!(line.at_zoom(8).is_empty());
        assert_eq!(line.at_zoom(18).len(), 2);
    }
}
