//! Target-independent half of the retained application shapes: polygons (#196), lines,
//! flow direction markers and short circle runs such as flow endpoints (#195).
//!
//! Shapes are lowered once from longitude/latitude into `f64` Web Mercator world
//! coordinates, like retained points (#155). Their GPU geometry is built around an
//! anchor near the camera: even-odd stencil fans and bounding covers as `f32` anchor
//! offsets, and stroke records whose CSS-px width is extruded in the vertex shader.
//! Camera frames then only rewrite the frame uniform; a rebase rebuilds the offsets.
//!
//! Each vertex wraps to the world copy nearest the anchor, as Canvas projects each
//! vertex to the copy nearest the camera.
//!
//! Lines are open stroke paths with round caps and joins, as Canvas strokes them: a segment
//! quad per segment and a join disc at every vertex, endpoints included. A direction
//! marker is one triangle placed and oriented in screen space from its anchor and previous
//! coordinate, so it keeps its CSS-px size and the projected heading Canvas uses. A circle
//! is a fill disc and a stroke ring around its centre, in CSS px like retained points.
#![cfg_attr(
    not(all(
        target_arch = "wasm32",
        target_os = "unknown",
        feature = "wgpu-base-map"
    )),
    allow(dead_code)
)]

use maps_core::project_web_mercator;

use crate::retained_points::wrap_world_delta;

/// Per-shape paint record: fill RGBA, stroke RGBA, stroke width (CSS px; a marker's size),
/// shape kind, circle radius (CSS px). Shared with `src/wgpu-application-frame.ts`.
pub(crate) const RETAINED_POLYGON_PAINT_LENGTH: usize = 11;
pub(crate) const RETAINED_SHAPE_POLYGON: f32 = 0.0;
pub(crate) const RETAINED_SHAPE_LINE: f32 = 1.0;
/// One ring of exactly two points: the previous coordinate, then the anchor.
pub(crate) const RETAINED_SHAPE_DIRECTION_MARKER: f32 = 2.0;
/// One ring of exactly one point: the centre.
pub(crate) const RETAINED_SHAPE_CIRCLE: f32 = 3.0;
/// Fill vertex: anchor offset (2 x f32), RGBA (4 x f32).
pub(crate) const RETAINED_POLYGON_FILL_VERTEX_SIZE: u64 = 24;
/// Stroke vertex: endpoints `a` and `b` (2 x 2 x f32), corner (2 x f32), width, kind
/// (0 segment, 1 round join, 2 direction marker, 3 circle ring), RGBA.
pub(crate) const RETAINED_POLYGON_STROKE_VERTEX_SIZE: u64 = 48;
pub(crate) const RETAINED_POLYGON_COVER_VERTEX_COUNT: u32 = 6;
/// A disc's quad around its centre, in radii.
const JOIN_CORNERS: [[f32; 2]; 6] = [
    [-1.0, -1.0],
    [1.0, -1.0],
    [1.0, 1.0],
    [-1.0, -1.0],
    [1.0, 1.0],
    [-1.0, 1.0],
];
/// Direction marker triangle in marker sizes, before rotation; matches Canvas.
const DIRECTION_MARKER_CORNERS: [[f32; 2]; 3] = [[0.38, 0.0], [-0.62, -0.42], [-0.62, 0.42]];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Shape {
    Polygon,
    Line,
    DirectionMarker,
    Circle,
}

#[derive(Debug)]
struct RetainedPolygon {
    shape: Shape,
    /// World coordinates without repeated consecutive points. Polygon rings are open
    /// (no closing point); a line has one path; a marker holds `[previous, anchor]`.
    rings: Vec<Vec<[f64; 2]>>,
    fill: [f32; 4],
    stroke: [f32; 4],
    stroke_width: f32,
    radius: f32,
}

/// Retained shapes: `f64` world rings and their paint.
#[derive(Debug)]
pub(crate) struct RetainedPolygons {
    polygons: Vec<RetainedPolygon>,
}

/// One polygon's ranges: the fan and cover in the fill buffer, the stroke in the stroke
/// buffer. Zero counts skip a pass.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct RetainedPolygonDraw {
    pub(crate) fan_first: u32,
    pub(crate) fan_count: u32,
    pub(crate) cover_first: u32,
    pub(crate) stroke_first: u32,
    pub(crate) stroke_count: u32,
}

/// GPU geometry of a polygon group around one anchor.
#[derive(Debug, Default)]
pub(crate) struct RetainedPolygonGeometry {
    pub(crate) fill: Vec<u8>,
    pub(crate) stroke: Vec<u8>,
    pub(crate) draws: Vec<RetainedPolygonDraw>,
}

impl RetainedPolygons {
    /// Lowers shapes once. `ring_counts` holds each shape's ring count, `point_counts`
    /// each ring's point count, `lon_lat` the concatenated `[longitude, latitude]` pairs and
    /// `paint` one [`RETAINED_POLYGON_PAINT_LENGTH`] record per shape.
    pub(crate) fn lower(
        ring_counts: &[u32],
        point_counts: &[u32],
        lon_lat: &[f64],
        paint: &[f32],
    ) -> Result<Self, &'static str> {
        let ring_total: usize = ring_counts.iter().map(|&count| count as usize).sum();
        let point_total: usize = point_counts.iter().map(|&count| count as usize).sum();
        if ring_total != point_counts.len()
            || point_total * 2 != lon_lat.len()
            || paint.len() != ring_counts.len() * RETAINED_POLYGON_PAINT_LENGTH
        {
            return Err("retained polygon rings, points and paint records do not match");
        }
        if !paint.iter().all(|value| value.is_finite()) {
            return Err("retained polygon paint must be finite");
        }

        let mut coordinates = lon_lat.as_chunks::<2>().0.iter();
        let mut ring_sizes = point_counts.iter();
        let mut polygons = Vec::with_capacity(ring_counts.len());
        for (&rings, paint) in ring_counts
            .iter()
            .zip(paint.as_chunks::<RETAINED_POLYGON_PAINT_LENGTH>().0)
        {
            let shape = match paint[9] {
                RETAINED_SHAPE_POLYGON => Shape::Polygon,
                RETAINED_SHAPE_LINE if rings == 1 => Shape::Line,
                RETAINED_SHAPE_DIRECTION_MARKER if rings == 1 => Shape::DirectionMarker,
                RETAINED_SHAPE_CIRCLE if rings == 1 => Shape::Circle,
                _ => return Err("retained shape kind or ring count is invalid"),
            };
            let mut lowered = Vec::with_capacity(rings as usize);
            for _ in 0..rings {
                let size = *ring_sizes.next().ok_or("missing retained polygon ring")? as usize;
                let mut ring = Vec::with_capacity(size);
                for &[longitude, latitude] in coordinates.by_ref().take(size) {
                    let world = project_web_mercator(longitude, latitude)
                        .ok_or("retained polygon coordinates must be finite")?;
                    ring.push([world.x, world.y]);
                }
                match shape {
                    Shape::DirectionMarker if ring.len() != 2 => {
                        return Err("a retained direction marker needs two points");
                    }
                    // Coincident points keep the marker unrotated, as `atan2(0, 0)` does.
                    Shape::DirectionMarker => lowered.push(ring),
                    Shape::Circle if ring.len() != 1 => {
                        return Err("a retained circle needs one centre");
                    }
                    Shape::Circle => lowered.push(ring),
                    // Distinct coordinates can meet in Mercator (a 360° wrap, clamped poles):
                    // Canvas then strokes a zero-length path, whose round caps form a dot,
                    // which the single join disc of a one-point path reproduces.
                    Shape::Line => lowered.push(dedup(ring)),
                    _ => {
                        let ring = open_ring(ring);
                        // Fewer than two distinct points draw nothing on Canvas either.
                        if ring.len() >= 2 {
                            lowered.push(ring);
                        }
                    }
                }
            }
            polygons.push(RetainedPolygon {
                shape,
                rings: lowered,
                fill: [paint[0], paint[1], paint[2], paint[3]],
                stroke: [paint[4], paint[5], paint[6], paint[7]],
                stroke_width: paint[8].max(0.0),
                radius: paint[10].max(0.0),
            });
        }
        Ok(Self { polygons })
    }

    pub(crate) fn len(&self) -> usize {
        self.polygons.len()
    }

    /// GPU geometry around `anchor`.
    pub(crate) fn geometry(&self, anchor: [f64; 2]) -> RetainedPolygonGeometry {
        let offset = |[x, y]: [f64; 2]| -> [f32; 2] {
            [
                wrap_world_delta(x - anchor[0]) as f32,
                (y - anchor[1]) as f32,
            ]
        };
        let mut geometry = RetainedPolygonGeometry::default();
        for polygon in &self.polygons {
            let fill_index =
                |bytes: &Vec<u8>| (bytes.len() as u64 / RETAINED_POLYGON_FILL_VERTEX_SIZE) as u32;
            let stroke_index =
                |bytes: &Vec<u8>| (bytes.len() as u64 / RETAINED_POLYGON_STROKE_VERTEX_SIZE) as u32;
            let mut draw = RetainedPolygonDraw::default();

            let fill_rings: Vec<Vec<[f32; 2]>> = polygon
                .rings
                .iter()
                .filter(|ring| ring.len() >= 3)
                .map(|ring| ring.iter().copied().map(offset).collect())
                .collect();
            if polygon.shape == Shape::Polygon
                && polygon.fill[3] > 0.0
                && let Some(&pivot) = fill_rings.first().and_then(|ring| ring.first())
            {
                draw.fan_first = fill_index(&geometry.fill);
                let (mut min, mut max) = (pivot, pivot);
                for ring in &fill_rings {
                    for (index, &point) in ring.iter().enumerate() {
                        let next = ring[(index + 1) % ring.len()];
                        for vertex in [pivot, point, next] {
                            push_fill_vertex(&mut geometry.fill, vertex, polygon.fill);
                        }
                        min = [min[0].min(point[0]), min[1].min(point[1])];
                        max = [max[0].max(point[0]), max[1].max(point[1])];
                    }
                }
                draw.cover_first = fill_index(&geometry.fill);
                draw.fan_count = draw.cover_first - draw.fan_first;
                for vertex in [
                    [min[0], min[1]],
                    [max[0], min[1]],
                    [max[0], max[1]],
                    [min[0], min[1]],
                    [max[0], max[1]],
                    [min[0], max[1]],
                ] {
                    push_fill_vertex(&mut geometry.fill, vertex, polygon.fill);
                }
            }

            if polygon.shape == Shape::Circle {
                let center = offset(polygon.rings[0][0]);
                let outer = polygon.radius + polygon.stroke_width * 0.5;
                // Canvas fills, then strokes over the fill: two draws, so the stencil that
                // keeps a stroke from blending twice does not block the ring over the disc.
                let mut disc = |color: [f32; 4], radius: f32, inner: f32, kind: f32| {
                    if radius <= 0.0 || color[3] <= 0.0 {
                        return;
                    }
                    let first = stroke_index(&geometry.stroke);
                    for corner in JOIN_CORNERS {
                        push_stroke_vertex(
                            &mut geometry.stroke,
                            center,
                            [inner, 0.0],
                            corner,
                            radius * 2.0,
                            kind,
                            color,
                        );
                    }
                    geometry.draws.push(RetainedPolygonDraw {
                        stroke_first: first,
                        stroke_count: stroke_index(&geometry.stroke) - first,
                        ..RetainedPolygonDraw::default()
                    });
                };
                disc(polygon.fill, polygon.radius, 0.0, 3.0);
                if polygon.stroke_width > 0.0 {
                    let inner = (polygon.radius - polygon.stroke_width * 0.5).max(0.0) / outer;
                    disc(polygon.stroke, outer, inner, 3.0);
                }
                continue;
            }

            if polygon.shape == Shape::DirectionMarker {
                if polygon.stroke_width > 0.0 && polygon.stroke[3] > 0.0 {
                    let (previous, anchor) =
                        (offset(polygon.rings[0][0]), offset(polygon.rings[0][1]));
                    draw.stroke_first = stroke_index(&geometry.stroke);
                    for corner in DIRECTION_MARKER_CORNERS {
                        push_stroke_vertex(
                            &mut geometry.stroke,
                            anchor,
                            previous,
                            corner,
                            polygon.stroke_width,
                            2.0,
                            polygon.stroke,
                        );
                    }
                    draw.stroke_count = stroke_index(&geometry.stroke) - draw.stroke_first;
                }
                geometry.draws.push(draw);
                continue;
            }

            if polygon.stroke_width > 0.0 && polygon.stroke[3] > 0.0 && !polygon.rings.is_empty() {
                let closed = polygon.shape == Shape::Polygon;
                draw.stroke_first = stroke_index(&geometry.stroke);
                for ring in &polygon.rings {
                    let ring: Vec<[f32; 2]> = ring.iter().copied().map(offset).collect();
                    for (index, &start) in ring.iter().enumerate() {
                        let end = ring[(index + 1) % ring.len()];
                        let stroke =
                            |bytes: &mut Vec<u8>, corner: [f32; 2], kind: f32, b: [f32; 2]| {
                                push_stroke_vertex(
                                    bytes,
                                    start,
                                    b,
                                    corner,
                                    polygon.stroke_width,
                                    kind,
                                    polygon.stroke,
                                );
                            };
                        // The segment quad: (along, side) corners, extruded in the shader.
                        // An open line has no segment back to its first point.
                        let segment = closed || index + 1 < ring.len();
                        for corner in [
                            [0.0, -1.0],
                            [0.0, 1.0],
                            [1.0, -1.0],
                            [0.0, 1.0],
                            [1.0, 1.0],
                            [1.0, -1.0],
                        ]
                        .into_iter()
                        .filter(|_| segment)
                        {
                            stroke(&mut geometry.stroke, corner, 0.0, end);
                        }
                        // Canvas strokes with round joins, and lines with round caps: both
                        // are a disc at the vertex.
                        for corner in JOIN_CORNERS {
                            stroke(&mut geometry.stroke, corner, 1.0, start);
                        }
                    }
                }
                draw.stroke_count = stroke_index(&geometry.stroke) - draw.stroke_first;
            }
            geometry.draws.push(draw);
        }
        geometry
    }
}

fn dedup(mut ring: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    ring.dedup();
    ring
}

fn open_ring(ring: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let mut ring = dedup(ring);
    if ring.len() > 1 && ring.first() == ring.last() {
        ring.pop();
    }
    ring
}

fn push_fill_vertex(bytes: &mut Vec<u8>, offset: [f32; 2], color: [f32; 4]) {
    for value in offset.into_iter().chain(color) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

fn push_stroke_vertex(
    bytes: &mut Vec<u8>,
    a: [f32; 2],
    b: [f32; 2],
    corner: [f32; 2],
    width: f32,
    kind: f32,
    color: [f32; 4],
) {
    for value in a
        .into_iter()
        .chain(b)
        .chain(corner)
        .chain([width, kind])
        .chain(color)
    {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAINT: [f32; RETAINED_POLYGON_PAINT_LENGTH] = [
        0.2,
        0.4,
        0.6,
        1.0,
        0.0,
        0.0,
        0.0,
        1.0,
        2.0,
        RETAINED_SHAPE_POLYGON,
        0.0,
    ];
    const LINE: [f32; RETAINED_POLYGON_PAINT_LENGTH] = [
        0.0,
        0.0,
        0.0,
        0.0,
        0.1,
        0.2,
        0.3,
        1.0,
        3.0,
        RETAINED_SHAPE_LINE,
        0.0,
    ];
    const MARKER: [f32; RETAINED_POLYGON_PAINT_LENGTH] = [
        0.0,
        0.0,
        0.0,
        0.0,
        0.1,
        0.2,
        0.3,
        1.0,
        9.0,
        RETAINED_SHAPE_DIRECTION_MARKER,
        0.0,
    ];
    const CIRCLE: [f32; RETAINED_POLYGON_PAINT_LENGTH] = [
        0.2,
        0.4,
        0.6,
        1.0,
        1.0,
        1.0,
        1.0,
        1.0,
        2.0,
        RETAINED_SHAPE_CIRCLE,
        5.0,
    ];

    fn stroke_kinds(geometry: &RetainedPolygonGeometry) -> Vec<f32> {
        geometry
            .stroke
            .as_chunks::<48>()
            .0
            .iter()
            .map(|vertex| f32::from_le_bytes(vertex[28..32].try_into().unwrap()))
            .collect()
    }

    fn square(west: f64, south: f64, size: f64) -> Vec<f64> {
        vec![
            west,
            south,
            west + size,
            south,
            west + size,
            south + size,
            west,
            south + size,
            west,
            south,
        ]
    }

    fn fill_offsets(geometry: &RetainedPolygonGeometry) -> Vec<[f32; 2]> {
        geometry
            .fill
            .as_chunks::<24>()
            .0
            .iter()
            .map(|vertex| {
                [
                    f32::from_le_bytes(vertex[0..4].try_into().unwrap()),
                    f32::from_le_bytes(vertex[4..8].try_into().unwrap()),
                ]
            })
            .collect()
    }

    #[test]
    fn lowering_validates_counts_and_drops_degenerate_rings() {
        assert!(RetainedPolygons::lower(&[1], &[5], &square(0.0, 0.0, 1.0)[..8], &PAINT).is_err());
        assert!(RetainedPolygons::lower(&[1], &[5], &square(0.0, 0.0, 1.0), &PAINT[..8]).is_err());
        let mut nan = square(0.0, 0.0, 1.0);
        nan[2] = f64::NAN;
        assert!(RetainedPolygons::lower(&[1], &[5], &nan, &PAINT).is_err());

        let mut lon_lat = square(0.0, 0.0, 1.0);
        lon_lat.extend([5.0, 5.0, 5.0, 5.0]);
        let polygons = RetainedPolygons::lower(&[2], &[5, 2], &lon_lat, &PAINT).unwrap();

        assert_eq!(polygons.len(), 1);
        assert_eq!(
            polygons.polygons[0].rings.len(),
            1,
            "a single-point ring is dropped"
        );
        assert_eq!(
            polygons.polygons[0].rings[0].len(),
            4,
            "the closing point is dropped"
        );
    }

    #[test]
    fn a_hole_fans_every_ring_edge_and_covers_the_bounds() {
        let mut lon_lat = square(0.0, 0.0, 4.0);
        lon_lat.extend(square(1.0, 1.0, 2.0));
        let polygons = RetainedPolygons::lower(&[2], &[5, 5], &lon_lat, &PAINT).unwrap();

        let geometry = polygons.geometry([0.5, 0.5]);
        let [draw] = geometry.draws[..] else { panic!() };

        assert_eq!((draw.fan_first, draw.fan_count), (0, 8 * 3));
        assert_eq!(draw.cover_first, 8 * 3);
        assert_eq!(
            fill_offsets(&geometry).len() as u32,
            draw.cover_first + RETAINED_POLYGON_COVER_VERTEX_COUNT
        );
        // A segment quad and a join quad per ring vertex.
        assert_eq!(draw.stroke_count, 8 * 12);
        assert_eq!(
            geometry.stroke.len() as u64,
            u64::from(draw.stroke_count) * RETAINED_POLYGON_STROKE_VERTEX_SIZE
        );
    }

    #[test]
    fn offsets_are_anchor_relative_and_rebase_without_changing_shape() {
        let polygons =
            RetainedPolygons::lower(&[1], &[5], &square(10.0, 10.0, 1.0), &PAINT).unwrap();
        let world = project_web_mercator(10.0, 10.0).unwrap();

        let near = fill_offsets(&polygons.geometry([world.x, world.y]));
        let moved = fill_offsets(&polygons.geometry([world.x - 0.01, world.y + 0.02]));

        assert!(
            near[0][0].abs() < 1.0e-9 && near[0][1].abs() < 1.0e-9,
            "the pivot sits at the anchor"
        );
        for (a, b) in near.iter().zip(&moved) {
            assert!(((b[0] - a[0]) - 0.01).abs() < 1.0e-6);
            assert!(((b[1] - a[1]) + 0.02).abs() < 1.0e-6);
        }
    }

    #[test]
    fn a_polygon_across_the_antimeridian_stays_contiguous_around_an_anchor_there() {
        let lon_lat = [179.0, 0.0, -179.0, 0.0, -179.0, 1.0, 179.0, 1.0, 179.0, 0.0];
        let polygons = RetainedPolygons::lower(&[1], &[5], &lon_lat, &PAINT).unwrap();
        let anchor = project_web_mercator(180.0, 0.0).unwrap();

        let offsets = fill_offsets(&polygons.geometry([anchor.x, anchor.y]));

        let width = 2.0 / 360.0;
        for offset in &offsets {
            assert!(
                offset[0].abs() <= width as f32,
                "{offset:?} wrapped the long way round"
            );
        }
    }

    #[test]
    fn invisible_fill_or_stroke_is_skipped() {
        let mut paint = PAINT;
        paint[3] = 0.0;
        let stroke_only =
            RetainedPolygons::lower(&[1], &[5], &square(0.0, 0.0, 1.0), &paint).unwrap();
        let [draw] = stroke_only.geometry([0.5, 0.5]).draws[..] else {
            panic!()
        };
        assert_eq!(draw.fan_count, 0);
        assert!(draw.stroke_count > 0);

        let mut paint = PAINT;
        paint[8] = 0.0;
        let fill_only =
            RetainedPolygons::lower(&[1], &[5], &square(0.0, 0.0, 1.0), &paint).unwrap();
        let [draw] = fill_only.geometry([0.5, 0.5]).draws[..] else {
            panic!()
        };
        assert!(draw.fan_count > 0);
        assert_eq!(draw.stroke_count, 0);
    }

    #[test]
    fn an_open_line_has_no_closing_segment_and_a_disc_at_every_vertex() {
        let lon_lat = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0];
        let lines = RetainedPolygons::lower(&[1], &[4], &lon_lat, &LINE).unwrap();
        assert_eq!(
            lines.polygons[0].rings[0].len(),
            3,
            "repeated points are dropped"
        );

        let geometry = lines.geometry([0.5, 0.5]);
        let [draw] = geometry.draws[..] else { panic!() };

        assert_eq!(draw.fan_count, 0, "lines are never filled");
        let kinds = stroke_kinds(&geometry);
        // Two segment quads and three join/cap discs.
        assert_eq!(kinds.iter().filter(|&&kind| kind == 0.0).count(), 2 * 6);
        assert_eq!(kinds.iter().filter(|&&kind| kind == 1.0).count(), 3 * 6);
        assert_eq!(draw.stroke_count as usize, kinds.len());
    }

    #[test]
    fn a_line_that_collapses_in_mercator_is_a_round_cap_dot() {
        let lines = RetainedPolygons::lower(&[1], &[2], &[0.0, 0.0, 360.0, 0.0], &LINE).unwrap();
        let geometry = lines.geometry([0.0, 0.0]);
        let [draw] = geometry.draws[..] else { panic!() };

        assert_eq!(draw.stroke_count, 6);
        assert_eq!(stroke_kinds(&geometry), [1.0; 6], "one disc, no segment");
    }

    #[test]
    fn a_direction_marker_is_one_triangle_from_its_anchor_toward_its_heading() {
        let lon_lat = [10.0, 10.0, 11.0, 10.0];
        let markers = RetainedPolygons::lower(&[1], &[2], &lon_lat, &MARKER).unwrap();
        let anchor = project_web_mercator(11.0, 10.0).unwrap();

        let geometry = markers.geometry([anchor.x, anchor.y]);
        let [draw] = geometry.draws[..] else { panic!() };

        assert_eq!((draw.fan_count, draw.stroke_count), (0, 3));
        assert_eq!(stroke_kinds(&geometry), [2.0; 3]);
        let first = &geometry.stroke[..48];
        let value =
            |index: usize| f32::from_le_bytes(first[index * 4..index * 4 + 4].try_into().unwrap());
        assert!(
            value(0).abs() < 1.0e-9 && value(1).abs() < 1.0e-9,
            "`a` is the anchor"
        );
        assert!(
            value(2) < 0.0,
            "`b` is the previous coordinate, west of the anchor"
        );
        assert_eq!([value(4), value(5), value(6)], [0.38, 0.0, 9.0]);
    }

    #[test]
    fn shape_kinds_validate_their_rings() {
        let square = square(0.0, 0.0, 1.0);
        let mut paint = PAINT;
        paint[9] = 7.0;
        assert!(RetainedPolygons::lower(&[1], &[5], &square, &paint).is_err());
        assert!(RetainedPolygons::lower(&[2], &[2, 2], &[0.0; 8], &LINE).is_err());
        assert!(RetainedPolygons::lower(&[1], &[3], &[0.0; 6], &MARKER).is_err());
        assert!(RetainedPolygons::lower(&[1], &[2], &[1.0, 1.0, 1.0, 1.0], &MARKER).is_ok());
    }

    #[test]
    fn a_circle_is_a_fill_disc_then_a_stroke_ring_in_separate_draws() {
        let circles = RetainedPolygons::lower(&[1], &[1], &[3.0, 4.0], &CIRCLE).unwrap();
        let geometry = circles.geometry([0.0, 0.0]);
        let [fill, ring] = geometry.draws[..] else {
            panic!()
        };

        assert_eq!((fill.stroke_first, fill.stroke_count), (0, 6));
        assert_eq!((ring.stroke_first, ring.stroke_count), (6, 6));
        assert_eq!(stroke_kinds(&geometry), [3.0; 12]);
        let value = |vertex: usize, index: usize| {
            let start = vertex * 48 + index * 4;
            f32::from_le_bytes(geometry.stroke[start..start + 4].try_into().unwrap())
        };
        // Fill: radius 5 (width 10), no hole. Ring: outer 6, inner 4 / 6.
        assert_eq!((value(0, 6), value(0, 2)), (10.0, 0.0));
        assert_eq!(value(6, 6), 12.0);
        assert!((value(6, 2) - 4.0 / 6.0).abs() < 1.0e-6);

        let mut unstroked = CIRCLE;
        unstroked[8] = 0.0;
        let circles = RetainedPolygons::lower(&[1], &[1], &[3.0, 4.0], &unstroked).unwrap();
        assert_eq!(circles.geometry([0.0, 0.0]).draws.len(), 1);
        assert!(RetainedPolygons::lower(&[1], &[2], &[0.0; 4], &CIRCLE).is_err());
    }
}
