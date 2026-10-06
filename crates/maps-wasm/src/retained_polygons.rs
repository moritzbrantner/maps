//! Target-independent half of the retained application polygons (#196).
//!
//! Polygons are lowered once from longitude/latitude into `f64` Web Mercator world
//! coordinates, like retained points (#155). Their GPU geometry is built around an
//! anchor near the camera: even-odd stencil fans and bounding covers as `f32` anchor
//! offsets, and stroke records whose CSS-px width is extruded in the vertex shader.
//! Camera frames then only rewrite the frame uniform; a rebase rebuilds the offsets.
//!
//! Each vertex wraps to the world copy nearest the anchor, as Canvas projects each
//! vertex to the copy nearest the camera.
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

/// Per-polygon paint record: fill RGBA, stroke RGBA, stroke width (CSS px). Shared with
/// `src/wgpu-application-frame.ts`.
pub(crate) const RETAINED_POLYGON_PAINT_LENGTH: usize = 9;
/// Fill vertex: anchor offset (2 x f32), RGBA (4 x f32).
pub(crate) const RETAINED_POLYGON_FILL_VERTEX_SIZE: u64 = 24;
/// Stroke vertex: endpoints `a` and `b` (2 x 2 x f32), corner (2 x f32), width, kind
/// (0 segment, 1 round join), RGBA.
pub(crate) const RETAINED_POLYGON_STROKE_VERTEX_SIZE: u64 = 48;
pub(crate) const RETAINED_POLYGON_COVER_VERTEX_COUNT: u32 = 6;

#[derive(Debug)]
struct RetainedPolygon {
    /// Open rings (no repeated consecutive or closing points) in world coordinates.
    rings: Vec<Vec<[f64; 2]>>,
    fill: [f32; 4],
    stroke: [f32; 4],
    stroke_width: f32,
}

/// Retained polygons: `f64` world rings and their paint.
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
    /// Lowers polygons once. `ring_counts` holds each polygon's ring count, `point_counts`
    /// each ring's point count, `lon_lat` the concatenated `[longitude, latitude]` pairs and
    /// `paint` one [`RETAINED_POLYGON_PAINT_LENGTH`] record per polygon.
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
            let mut lowered = Vec::with_capacity(rings as usize);
            for _ in 0..rings {
                let size = *ring_sizes.next().ok_or("missing retained polygon ring")? as usize;
                let mut ring = Vec::with_capacity(size);
                for &[longitude, latitude] in coordinates.by_ref().take(size) {
                    let world = project_web_mercator(longitude, latitude)
                        .ok_or("retained polygon coordinates must be finite")?;
                    ring.push([world.x, world.y]);
                }
                let ring = open_ring(ring);
                // Fewer than two distinct points draw nothing on Canvas either.
                if ring.len() >= 2 {
                    lowered.push(ring);
                }
            }
            polygons.push(RetainedPolygon {
                rings: lowered,
                fill: [paint[0], paint[1], paint[2], paint[3]],
                stroke: [paint[4], paint[5], paint[6], paint[7]],
                stroke_width: paint[8].max(0.0),
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
            if polygon.fill[3] > 0.0
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

            if polygon.stroke_width > 0.0 && polygon.stroke[3] > 0.0 && !polygon.rings.is_empty() {
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
                        for corner in [
                            [0.0, -1.0],
                            [0.0, 1.0],
                            [1.0, -1.0],
                            [0.0, 1.0],
                            [1.0, 1.0],
                            [1.0, -1.0],
                        ] {
                            stroke(&mut geometry.stroke, corner, 0.0, end);
                        }
                        // Canvas strokes polygon rings with round joins.
                        for corner in [
                            [-1.0, -1.0],
                            [1.0, -1.0],
                            [1.0, 1.0],
                            [-1.0, -1.0],
                            [1.0, 1.0],
                            [-1.0, 1.0],
                        ] {
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

fn open_ring(mut ring: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    ring.dedup();
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

    const PAINT: [f32; RETAINED_POLYGON_PAINT_LENGTH] =
        [0.2, 0.4, 0.6, 1.0, 0.0, 0.0, 0.0, 1.0, 2.0];

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
}
