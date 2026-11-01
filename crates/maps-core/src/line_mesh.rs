//! MapLibre's line bucket tessellation (#325, #326, #322).
//!
//! A polyline becomes one triangle strip whose vertices carry a unit-width extrusion,
//! MapLibre's `v_normal` flags and its `a_linesofar` distance, so renderers extrude by their
//! own outset (CSS px), fade by `length(normal)` and look dashes up exactly as
//! `line.fragment.glsl` / `line_sdf.fragment.glsl` do. This is `addLine` of MapLibre's
//! `line_bucket.ts` for every `line-cap` (butt, round, square) and `line-join` (bevel, round,
//! miter, with `line-miter-limit` and `line-round-limit`): a near-straight vertex is a miter,
//! a round join up to 120 degrees is a bevel filled with pie slices ("fakeround"), a sharper
//! one ends and restarts the line with round caps, a miter past its limit is a bevel, and a
//! bevel past a miter length of 2 is MapLibre's "flipbevel". Sharp corners get MapLibre's
//! extra vertices 15 px either side, so dashes tilt over a shorter part of the line.
//!
//! Distances follow MapLibre's tile units (`EXTENT` 8192 per 512 px tile at the tile zoom):
//! [`LineMesh::with_units`] says how many tile units one input unit is.

/// MapLibre's vector tile extent.
const EXTENT: f64 = 8192.0;
/// Angle per pie slice of a fake round join.
const DEG_PER_TRIANGLE: f64 = 20.0;
/// Corners sharper than 75 degrees get extra vertices ([`SHARP_CORNER_OFFSET`] px away).
const COS_HALF_SHARP_CORNER: f64 = 0.793_353_340_291_235_2; // cos(37.5°)
const SHARP_CORNER_OFFSET: f64 = 15.0;
/// Extrusion vectors are stored scaled by 63 in a signed byte.
const EXTRUDE_SCALE: f64 = 63.0;
/// `a_linesofar` holds 15 bits of `distance * LINE_DISTANCE_SCALE`.
const LINE_DISTANCE_SCALE: f64 = 0.5;
const MAX_LINE_DISTANCE: f64 = 16_384.0 / LINE_DISTANCE_SCALE;

/// How an open line ends (`line-cap`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineCap {
    Butt,
    Round,
    Square,
}

/// How segments meet (`line-join`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineJoin {
    Bevel,
    Round,
    Miter,
}

/// MapLibre's line layout properties for one feature.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineLayout {
    pub cap: LineCap,
    pub join: LineJoin,
    /// `line-miter-limit`: longer miters become bevels.
    pub miter_limit: f64,
    /// `line-round-limit`: shorter round joins become miters.
    pub round_limit: f64,
}

impl LineLayout {
    /// MapLibre's style-specification defaults: butt caps, miter joins.
    pub const DEFAULT: Self = Self {
        cap: LineCap::Butt,
        join: LineJoin::Miter,
        miter_limit: 2.0,
        round_limit: 1.05,
    };
    /// Round caps and joins with the default limits.
    pub const ROUND: Self = Self {
        cap: LineCap::Round,
        join: LineJoin::Round,
        miter_limit: 2.0,
        round_limit: 1.05,
    };

    #[must_use]
    pub const fn with_cap(self, cap: LineCap) -> Self {
        Self {
            cap,
            join: self.join,
            miter_limit: self.miter_limit,
            round_limit: self.round_limit,
        }
    }
}

impl Default for LineLayout {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// One strip vertex: the line point, the extrusion for a half width of 1, MapLibre's
/// `v_normal` (`x` 1 on a round cap, `y` +1 or -1 by side) and `a_linesofar` (tile units,
/// quantized as MapLibre's vertex buffer stores it).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineMeshVertex {
    pub point: [f64; 2],
    pub extrude: [f64; 2],
    pub normal: [f32; 2],
    pub linesofar: f32,
}

/// Triangles of every line added so far; indices are into `vertices`.
#[derive(Clone, Debug, PartialEq)]
pub struct LineMesh {
    pub vertices: Vec<LineMeshVertex>,
    pub indices: Vec<u32>,
    e1: Option<u32>,
    e2: Option<u32>,
    /// MapLibre tile units per input unit.
    tile_units: f64,
    /// Sharp-corner vertex offset in input units (0: none, as on overscaled tiles past 16).
    sharp_corner_offset: f64,
    /// Distance along the current line, tile units.
    distance: f64,
}

impl Default for LineMesh {
    fn default() -> Self {
        Self::with_units(1.0, 1.0)
    }
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

fn length(a: Point) -> f64 {
    a[0].hypot(a[1])
}

fn unit(a: Point) -> Point {
    let length = length(a);
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

/// MapLibre stores the extrusion as a byte, `Math.round(63 * e) + 128`, which wraps past 2.
fn quantize_extrude(value: f64) -> f64 {
    let stored = (js_round(EXTRUDE_SCALE * value) + 128.0).rem_euclid(256.0);
    (stored - 128.0) / EXTRUDE_SCALE
}

/// JavaScript's `Math.round`: halves round up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Join {
    Miter,
    Bevel,
    FlipBevel,
    FakeRound,
    Round,
    Butt,
    Square,
}

impl LineMesh {
    /// A mesh whose input is in MapLibre tile units.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A mesh whose input unit is `tile_units` MapLibre tile units, on a tile `overscaling`
    /// times past its source zoom.
    #[must_use]
    pub fn with_units(tile_units: f64, overscaling: f64) -> Self {
        let sharp_corner_offset = if overscaling <= 16.0 {
            SHARP_CORNER_OFFSET * EXTENT / (512.0 * overscaling) / tile_units
        } else {
            0.0
        };
        Self {
            vertices: Vec::new(),
            indices: Vec::new(),
            e1: None,
            e2: None,
            tile_units,
            sharp_corner_offset,
            distance: 0.0,
        }
    }

    pub fn clear(&mut self) {
        self.vertices.clear();
        self.indices.clear();
    }

    /// Adds one polyline. A `closed` ring is joined through its first vertex (MapLibre's
    /// polygon outline); otherwise both ends get the layout's cap. Consecutive duplicate
    /// points are skipped; a line without two distinct points adds nothing.
    pub fn add_line(&mut self, points: &[Point], layout: &LineLayout, closed: bool) {
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
        self.distance = 0.0;

        let miter_limit = if layout.join == LineJoin::Bevel {
            1.05
        } else {
            layout.miter_limit
        };
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
            let sharp_corner = cos_half_angle < COS_HALF_SHARP_CORNER
                && prev_vertex.is_some()
                && next_vertex.is_some();
            let turns_left = prev_n[0] * next_n[1] - prev_n[1] * next_n[0] > 0.0;

            if sharp_corner && index > 0 {
                let prev = prev_vertex.expect("a sharp corner has a previous vertex");
                let prev_length = length(sub(vertex, prev));
                if prev_length > 2.0 * self.sharp_corner_offset {
                    let step = self.round_units(scale(
                        sub(vertex, prev),
                        self.sharp_corner_offset / prev_length,
                    ));
                    let new_prev = sub(vertex, step);
                    self.update_distance(prev, new_prev);
                    self.add_current(new_prev, prev_n, 0.0, 0.0, false);
                    prev_vertex = Some(new_prev);
                }
            }

            let middle = prev_vertex.is_some() && next_vertex.is_some();
            let mut join = if middle {
                match layout.join {
                    LineJoin::Bevel => Join::Bevel,
                    LineJoin::Round => Join::Round,
                    LineJoin::Miter => Join::Miter,
                }
            } else if closed {
                Join::Butt
            } else {
                match layout.cap {
                    LineCap::Butt => Join::Butt,
                    LineCap::Round => Join::Round,
                    LineCap::Square => Join::Square,
                }
            };
            if middle && join == Join::Round {
                if miter_length < layout.round_limit {
                    join = Join::Miter;
                } else if miter_length <= 2.0 {
                    join = Join::FakeRound;
                }
            }
            if join == Join::Miter && miter_length > miter_limit {
                join = Join::Bevel;
            }
            if join == Join::Bevel {
                // The extrusion is stored in a byte, so a miter longer than 2 is flipped.
                if miter_length > 2.0 {
                    join = Join::FlipBevel;
                }
                if miter_length < miter_limit {
                    join = Join::Miter;
                }
            }

            if let Some(prev) = prev_vertex {
                self.update_distance(prev, vertex);
            }

            match join {
                Join::Miter => {
                    self.add_current(vertex, scale(join_normal, miter_length), 0.0, 0.0, false);
                }
                Join::FlipBevel => {
                    let flipped = if miter_length > 100.0 {
                        // Almost parallel lines.
                        scale(next_n, -1.0)
                    } else {
                        let bevel_length = miter_length * length(add(prev_n, next_n))
                            / length(sub(prev_n, next_n));
                        scale(
                            perp(join_normal),
                            bevel_length * if turns_left { -1.0 } else { 1.0 },
                        )
                    };
                    self.add_current(vertex, flipped, 0.0, 0.0, false);
                    self.add_current(vertex, scale(flipped, -1.0), 0.0, 0.0, false);
                }
                Join::Bevel | Join::FakeRound => {
                    let offset = -(miter_length * miter_length - 1.0).max(0.0).sqrt();
                    let (offset_a, offset_b) = if turns_left {
                        (offset, 0.0)
                    } else {
                        (0.0, offset)
                    };
                    if prev_vertex.is_some() {
                        self.add_current(vertex, prev_n, offset_a, offset_b, false);
                    }
                    if join == Join::FakeRound {
                        let slices =
                            ((approx_angle.to_degrees()) / DEG_PER_TRIANGLE).round() as i32;
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
                    }
                    if next_vertex.is_some() {
                        self.add_current(vertex, next_n, -offset_a, -offset_b, false);
                    }
                }
                Join::Butt => {
                    self.add_current(vertex, join_normal, 0.0, 0.0, false);
                }
                Join::Square => {
                    let offset = if prev_vertex.is_some() { 1.0 } else { -1.0 };
                    self.add_current(vertex, join_normal, offset, offset, false);
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

            if sharp_corner && index < len - 1 {
                let next = next_vertex.expect("a sharp corner has a next vertex");
                let next_length = length(sub(next, vertex));
                if next_length > 2.0 * self.sharp_corner_offset {
                    let step = self.round_units(scale(
                        sub(next, vertex),
                        self.sharp_corner_offset / next_length,
                    ));
                    let new_current = add(vertex, step);
                    self.update_distance(vertex, new_current);
                    self.add_current(new_current, next_n, 0.0, 0.0, false);
                    current = Some(new_current);
                }
            }
        }
    }

    /// `Point._round()` on the tile-unit grid.
    fn round_units(&self, point: Point) -> Point {
        point.map(|value| js_round(value * self.tile_units) / self.tile_units)
    }

    fn update_distance(&mut self, from: Point, to: Point) {
        self.distance += length(sub(to, from)) * self.tile_units;
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
        // `a_linesofar` only holds so much: restart the distance and repeat the vertex.
        if self.distance > MAX_LINE_DISTANCE / 2.0 {
            self.distance = 0.0;
            self.add_current(point, normal, end_left, end_right, round);
        }
    }

    fn add_half(&mut self, point: Point, extrude: Point, round: bool, up: bool) {
        let index = self.vertices.len() as u32;
        // The vertex buffer keeps the truncated scaled distance in 6 + 8 bits.
        let scaled = (self.distance * LINE_DISTANCE_SCALE) as i64;
        let stored = (scaled & 0x3f) + ((scaled >> 6) & 0xff) * 64;
        self.vertices.push(LineMeshVertex {
            point,
            extrude: extrude.map(quantize_extrude),
            normal: [if round { 1.0 } else { 0.0 }, if up { 1.0 } else { -1.0 }],
            linesofar: (stored as f64 / LINE_DISTANCE_SCALE) as f32,
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
        mesh.add_line(
            &[[0.0, 0.0], [10.0, 0.0]],
            &LineLayout::ROUND.with_cap(LineCap::Butt),
            false,
        );
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
        mesh.add_line(&[[0.0, 0.0], [10.0, 0.0]], &LineLayout::ROUND, false);
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
            &LineLayout::ROUND.with_cap(LineCap::Butt),
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
        mesh.add_line(
            &[[0.0, 0.0], [10.0, 0.0], [0.0, 1.0]],
            &LineLayout::ROUND.with_cap(LineCap::Butt),
            false,
        );
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
        mesh.add_line(&ring, &LineLayout::ROUND, true);
        assert!(!mesh.indices.is_empty());
        assert!(mesh.vertices.iter().all(|vertex| vertex.normal[0] == 0.0));
        let before = mesh.indices.len();
        mesh.add_line(&[[1.0, 1.0], [1.0, 1.0]], &LineLayout::ROUND, false);
        assert_eq!(mesh.indices.len(), before);
    }

    fn extent_x(mesh: &LineMesh) -> (f64, f64) {
        mesh.vertices
            .iter()
            .map(|vertex| vertex.point[0] + vertex.extrude[0])
            .fold((f64::MAX, f64::MIN), |(lo, hi), x| (lo.min(x), hi.max(x)))
    }

    #[test]
    fn square_caps_extend_each_end_by_a_half_width_and_butt_caps_do_not() {
        let mut square = LineMesh::new();
        square.add_line(
            &[[0.0, 0.0], [10.0, 0.0]],
            &LineLayout::DEFAULT.with_cap(LineCap::Square),
            false,
        );
        assert_eq!(extent_x(&square), (-1.0, 11.0));
        assert_eq!(square.vertices.len(), 4);
        let mut butt = LineMesh::new();
        butt.add_line(&[[0.0, 0.0], [10.0, 0.0]], &LineLayout::DEFAULT, false);
        assert_eq!(extent_x(&butt), (0.0, 10.0));
    }

    #[test]
    fn miter_joins_one_pair_bevel_past_the_limit_and_bevel_joins_cut_the_corner() {
        let right_angle = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]];
        let mut miter = LineMesh::new();
        miter.add_line(&right_angle, &LineLayout::DEFAULT, false);
        // Start, corner, end: one vertex pair each; the corner is extruded by sqrt(2).
        assert_eq!(miter.vertices.len(), 6);
        let corner = miter.vertices[2].extrude;
        assert!((length(corner) - 2.0_f64.sqrt()).abs() < 1e-9, "{corner:?}");

        let mut limited = LineMesh::new();
        limited.add_line(
            &right_angle,
            &LineLayout {
                miter_limit: 1.2,
                ..LineLayout::DEFAULT
            },
            false,
        );
        let mut bevel = LineMesh::new();
        bevel.add_line(
            &right_angle,
            &LineLayout {
                join: LineJoin::Bevel,
                ..LineLayout::DEFAULT
            },
            false,
        );
        assert_eq!(limited, bevel);
        assert_eq!(bevel.vertices.len(), 8);
        // The miter reaches the outer corner (11, -1); the bevel cuts it off.
        let reaches = |mesh: &LineMesh| {
            mesh.vertices.iter().any(|vertex| {
                let at = add(vertex.point, vertex.extrude);
                (at[0] - 11.0).abs() < 1e-9 && (at[1] + 1.0).abs() < 1e-9
            })
        };
        assert!(reaches(&miter));
        assert!(!reaches(&bevel));
    }

    #[test]
    fn linesofar_counts_tile_units_along_the_line_and_sharp_corners_add_vertices() {
        // Tile units: a 1000-unit leg, a hairpin-ish 150 degree turn, another 1000 units.
        let mut mesh = LineMesh::new();
        let path = [[0.0, 0.0], [1000.0, 0.0], [0.0, 400.0]];
        mesh.add_line(&path, &LineLayout::DEFAULT, false);
        let distances: Vec<f32> = mesh
            .vertices
            .iter()
            .map(|vertex| vertex.linesofar)
            .collect();
        assert_eq!(distances[0], 0.0);
        // The extra vertex 15 px (240 units) before the corner.
        assert!(distances.contains(&760.0), "{distances:?}");
        assert!(distances.contains(&1000.0), "{distances:?}");
        let total = 1000.0 + 1000.0_f64.hypot(400.0);
        let last = *distances.last().unwrap();
        assert_eq!(f64::from(last), (total * 0.5).trunc() * 2.0);
    }

    #[test]
    fn linesofar_restarts_past_half_the_stored_range() {
        let mut mesh = LineMesh::new();
        mesh.add_line(
            &[[0.0, 0.0], [20_000.0, 0.0], [40_000.0, 0.0]],
            &LineLayout::DEFAULT,
            false,
        );
        // The middle vertex is past 16384 units: it repeats at distance 0.
        assert!(
            mesh.vertices
                .iter()
                .filter(|vertex| vertex.linesofar == 0.0)
                .count()
                >= 4
        );
        assert!(
            mesh.vertices
                .iter()
                .all(|vertex| vertex.linesofar < 32_768.0)
        );
    }
}
