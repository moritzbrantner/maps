//! MapLibre's `findPoleOfInaccessibility` and `classifyRings`, for point labels on polygons.

type Point = [f64; 2];

/// Groups rings into polygons by winding, as `classifyRings(rings, 0)`.
#[must_use]
pub fn classify_rings(rings: &[Vec<Point>]) -> Vec<Vec<Vec<Point>>> {
    if rings.len() <= 1 {
        return vec![rings.to_vec()];
    }
    let mut polygons = Vec::new();
    let mut polygon: Option<Vec<Vec<Point>>> = None;
    let mut ccw = None;
    for ring in rings {
        let area = signed_area(ring);
        if area == 0.0 {
            continue;
        }
        let ccw = *ccw.get_or_insert(area < 0.0);
        if ccw == (area < 0.0) {
            if let Some(polygon) = polygon.take() {
                polygons.push(polygon);
            }
            polygon = Some(vec![ring.clone()]);
        } else if let Some(polygon) = polygon.as_mut() {
            polygon.push(ring.clone());
        }
    }
    polygons.extend(polygon);
    polygons
}

fn signed_area(ring: &[Point]) -> f64 {
    let mut sum = 0.0;
    let len = ring.len();
    let mut j = len.wrapping_sub(1);
    for i in 0..len {
        let (p1, p2) = (ring[i], ring[j]);
        sum += (p2[0] - p1[0]) * (p1[1] + p2[1]);
        j = i;
    }
    sum
}

#[derive(Clone, Copy)]
struct Cell {
    p: Point,
    h: f64,
    d: f64,
    max: f64,
}

impl Cell {
    fn new(x: f64, y: f64, h: f64, polygon: &[Vec<Point>]) -> Self {
        let d = point_to_polygon_distance([x, y], polygon);
        Self {
            p: [x, y],
            h,
            d,
            max: d + h * std::f64::consts::SQRT_2,
        }
    }
}

/// `tinyqueue` with `compareMax`, so equal-potential cells pop in MapLibre's order.
struct Queue(Vec<Cell>);

impl Queue {
    fn less(a: &Cell, b: &Cell) -> bool {
        b.max - a.max < 0.0
    }
    fn push(&mut self, cell: Cell) {
        self.0.push(cell);
        let mut pos = self.0.len() - 1;
        while pos > 0 {
            let parent = (pos - 1) >> 1;
            if !Self::less(&self.0[pos], &self.0[parent]) {
                break;
            }
            self.0.swap(pos, parent);
            pos = parent;
        }
    }
    fn pop(&mut self) -> Option<Cell> {
        if self.0.is_empty() {
            return None;
        }
        let last = self.0.len() - 1;
        self.0.swap(0, last);
        let top = self.0.pop();
        let len = self.0.len();
        let mut pos = 0;
        while pos < len >> 1 {
            let mut best = (pos << 1) + 1;
            let right = best + 1;
            if right < len && Self::less(&self.0[right], &self.0[best]) {
                best = right;
            }
            if !Self::less(&self.0[best], &self.0[pos]) {
                break;
            }
            self.0.swap(pos, best);
            pos = best;
        }
        top
    }
}

/// `findPoleOfInaccessibility(polygonRings, precision)`.
#[must_use]
pub fn pole_of_inaccessibility(polygon: &[Vec<Point>], precision: f64) -> Point {
    let Some(outer) = polygon.first().filter(|ring| !ring.is_empty()) else {
        return [0.0, 0.0];
    };
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in outer {
        min_x = min_x.min(p[0]);
        min_y = min_y.min(p[1]);
        max_x = max_x.max(p[0]);
        max_y = max_y.max(p[1]);
    }
    let cell_size = (max_x - min_x).min(max_y - min_y);
    let h = cell_size / 2.0;
    if cell_size == 0.0 {
        return [min_x, min_y];
    }
    let mut queue = Queue(Vec::new());
    let mut x = min_x;
    while x < max_x {
        let mut y = min_y;
        while y < max_y {
            queue.push(Cell::new(x + h, y + h, h, polygon));
            y += cell_size;
        }
        x += cell_size;
    }
    let centroid = centroid_cell(polygon);
    let mut best = centroid;
    while let Some(cell) = queue.pop() {
        if cell.d > best.d || best.d == 0.0 || best.d.is_nan() {
            best = cell;
        }
        if cell.max - best.d <= precision {
            continue;
        }
        let h = cell.h / 2.0;
        let [cx, cy] = cell.p;
        queue.push(Cell::new(cx - h, cy - h, h, polygon));
        queue.push(Cell::new(cx + h, cy - h, h, polygon));
        queue.push(Cell::new(cx - h, cy + h, h, polygon));
        queue.push(Cell::new(cx + h, cy + h, h, polygon));
    }
    if centroid.d > 0.0 && best.d - centroid.d <= precision {
        return centroid.p;
    }
    best.p
}

fn centroid_cell(polygon: &[Vec<Point>]) -> Cell {
    let (mut area, mut x, mut y) = (0.0, 0.0, 0.0);
    let points = &polygon[0];
    let len = points.len();
    let mut j = len - 1;
    for i in 0..len {
        let (a, b) = (points[i], points[j]);
        let f = a[0] * b[1] - b[0] * a[1];
        x += (a[0] + b[0]) * f;
        y += (a[1] + b[1]) * f;
        area += f * 3.0;
        j = i;
    }
    Cell::new(x / area, y / area, 0.0, polygon)
}

fn point_to_polygon_distance(p: Point, polygon: &[Vec<Point>]) -> f64 {
    let mut inside = false;
    let mut min_distance_sq = f64::INFINITY;
    for ring in polygon {
        let len = ring.len();
        let mut j = len.wrapping_sub(1);
        for i in 0..len {
            let (a, b) = (ring[i], ring[j]);
            if (a[1] > p[1]) != (b[1] > p[1])
                && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
            {
                inside = !inside;
            }
            min_distance_sq = min_distance_sq.min(segment_distance_sq(p, a, b));
            j = i;
        }
    }
    (if inside { 1.0 } else { -1.0 }) * min_distance_sq.sqrt()
}

/// MapLibre's `distToSegmentSquared`.
fn segment_distance_sq(p: Point, v: Point, w: Point) -> f64 {
    let l2 = (v[0] - w[0]).powi(2) + (v[1] - w[1]).powi(2);
    if l2 == 0.0 {
        return (p[0] - v[0]).powi(2) + (p[1] - v[1]).powi(2);
    }
    let t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
    let point = if t < 0.0 {
        v
    } else if t > 1.0 {
        w
    } else {
        [v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1])]
    };
    (p[0] - point[0]).powi(2) + (p[1] - point[1]).powi(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_pole_is_its_center() {
        let ring = vec![
            [0.0, 0.0],
            [100.0, 0.0],
            [100.0, 100.0],
            [0.0, 100.0],
            [0.0, 0.0],
        ];
        let pole = pole_of_inaccessibility(&[ring], 1.0);
        assert!((pole[0] - 50.0).abs() < 1.0 && (pole[1] - 50.0).abs() < 1.0);
    }
}
