//! MapLibre's line bucket tessellation for round joins (#325, #326).
//!
//! A polyline becomes one triangle strip whose vertices carry a unit-width extrusion and
//! MapLibre's `v_normal` flags, so renderers extrude by their own outset (CSS px) and fade
//! by `length(normal)` exactly as `line.fragment.glsl` does. Joins follow `addLine` in
//! MapLibre's `line_bucket.ts` with `line-join: round` and the default `line-round-limit`:
//! a near-straight vertex is a miter, a turn up to 120 degrees is a bevel filled with pie
//! slices ("fakeround"), and a sharper turn ends and restarts the line with round caps.
//! Only that last case overlaps itself, as in MapLibre, so a translucent line blends once
//! per pixel everywhere else.

/// MapLibre's default `line-round-limit`: below this miter length a round join is a miter.
const ROUND_LIMIT: f64 = 1.05;
/// Angle per pie slice of a fake round join.
const DEG_PER_TRIANGLE: f64 = 20.0;

/// How an open line ends.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineCap {
    Butt,
    Round,
}

/// One strip vertex: the line point, the extrusion for a half width of 1, and MapLibre's
/// `v_normal` (`x` 1 on a round cap, `y` +1 or -1 by side).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineMeshVertex {
    pub point: [f64; 2],
    pub extrude: [f64; 2],
    pub normal: [f32; 2],
}

/// Triangles of every line added so far; indices are into `vertices`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LineMesh {
    pub vertices: Vec<LineMeshVertex>,
    pub indices: Vec<u32>,
    e1: Option<u32>,
    e2: Option<u32>,
}

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

fn unit(a: Point) -> Point {
    let length = a[0].hypot(a[1]);
    if length == 0.0 {
        a
    } else {
        scale(a, length.recip())
    }
}

/// `point-geometry`'s `perp`: a quarter turn.
fn perp(a: Point) -> Point {
    [-a[1], a[0]]
}

impl LineMesh {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.vertices.clear();
        self.indices.clear();
    }

    /// Adds one round-joined polyline. A `closed` ring is joined through its first vertex
    /// (MapLibre's polygon outline); otherwise both ends get `cap`. Consecutive duplicate
    /// points are skipped; a line without two distinct points adds nothing.
    pub fn add_line(&mut self, points: &[Point], cap: LineCap, closed: bool) {
        let mut vertices: Vec<Point> = Vec::with_capacity(points.len() + 1);
        for &point in points {
            if vertices.last() != Some(&point) {
                vertices.push(point);
            }
        }
        if closed {
            if vertices.len() > 1 && vertices.first() == vertices.last() {
                vertices.pop();
            }
            if vertices.len() < 3 {
                return;
            }
            // MapLibre rings repeat their first point.
            vertices.push(vertices[0]);
        } else if vertices.len() < 2 {
            return;
        }
        self.e1 = None;
        self.e2 = None;

        let len = vertices.len();
        let mut current: Option<Point> = None;
        let mut prev_vertex: Option<Point>;
        let mut prev_normal: Option<Point> = None;
        let mut next_normal: Option<Point> = None;
        if closed {
            current = Some(vertices[len - 2]);
            next_normal = Some(perp(unit(sub(vertices[0], vertices[len - 2]))));
        }

        for index in 0..len {
            let next_vertex = if index == len - 1 {
                closed.then(|| vertices[1])
            } else {
                Some(vertices[index + 1])
            };
            if next_normal.is_some() {
                prev_normal = next_normal;
            }
            prev_vertex = current;
            let vertex = vertices[index];
            current = Some(vertex);

            let next = next_vertex.map(|next| perp(unit(sub(next, vertex))));
            next_normal = next.or(prev_normal);
            let next_n = next_normal.expect("a line has a direction");
            let prev_n = *prev_normal.get_or_insert(next_n);

            let mut join_normal = add(prev_n, next_n);
            if join_normal != [0.0, 0.0] {
                join_normal = unit(join_normal);
            }
            let cos_angle = prev_n[0] * next_n[0] + prev_n[1] * next_n[1];
            let cos_half_angle = join_normal[0] * next_n[0] + join_normal[1] * next_n[1];
            let miter_length = if cos_half_angle == 0.0 {
                f64::INFINITY
            } else {
                cos_half_angle.recip()
            };
            let approx_angle = 2.0 * (2.0 - 2.0 * cos_half_angle).max(0.0).sqrt();
            let turns_left = prev_n[0] * next_n[1] - prev_n[1] * next_n[0] > 0.0;
            let middle = prev_vertex.is_some() && next_vertex.is_some();

            enum Join {
                Miter,
                FakeRound,
                Round,
                Butt,
            }
            let join = if middle {
                if miter_length < ROUND_LIMIT {
                    Join::Miter
                } else if miter_length <= 2.0 {
                    Join::FakeRound
                } else {
                    Join::Round
                }
            } else if closed || cap == LineCap::Butt {
                Join::Butt
            } else {
                Join::Round
            };

            match join {
                Join::Miter => {
                    self.add_current(vertex, scale(join_normal, miter_length), 0.0, 0.0, false);
                }
                Join::FakeRound => {
                    let offset = -(miter_length * miter_length - 1.0).max(0.0).sqrt();
                    let (offset_a, offset_b) = if turns_left {
                        (offset, 0.0)
                    } else {
                        (0.0, offset)
                    };
                    self.add_current(vertex, prev_n, offset_a, offset_b, false);
                    let slices = ((approx_angle.to_degrees()) / DEG_PER_TRIANGLE).round() as i32;
                    for slice in 1..slices {
                        let mut t = f64::from(slice) / f64::from(slices);
                        if t != 0.5 {
                            // MapLibre's approximate spherical interpolation.
                            let t2 = t - 0.5;
                            let a = 1.0904
                                + cos_angle
                                    * (-3.2452 + cos_angle * (3.55645 - cos_angle * 1.43519));
                            let b = 0.848013 + cos_angle * (-1.06021 + cos_angle * 0.215638);
                            t += t * t2 * (t - 1.0) * (a * t2 * t2 + b);
                        }
                        let extrude = scale(
                            unit(add(scale(sub(next_n, prev_n), t), prev_n)),
                            if turns_left { -1.0 } else { 1.0 },
                        );
                        self.add_half(vertex, extrude, false, turns_left);
                    }
                    self.add_current(vertex, next_n, -offset_a, -offset_b, false);
                }
                Join::Butt => {
                    self.add_current(vertex, join_normal, 0.0, 0.0, false);
                }
                Join::Round => {
                    if prev_vertex.is_some() {
                        self.add_current(vertex, prev_n, 0.0, 0.0, false);
                        self.add_current(vertex, prev_n, 1.0, 1.0, true);
                    }
                    if next_vertex.is_some() {
                        self.add_current(vertex, next_n, -1.0, -1.0, true);
                        self.add_current(vertex, next_n, 0.0, 0.0, false);
                    }
                }
            }
        }
    }

    /// MapLibre's `addCurrentVertex`: both sides of `point`, shifted along the line by
    /// `end_left`/`end_right` half widths.
    fn add_current(
        &mut self,
        point: Point,
        normal: Point,
        end_left: f64,
        end_right: f64,
        round: bool,
    ) {
        let left = [
            normal[0] + normal[1] * end_left,
            normal[1] - normal[0] * end_left,
        ];
        let right = [
            -normal[0] + normal[1] * end_right,
            -normal[1] - normal[0] * end_right,
        ];
        self.add_half(point, left, round, false);
        self.add_half(point, right, round, true);
    }

    fn add_half(&mut self, point: Point, extrude: Point, round: bool, up: bool) {
        let index = self.vertices.len() as u32;
        self.vertices.push(LineMeshVertex {
            point,
            extrude,
            normal: [if round { 1.0 } else { 0.0 }, if up { 1.0 } else { -1.0 }],
        });
        if let (Some(e1), Some(e2)) = (self.e1, self.e2) {
            self.indices.extend([e1, index, e2]);
        }
        if up {
            self.e2 = Some(index);
        } else {
            self.e1 = Some(index);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn triangle_area(mesh: &LineMesh, triangle: &[u32]) -> f64 {
        let at = |index: u32| {
            let vertex = mesh.vertices[index as usize];
            add(vertex.point, vertex.extrude)
        };
        let (a, b, c) = (at(triangle[0]), at(triangle[1]), at(triangle[2]));
        ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2.0
    }

    #[test]
    fn a_straight_segment_with_butt_caps_is_one_quad() {
        let mut mesh = LineMesh::new();
        mesh.add_line(&[[0.0, 0.0], [10.0, 0.0]], LineCap::Butt, false);
        assert_eq!(mesh.vertices.len(), 4);
        assert_eq!(mesh.indices.len(), 6);
        let area: f64 = mesh
            .indices
            .chunks(3)
            .map(|triangle| triangle_area(&mesh, triangle).abs())
            .sum();
        assert!((area - 20.0).abs() < 1e-9, "{area}");
    }

    #[test]
    fn round_caps_extend_each_end_by_a_half_width() {
        let mut mesh = LineMesh::new();
        mesh.add_line(&[[0.0, 0.0], [10.0, 0.0]], LineCap::Round, false);
        let xs = mesh
            .vertices
            .iter()
            .map(|vertex| vertex.point[0] + vertex.extrude[0]);
        let (min, max) = xs.fold((f64::MAX, f64::MIN), |(lo, hi), x| (lo.min(x), hi.max(x)));
        assert_eq!((min, max), (-1.0, 11.0));
        assert!(mesh.vertices.iter().any(|vertex| vertex.normal[0] == 1.0));
    }

    #[test]
    fn a_moderate_turn_fills_its_outer_wedge_without_overlap() {
        // A 90 degree turn: bevel plus pie slices, all triangles on one side of the strip.
        let mut mesh = LineMesh::new();
        mesh.add_line(
            &[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]],
            LineCap::Butt,
            false,
        );
        assert!(mesh.vertices.iter().all(|vertex| vertex.normal[0] == 0.0));
        let at = |index: u32| {
            let vertex = mesh.vertices[index as usize];
            add(vertex.point, vertex.extrude)
        };
        let inside = |triangle: &[u32], p: Point| {
            let (a, b, c) = (at(triangle[0]), at(triangle[1]), at(triangle[2]));
            let side =
                |u: Point, v: Point| (v[0] - u[0]) * (p[1] - u[1]) - (p[0] - u[0]) * (v[1] - u[1]);
            let (d1, d2, d3) = (side(a, b), side(b, c), side(c, a));
            (d1 > 1e-9 && d2 > 1e-9 && d3 > 1e-9) || (d1 < -1e-9 && d2 < -1e-9 && d3 < -1e-9)
        };
        let mut covered = 0;
        for i in 0..240 {
            for j in 0..240 {
                let p = [
                    -1.0 + f64::from(i) * 0.05 + 0.013,
                    -1.0 + f64::from(j) * 0.05 + 0.007,
                ];
                let hits = mesh.indices.chunks(3).filter(|t| inside(t, p)).count();
                assert!(hits <= 1, "{p:?} covered {hits} times");
                covered += hits;
            }
        }
        // The outer corner is rounded: the point diagonally past it stays uncovered.
        let corner = [10.9, -0.9];
        assert!(!mesh.indices.chunks(3).any(|t| inside(t, corner)));
        assert!(covered > 0);
    }

    #[test]
    fn a_hairpin_restarts_with_round_caps() {
        let mut mesh = LineMesh::new();
        mesh.add_line(&[[0.0, 0.0], [10.0, 0.0], [0.0, 1.0]], LineCap::Butt, false);
        assert!(mesh.vertices.iter().any(|vertex| vertex.normal[0] == 1.0));
    }

    #[test]
    fn closed_rings_join_through_their_first_point_and_skip_duplicates() {
        let mut mesh = LineMesh::new();
        let ring = [
            [0.0, 0.0],
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 10.0],
            [0.0, 10.0],
            [0.0, 0.0],
        ];
        mesh.add_line(&ring, LineCap::Round, true);
        assert!(!mesh.indices.is_empty());
        assert!(mesh.vertices.iter().all(|vertex| vertex.normal[0] == 0.0));
        let before = mesh.indices.len();
        mesh.add_line(&[[1.0, 1.0], [1.0, 1.0]], LineCap::Round, false);
        assert_eq!(mesh.indices.len(), before);
    }
}
