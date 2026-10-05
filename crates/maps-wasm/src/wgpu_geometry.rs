//! Maps-specific pixel geometry preparation, shared by the browser backend and native tests.

use serde::Deserialize;
use std::borrow::Cow;

pub(super) const APPLICATION_VERTEX_SIZE: u64 = 24;
pub(super) const APPLICATION_CIRCLE_INSTANCE_SIZE: u64 = 56;
const LINE_CAP_SEGMENTS: usize = 12;
const MAX_LINE_MITER_SCALE: f64 = 4.0;
const GEOMETRY_EPSILON: f64 = 1.0e-9;
const GEOMETRY_EPSILON_SQUARED: f64 = GEOMETRY_EPSILON * GEOMETRY_EPSILON;
const APPLICATION_CIRCLE: u32 = 0;
const APPLICATION_LINE: u32 = 1;
const APPLICATION_DIRECTION_MARKER: u32 = 2;
const APPLICATION_POLYGON: u32 = 3;
/// A retained point group (#155), drawn at this painter-order position: run
/// (kind, group key, 1).
const APPLICATION_RETAINED_POINTS: u32 = 4;

/// Raster tile identity (z, x, y) shared with the host's tile lifecycle.
pub(super) type RasterTileKey = (u8, u32, u32);

/// Packed tile draw input shared with `src/wgpu-base-map-wasm.ts`: 16
/// view-projection elements, the render-surface margin (CSS px per side), the
/// viewport clip width/height (CSS px; 0 draws the whole surface) and the CSS-to-
/// physical pixel ratio, followed by one [`PACKED_TILE_DRAW_STRIDE`] record per
/// placement (z, x, y, local west, local north, local size).
const PACKED_TILE_DRAW_HEADER_LENGTH: usize = 20;
const PACKED_TILE_DRAW_STRIDE: usize = 6;

pub(super) struct WgpuRasterTilePlacement {
    pub(super) key: Option<RasterTileKey>,
    pub(super) local_west: f64,
    pub(super) local_north: f64,
    pub(super) local_size: f64,
}

fn packed_tile_key(z: f64, x: f64, y: f64) -> Option<RasterTileKey> {
    let integral = |value: f64, max: f64| value.fract() == 0.0 && (0.0..=max).contains(&value);
    (integral(z, f64::from(u8::MAX))
        && integral(x, f64::from(u32::MAX))
        && integral(y, f64::from(u32::MAX)))
    .then_some((z as u8, x as u32, y as u32))
}

/// Where the render surface (viewport grown by `margin`) needs pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct SurfaceClip {
    pub(super) margin: f64,
    /// Viewport CSS size when only the viewport is drawn (continuous motion).
    pub(super) viewport: Option<(f64, f64)>,
    /// CSS-to-physical pixel ratio of the surface (screen-space line widths).
    pub(super) pixel_ratio: f64,
}

impl SurfaceClip {
    /// Physical-pixel scissor (x, y, width, height) covering the viewport inside a
    /// `surface_width` x `surface_height` target, rounded outward; `None` draws all.
    pub(super) fn scissor(
        self,
        surface_width: u32,
        surface_height: u32,
    ) -> Option<(u32, u32, u32, u32)> {
        let (width, height) = self.viewport?;
        let axis = |css: f64, physical: u32| {
            let scale = f64::from(physical) / (css + 2.0 * self.margin);
            let start = (self.margin * scale)
                .floor()
                .clamp(0.0, f64::from(physical)) as u32;
            let end = ((self.margin + css) * scale)
                .ceil()
                .clamp(f64::from(start), f64::from(physical)) as u32;
            (start, end - start)
        };
        let (x, scissor_width) = axis(width, surface_width);
        let (y, scissor_height) = axis(height, surface_height);
        Some((x, y, scissor_width, scissor_height))
    }
}

pub(super) fn unpack_tile_draws(
    packed: &[f64],
) -> Result<
    (
        [f32; 16],
        SurfaceClip,
        impl Iterator<Item = WgpuRasterTilePlacement> + '_,
    ),
    &'static str,
> {
    if packed.len() < PACKED_TILE_DRAW_HEADER_LENGTH
        || !(packed.len() - PACKED_TILE_DRAW_HEADER_LENGTH).is_multiple_of(PACKED_TILE_DRAW_STRIDE)
    {
        return Err("invalid packed wgpu raster tile draws");
    }
    let (header, records) = packed.split_at(PACKED_TILE_DRAW_HEADER_LENGTH);
    let mut view_projection = [0.0_f32; 16];
    for (target, value) in view_projection.iter_mut().zip(header) {
        *target = *value as f32;
    }
    let margin = header[16];
    if !margin.is_finite() || margin < 0.0 {
        return Err("invalid wgpu render-surface margin");
    }
    let (clip_width, clip_height) = (header[17], header[18]);
    let viewport = match (clip_width, clip_height) {
        (0.0, 0.0) => None,
        (width, height)
            if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 =>
        {
            Some((width, height))
        }
        _ => return Err("invalid wgpu viewport clip"),
    };
    let pixel_ratio = header[19];
    if !pixel_ratio.is_finite() || pixel_ratio <= 0.0 {
        return Err("invalid wgpu pixel ratio");
    }
    Ok((
        view_projection,
        SurfaceClip {
            margin,
            viewport,
            pixel_ratio,
        },
        records
            .as_chunks::<PACKED_TILE_DRAW_STRIDE>()
            .0
            .iter()
            .map(unpack_tile_draw),
    ))
}

fn unpack_tile_draw(record: &[f64; PACKED_TILE_DRAW_STRIDE]) -> WgpuRasterTilePlacement {
    WgpuRasterTilePlacement {
        key: packed_tile_key(record[0], record[1], record[2]),
        local_west: record[3],
        local_north: record[4],
        local_size: record[5],
    }
}

/// Packed circle record shared with `src/wgpu-application-frame.ts`
/// (`MAPS_WGPU_APPLICATION_CIRCLE_STRIDE`): x, y, radius, stroke width (viewport CSS
/// px), fill RGBA, stroke RGBA (linear light).
pub(super) const APPLICATION_CIRCLE_RECORD_LENGTH: usize = 12;
/// Painter-order run: (kind, first index, count).
pub(super) const APPLICATION_ORDER_RUN_LENGTH: usize = 3;

/// One application frame. Lines, polygons and direction markers arrive as a
/// deserialized object; dense circles and the painter order arrive as typed slices
/// ([`Self::attach_packed`]) and are read in place, never rebuilt as objects.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WgpuApplicationFrame {
    #[serde(skip)]
    pub(super) circle_data: Vec<f32>,
    /// Render-surface offset applied to packed circle centers when they are read.
    #[serde(skip)]
    pub(super) circle_offset: f64,
    pub(super) direction_markers: Vec<WgpuApplicationDirectionMarker>,
    pub(super) height: f64,
    pub(super) lines: Vec<WgpuApplicationLine>,
    /// Painter-order runs, [`APPLICATION_ORDER_RUN_LENGTH`] values each.
    #[serde(skip)]
    pub(super) order: Vec<u32>,
    pub(super) polygons: Vec<WgpuApplicationPolygon>,
    pub(super) width: f64,
}

impl WgpuApplicationFrame {
    /// Attaches the typed circle records and painter-order runs of the frame.
    pub(super) fn attach_packed(
        &mut self,
        circle_data: &[f32],
        order: &[u32],
    ) -> Result<(), &'static str> {
        if !circle_data
            .len()
            .is_multiple_of(APPLICATION_CIRCLE_RECORD_LENGTH)
            || !order.len().is_multiple_of(APPLICATION_ORDER_RUN_LENGTH)
        {
            return Err("invalid packed wgpu application circles or order");
        }
        self.circle_data.clear();
        self.circle_data.extend_from_slice(circle_data);
        self.order.clear();
        self.order.extend_from_slice(order);
        Ok(())
    }

    /// Reads one packed circle (render-surface coordinates) without allocating.
    pub(super) fn circle(&self, index: usize) -> Option<WgpuApplicationCircle> {
        let record = self
            .circle_data
            .as_chunks::<APPLICATION_CIRCLE_RECORD_LENGTH>()
            .0
            .get(index)?;
        Some(WgpuApplicationCircle {
            fill_color: [record[4], record[5], record[6], record[7]],
            radius: f64::from(record[2]),
            stroke_color: [record[8], record[9], record[10], record[11]],
            stroke_width: f64::from(record[3]),
            x: f64::from(record[0]) + self.circle_offset,
            y: f64::from(record[1]) + self.circle_offset,
        })
    }

    /// Moves viewport CSS-pixel geometry into the render surface, which extends
    /// the viewport by `margin` on every side. Sizes (radii, strokes) are unchanged.
    pub(super) fn offset_into_surface(&mut self, margin: f64) {
        if margin == 0.0 {
            return;
        }
        self.width += 2.0 * margin;
        self.height += 2.0 * margin;
        self.circle_offset += margin;
        for marker in &mut self.direction_markers {
            marker.x += margin;
            marker.y += margin;
        }
        for line in &mut self.lines {
            for point in &mut line.points {
                point.x += margin;
                point.y += margin;
            }
        }
        for polygon in &mut self.polygons {
            for point in polygon
                .fill_points
                .iter_mut()
                .chain(polygon.rings.iter_mut().flatten())
            {
                point.x += margin;
                point.y += margin;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct WgpuApplicationCircle {
    pub(super) fill_color: [f32; 4],
    pub(super) radius: f64,
    pub(super) stroke_color: [f32; 4],
    pub(super) stroke_width: f64,
    pub(super) x: f64,
    pub(super) y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WgpuApplicationDirectionMarker {
    pub(super) angle: f64,
    pub(super) color: [f32; 4],
    pub(super) size: f64,
    pub(super) x: f64,
    pub(super) y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub(super) struct WgpuApplicationPoint {
    pub(super) x: f64,
    pub(super) y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WgpuApplicationLine {
    pub(super) color: [f32; 4],
    pub(super) points: Vec<WgpuApplicationPoint>,
    pub(super) stroke_width: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WgpuApplicationPolygon {
    pub(super) fill_color: [f32; 4],
    pub(super) fill_points: Vec<WgpuApplicationPoint>,
    pub(super) rings: Vec<Vec<WgpuApplicationPoint>>,
    pub(super) stroke_color: [f32; 4],
    pub(super) stroke_width: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ApplicationDraw {
    Circles {
        first_instance: u32,
        instance_count: u32,
    },
    Triangles {
        first_vertex: u32,
        vertex_count: u32,
    },
    /// A retained point group by key; its instances stay on the GPU across frames.
    RetainedPoints { group: u32 },
}

#[derive(Default)]
pub(super) struct ApplicationGeometry {
    pub(super) circle_instances: Vec<u8>,
    pub(super) triangle_vertices: Vec<u8>,
    pub(super) draws: Vec<ApplicationDraw>,
}

pub(super) fn append_tile_vertices(
    output: &mut Vec<u8>,
    placement: &WgpuRasterTilePlacement,
) -> Result<(), &'static str> {
    let values = [
        placement.local_west,
        placement.local_north,
        placement.local_size,
    ];
    if values.iter().any(|value| !value.is_finite()) || placement.local_size <= 0.0 {
        return Err("invalid raster tile local placement");
    }

    let left = placement.local_west as f32;
    let top = placement.local_north as f32;
    let right = (placement.local_west + placement.local_size) as f32;
    let bottom = (placement.local_north - placement.local_size) as f32;
    if [left, top, right, bottom]
        .into_iter()
        .any(|value| !value.is_finite())
    {
        return Err("raster tile local placement is not representable as f32");
    }

    for vertex in [
        [left, top, 0.0, 0.0],
        [left, bottom, 0.0, 1.0],
        [right, top, 1.0, 0.0],
        [right, bottom, 1.0, 1.0],
    ] {
        for value in vertex {
            output.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(())
}

pub(super) fn prepare_application_geometry(
    frame: &WgpuApplicationFrame,
) -> Result<ApplicationGeometry, &'static str> {
    if !frame.width.is_finite()
        || !frame.height.is_finite()
        || frame.width <= 0.0
        || frame.height <= 0.0
    {
        return Err("invalid wgpu application frame extent");
    }

    let mut geometry = ApplicationGeometry::default();
    let entries = frame
        .order
        .as_chunks::<APPLICATION_ORDER_RUN_LENGTH>()
        .0
        .iter()
        .flat_map(|&[kind, first, count]| {
            (u64::from(first)..u64::from(first) + u64::from(count)).map(move |index| (kind, index))
        });
    for (kind, index) in entries {
        let index = usize::try_from(index).map_err(|_| "invalid wgpu order index")?;
        match kind {
            APPLICATION_CIRCLE => {
                let first_instance = (geometry.circle_instances.len() as u64
                    / APPLICATION_CIRCLE_INSTANCE_SIZE) as u32;
                append_application_circle_instance(
                    &mut geometry.circle_instances,
                    frame.width,
                    frame.height,
                    &frame
                        .circle(index)
                        .ok_or("invalid wgpu circle order index")?,
                )?;
                append_application_draw(
                    &mut geometry.draws,
                    ApplicationDraw::Circles {
                        first_instance,
                        instance_count: 1,
                    },
                );
            }
            APPLICATION_LINE => {
                let first_vertex =
                    (geometry.triangle_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;
                append_application_line(
                    &mut geometry.triangle_vertices,
                    frame.width,
                    frame.height,
                    frame
                        .lines
                        .get(index)
                        .ok_or("invalid wgpu line order index")?,
                )?;
                let vertex_count = (geometry.triangle_vertices.len() as u64
                    / APPLICATION_VERTEX_SIZE) as u32
                    - first_vertex;
                if vertex_count > 0 {
                    append_application_draw(
                        &mut geometry.draws,
                        ApplicationDraw::Triangles {
                            first_vertex,
                            vertex_count,
                        },
                    );
                }
            }
            APPLICATION_DIRECTION_MARKER => {
                let first_vertex =
                    (geometry.triangle_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;
                append_application_direction_marker(
                    &mut geometry.triangle_vertices,
                    frame.width,
                    frame.height,
                    frame
                        .direction_markers
                        .get(index)
                        .ok_or("invalid wgpu direction marker order index")?,
                )?;
                let vertex_count = (geometry.triangle_vertices.len() as u64
                    / APPLICATION_VERTEX_SIZE) as u32
                    - first_vertex;
                append_application_draw(
                    &mut geometry.draws,
                    ApplicationDraw::Triangles {
                        first_vertex,
                        vertex_count,
                    },
                );
            }
            APPLICATION_POLYGON => {
                let first_vertex =
                    (geometry.triangle_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;
                append_application_polygon(
                    &mut geometry.triangle_vertices,
                    frame.width,
                    frame.height,
                    frame
                        .polygons
                        .get(index)
                        .ok_or("invalid wgpu polygon order index")?,
                )?;
                let vertex_count = (geometry.triangle_vertices.len() as u64
                    / APPLICATION_VERTEX_SIZE) as u32
                    - first_vertex;
                if vertex_count > 0 {
                    append_application_draw(
                        &mut geometry.draws,
                        ApplicationDraw::Triangles {
                            first_vertex,
                            vertex_count,
                        },
                    );
                }
            }
            APPLICATION_RETAINED_POINTS => {
                let group = u32::try_from(index).map_err(|_| "invalid retained point group")?;
                geometry
                    .draws
                    .push(ApplicationDraw::RetainedPoints { group });
            }
            _ => return Err("invalid wgpu application order kind"),
        }
    }
    Ok(geometry)
}

fn append_application_draw(draws: &mut Vec<ApplicationDraw>, draw: ApplicationDraw) {
    match (draws.last_mut(), draw) {
        (
            Some(ApplicationDraw::Circles {
                first_instance,
                instance_count,
            }),
            ApplicationDraw::Circles {
                first_instance: next_first,
                instance_count: next_count,
            },
        ) if *first_instance + *instance_count == next_first => {
            *instance_count += next_count;
        }
        (
            Some(ApplicationDraw::Triangles {
                first_vertex,
                vertex_count,
            }),
            ApplicationDraw::Triangles {
                first_vertex: next_first,
                vertex_count: next_count,
            },
        ) if *first_vertex + *vertex_count == next_first => {
            *vertex_count += next_count;
        }
        (_, draw) => draws.push(draw),
    }
}

fn append_application_circle_instance(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    circle: &WgpuApplicationCircle,
) -> Result<(), &'static str> {
    if [circle.x, circle.y, circle.radius, circle.stroke_width]
        .into_iter()
        .any(|value| !value.is_finite())
        || circle.radius < 0.0
        || circle.stroke_width < 0.0
        || !valid_color(circle.fill_color)
        || !valid_color(circle.stroke_color)
    {
        return Err("invalid wgpu application circle");
    }

    let outer_radius = circle.radius + circle.stroke_width / 2.0;
    let center_clip = [
        (circle.x / width * 2.0 - 1.0) as f32,
        (1.0 - circle.y / height * 2.0) as f32,
    ];
    let outer_clip = [
        (outer_radius / width * 2.0) as f32,
        (outer_radius / height * 2.0) as f32,
    ];
    if center_clip
        .into_iter()
        .chain(outer_clip)
        .any(|value| !value.is_finite())
    {
        return Err("wgpu application circle is not representable as f32");
    }
    let (fill_ratio, stroke_inner_ratio) = if outer_radius > 0.0 {
        (
            (circle.radius / outer_radius) as f32,
            if circle.stroke_width > 0.0 {
                ((circle.radius - circle.stroke_width / 2.0).max(0.0) / outer_radius) as f32
            } else {
                2.0
            },
        )
    } else {
        (0.0, 2.0)
    };

    for value in center_clip
        .into_iter()
        .chain(outer_clip)
        .chain([fill_ratio, stroke_inner_ratio])
        .chain(circle.fill_color)
        .chain(circle.stroke_color)
    {
        output.extend_from_slice(&value.to_le_bytes());
    }
    Ok(())
}

fn append_application_direction_marker(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    marker: &WgpuApplicationDirectionMarker,
) -> Result<(), &'static str> {
    if [marker.x, marker.y, marker.angle, marker.size]
        .into_iter()
        .any(|value| !value.is_finite())
        || marker.size < 0.0
        || !valid_color(marker.color)
    {
        return Err("invalid wgpu application direction marker");
    }

    let local_points = [
        (marker.size * 0.38, 0.0),
        (marker.size * -0.62, marker.size * -0.42),
        (marker.size * -0.62, marker.size * 0.42),
    ];
    let sine = marker.angle.sin();
    let cosine = marker.angle.cos();
    for (local_x, local_y) in local_points {
        let x = marker.x + local_x * cosine - local_y * sine;
        let y = marker.y + local_x * sine + local_y * cosine;
        append_application_vertex(output, width, height, x, y, marker.color)?;
    }
    Ok(())
}

fn append_application_polygon(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    polygon: &WgpuApplicationPolygon,
) -> Result<(), &'static str> {
    if polygon.fill_points.is_empty()
        || !polygon.fill_points.len().is_multiple_of(3)
        || polygon
            .fill_points
            .iter()
            .any(|point| !point.x.is_finite() || !point.y.is_finite())
        || polygon.rings.is_empty()
        || polygon.rings.iter().any(|ring| {
            ring.len() < 3
                || ring
                    .iter()
                    .any(|point| !point.x.is_finite() || !point.y.is_finite())
        })
        || !valid_color(polygon.fill_color)
        || !valid_color(polygon.stroke_color)
        || !polygon.stroke_width.is_finite()
        || polygon.stroke_width < 0.0
    {
        return Err("invalid wgpu application polygon");
    }

    for point in &polygon.fill_points {
        append_application_vertex(output, width, height, point.x, point.y, polygon.fill_color)?;
    }

    if polygon.stroke_width == 0.0 {
        return Ok(());
    }
    for ring in &polygon.rings {
        append_application_polygon_ring_stroke(
            output,
            width,
            height,
            ring,
            polygon.stroke_width,
            polygon.stroke_color,
        )?;
    }
    Ok(())
}

fn append_application_polygon_ring_stroke(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    ring: &[WgpuApplicationPoint],
    stroke_width: f64,
    color: [f32; 4],
) -> Result<(), &'static str> {
    let mut points = deduplicate_line_points(ring).into_owned();
    if points.len() > 1 {
        let first = points[0];
        let last = *points.last().expect("polygon ring is non-empty");
        let dx = last.x - first.x;
        let dy = last.y - first.y;
        if dx * dx + dy * dy <= GEOMETRY_EPSILON_SQUARED {
            points.pop();
        }
    }
    if points.len() < 3 {
        return Err("wgpu application polygon ring has fewer than three distinct points");
    }

    let half_width = stroke_width / 2.0;
    let mut directions = Vec::with_capacity(points.len());
    for index in 0..points.len() {
        directions.push(unit_direction(
            points[index],
            points[(index + 1) % points.len()],
        )?);
    }

    let mut offsets = Vec::with_capacity(points.len());
    for index in 0..points.len() {
        offsets.push(line_join_offset(
            directions[(index + directions.len() - 1) % directions.len()],
            directions[index],
            half_width,
        ));
    }

    for index in 0..points.len() {
        let start = points[index];
        let end = points[(index + 1) % points.len()];
        let start_offset = offsets[index];
        let end_offset = offsets[(index + 1) % offsets.len()];
        let start_left = (start.x + start_offset.0, start.y + start_offset.1);
        let start_right = (start.x - start_offset.0, start.y - start_offset.1);
        let end_left = (end.x + end_offset.0, end.y + end_offset.1);
        let end_right = (end.x - end_offset.0, end.y - end_offset.1);

        for point in [
            start_left,
            start_right,
            end_left,
            start_right,
            end_right,
            end_left,
        ] {
            append_application_vertex(output, width, height, point.0, point.1, color)?;
        }
    }
    Ok(())
}

fn append_application_line(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    line: &WgpuApplicationLine,
) -> Result<(), &'static str> {
    if !line.stroke_width.is_finite()
        || line.stroke_width < 0.0
        || !valid_color(line.color)
        || line
            .points
            .iter()
            .any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        return Err("invalid wgpu application line");
    }
    if line.stroke_width == 0.0 {
        return Ok(());
    }

    let points = deduplicate_line_points(&line.points);
    if points.len() < 2 {
        return Err("wgpu application line has no non-degenerate segment");
    }

    let half_width = line.stroke_width / 2.0;
    let first_direction = unit_direction(points[0], points[1])?;
    let mut current_direction = first_direction;
    let mut start_offset = line_endpoint_offset(current_direction, half_width);

    for index in 0..points.len() - 1 {
        let start = points[index];
        let end = points[index + 1];
        let next_direction = if index + 2 < points.len() {
            Some(unit_direction(points[index + 1], points[index + 2])?)
        } else {
            None
        };
        let end_offset = next_direction.map_or_else(
            || line_endpoint_offset(current_direction, half_width),
            |next| line_join_offset(current_direction, next, half_width),
        );
        let start_left = (start.x + start_offset.0, start.y + start_offset.1);
        let start_right = (start.x - start_offset.0, start.y - start_offset.1);
        let end_left = (end.x + end_offset.0, end.y + end_offset.1);
        let end_right = (end.x - end_offset.0, end.y - end_offset.1);

        for point in [
            start_left,
            start_right,
            end_left,
            start_right,
            end_right,
            end_left,
        ] {
            append_application_vertex(output, width, height, point.0, point.1, line.color)?;
        }

        start_offset = end_offset;
        if let Some(next) = next_direction {
            current_direction = next;
        }
    }

    let first = points[0];
    append_round_line_cap(
        output,
        width,
        height,
        first,
        (-first_direction.0, -first_direction.1),
        half_width,
        line.color,
    )?;
    let last = *points.last().expect("line has at least two points");
    append_round_line_cap(
        output,
        width,
        height,
        last,
        current_direction,
        half_width,
        line.color,
    )?;

    Ok(())
}

fn deduplicate_line_points(points: &[WgpuApplicationPoint]) -> Cow<'_, [WgpuApplicationPoint]> {
    let already_unique = points.windows(2).all(|segment| {
        let dx = segment[1].x - segment[0].x;
        let dy = segment[1].y - segment[0].y;
        dx * dx + dy * dy > GEOMETRY_EPSILON_SQUARED
    });
    if already_unique {
        return Cow::Borrowed(points);
    }

    let mut result = Vec::with_capacity(points.len());
    for point in points {
        let keep = result.last().is_none_or(|previous: &WgpuApplicationPoint| {
            let dx = point.x - previous.x;
            let dy = point.y - previous.y;
            dx * dx + dy * dy > GEOMETRY_EPSILON_SQUARED
        });
        if keep {
            result.push(*point);
        }
    }
    Cow::Owned(result)
}

fn unit_direction(
    start: WgpuApplicationPoint,
    end: WgpuApplicationPoint,
) -> Result<(f64, f64), &'static str> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let length_squared = dx * dx + dy * dy;
    if !length_squared.is_finite() || length_squared <= GEOMETRY_EPSILON_SQUARED {
        return Err("invalid wgpu application line segment");
    }
    let inverse_length = length_squared.sqrt().recip();
    Ok((dx * inverse_length, dy * inverse_length))
}

fn line_endpoint_offset(direction: (f64, f64), half_width: f64) -> (f64, f64) {
    (-direction.1 * half_width, direction.0 * half_width)
}

fn line_join_offset(
    previous_direction: (f64, f64),
    next_direction: (f64, f64),
    half_width: f64,
) -> (f64, f64) {
    let previous = (-previous_direction.1, previous_direction.0);
    let next = (-next_direction.1, next_direction.0);
    let sum = (previous.0 + next.0, previous.1 + next.1);
    let sum_length_squared = sum.0 * sum.0 + sum.1 * sum.1;
    if sum_length_squared <= GEOMETRY_EPSILON_SQUARED {
        return (next.0 * half_width, next.1 * half_width);
    }

    let inverse_sum_length = sum_length_squared.sqrt().recip();
    let miter = (sum.0 * inverse_sum_length, sum.1 * inverse_sum_length);
    let denominator = miter.0 * next.0 + miter.1 * next.1;
    if denominator.abs() <= GEOMETRY_EPSILON {
        return (next.0 * half_width, next.1 * half_width);
    }

    let scale = (half_width / denominator).clamp(
        -half_width * MAX_LINE_MITER_SCALE,
        half_width * MAX_LINE_MITER_SCALE,
    );
    (miter.0 * scale, miter.1 * scale)
}

fn append_round_line_cap(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    center: WgpuApplicationPoint,
    outward: (f64, f64),
    radius: f64,
    color: [f32; 4],
) -> Result<(), &'static str> {
    let normal = (-outward.1, outward.0);
    for segment in 0..LINE_CAP_SEGMENTS {
        let fraction_a = segment as f64 / LINE_CAP_SEGMENTS as f64;
        let fraction_b = (segment + 1) as f64 / LINE_CAP_SEGMENTS as f64;
        let angle_a = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * fraction_a;
        let angle_b = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * fraction_b;
        let a = point_on_oriented_circle(center, outward, normal, radius, angle_a);
        let b = point_on_oriented_circle(center, outward, normal, radius, angle_b);
        append_application_vertex(output, width, height, center.x, center.y, color)?;
        append_application_vertex(output, width, height, a.0, a.1, color)?;
        append_application_vertex(output, width, height, b.0, b.1, color)?;
    }
    Ok(())
}

fn point_on_oriented_circle(
    center: WgpuApplicationPoint,
    outward: (f64, f64),
    normal: (f64, f64),
    radius: f64,
    angle: f64,
) -> (f64, f64) {
    let along = angle.cos() * radius;
    let across = angle.sin() * radius;
    (
        center.x + outward.0 * along + normal.0 * across,
        center.y + outward.1 * along + normal.1 * across,
    )
}

fn append_application_vertex(
    output: &mut Vec<u8>,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    color: [f32; 4],
) -> Result<(), &'static str> {
    let clip_x = (x / width * 2.0 - 1.0) as f32;
    let clip_y = (1.0 - y / height * 2.0) as f32;
    if !clip_x.is_finite() || !clip_y.is_finite() {
        return Err("wgpu application position is not representable as f32");
    }

    output.extend_from_slice(&clip_x.to_le_bytes());
    output.extend_from_slice(&clip_y.to_le_bytes());
    for value in color {
        output.extend_from_slice(&value.to_le_bytes());
    }
    Ok(())
}

fn valid_color(color: [f32; 4]) -> bool {
    color
        .into_iter()
        .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
}

pub(super) fn camera_uniform_bytes(view_projection: [f32; 16]) -> [u8; 64] {
    let mut bytes = [0; 64];
    for (index, value) in view_projection.into_iter().enumerate() {
        let offset = index * 4;
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod application_geometry_tests {
    use super::*;

    /// Builds a frame through the packed transport: one record per circle and one
    /// painter-order run per entry (consecutive runs are not merged here, so tests also
    /// cover the draw-batching of separate runs).
    fn packed_frame(
        circles: Vec<WgpuApplicationCircle>,
        direction_markers: Vec<WgpuApplicationDirectionMarker>,
        height: f64,
        lines: Vec<WgpuApplicationLine>,
        order: Vec<[u32; 2]>,
        polygons: Vec<WgpuApplicationPolygon>,
        width: f64,
    ) -> WgpuApplicationFrame {
        let circle_data: Vec<f32> = circles
            .iter()
            .flat_map(|circle| {
                [
                    circle.x as f32,
                    circle.y as f32,
                    circle.radius as f32,
                    circle.stroke_width as f32,
                ]
                .into_iter()
                .chain(circle.fill_color)
                .chain(circle.stroke_color)
            })
            .collect();
        let runs: Vec<u32> = order
            .iter()
            .flat_map(|&[kind, index]| [kind, index, 1])
            .collect();
        let mut frame = WgpuApplicationFrame {
            circle_data: Vec::new(),
            circle_offset: 0.0,
            direction_markers,
            height,
            lines,
            order: Vec::new(),
            polygons,
            width,
        };
        frame.attach_packed(&circle_data, &runs).unwrap();
        frame
    }

    fn circle(x: f64) -> WgpuApplicationCircle {
        WgpuApplicationCircle {
            fill_color: [0.1, 0.2, 0.8, 1.0],
            radius: 6.0,
            stroke_color: [1.0, 1.0, 1.0, 1.0],
            stroke_width: 2.0,
            x,
            y: 50.0,
        }
    }

    fn line() -> WgpuApplicationLine {
        WgpuApplicationLine {
            color: [0.2, 0.3, 0.4, 1.0],
            points: vec![
                WgpuApplicationPoint { x: 10.0, y: 10.0 },
                WgpuApplicationPoint { x: 20.0, y: 20.0 },
            ],
            stroke_width: 2.0,
        }
    }

    fn polygon() -> WgpuApplicationPolygon {
        WgpuApplicationPolygon {
            fill_color: [0.1, 0.4, 0.2, 0.8],
            fill_points: vec![
                WgpuApplicationPoint { x: 10.0, y: 10.0 },
                WgpuApplicationPoint { x: 30.0, y: 10.0 },
                WgpuApplicationPoint { x: 30.0, y: 30.0 },
                WgpuApplicationPoint { x: 10.0, y: 10.0 },
                WgpuApplicationPoint { x: 30.0, y: 30.0 },
                WgpuApplicationPoint { x: 10.0, y: 30.0 },
            ],
            rings: vec![vec![
                WgpuApplicationPoint { x: 10.0, y: 10.0 },
                WgpuApplicationPoint { x: 30.0, y: 10.0 },
                WgpuApplicationPoint { x: 30.0, y: 30.0 },
                WgpuApplicationPoint { x: 10.0, y: 30.0 },
            ]],
            stroke_color: [1.0, 1.0, 1.0, 1.0],
            stroke_width: 2.0,
        }
    }

    #[test]
    fn render_surface_margin_offsets_every_primitive_without_changing_paint() {
        let mut frame = packed_frame(
            vec![circle(10.0)],
            vec![WgpuApplicationDirectionMarker {
                angle: 0.5,
                color: [0.1, 0.2, 0.3, 1.0],
                size: 6.0,
                x: 20.0,
                y: 30.0,
            }],
            100.0,
            vec![line()],
            vec![],
            vec![polygon()],
            200.0,
        );

        frame.offset_into_surface(128.0);

        assert_eq!((frame.width, frame.height), (456.0, 356.0));
        let circle = frame.circle(0).unwrap();
        assert_eq!((circle.x, circle.y), (138.0, 178.0));
        assert_eq!((circle.radius, circle.stroke_width), (6.0, 2.0));
        assert_eq!(
            (frame.direction_markers[0].x, frame.direction_markers[0].y),
            (148.0, 158.0)
        );
        assert_eq!(
            (
                frame.direction_markers[0].size,
                frame.direction_markers[0].angle
            ),
            (6.0, 0.5)
        );
        assert_eq!(
            (frame.lines[0].points[0].x, frame.lines[0].points[0].y),
            (138.0, 138.0)
        );
        for (point, original) in frame.polygons[0]
            .fill_points
            .iter()
            .zip(polygon().fill_points)
        {
            assert_eq!((point.x, point.y), (original.x + 128.0, original.y + 128.0));
        }
        for (ring, original) in frame.polygons[0].rings.iter().zip(polygon().rings) {
            for (point, original) in ring.iter().zip(original) {
                assert_eq!((point.x, point.y), (original.x + 128.0, original.y + 128.0));
            }
        }
        assert_eq!(frame.polygons[0].stroke_width, 2.0);
        assert_eq!(frame.polygons[0].fill_color, [0.1, 0.4, 0.2, 0.8]);
    }

    #[test]
    fn dense_circles_use_one_instanced_draw_without_triangle_tessellation() {
        let count = 10_000_u32;
        let frame = packed_frame(
            (0..count).map(|index| circle(f64::from(index))).collect(),
            Vec::new(),
            100.0,
            Vec::new(),
            (0..count)
                .map(|index| [APPLICATION_CIRCLE, index])
                .collect(),
            Vec::new(),
            100.0,
        );

        let geometry = prepare_application_geometry(&frame).unwrap();

        assert!(geometry.triangle_vertices.is_empty());
        assert_eq!(
            geometry.circle_instances.len() as u64,
            u64::from(count) * APPLICATION_CIRCLE_INSTANCE_SIZE
        );
        assert_eq!(
            geometry.draws,
            vec![ApplicationDraw::Circles {
                first_instance: 0,
                instance_count: count,
            }]
        );
    }

    #[test]
    fn polygon_fill_and_closed_stroke_use_existing_triangle_path() {
        let frame = packed_frame(
            Vec::new(),
            Vec::new(),
            100.0,
            Vec::new(),
            vec![[APPLICATION_POLYGON, 0]],
            vec![polygon()],
            100.0,
        );

        let geometry = prepare_application_geometry(&frame).unwrap();
        let vertex_count =
            (geometry.triangle_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;

        assert_eq!(vertex_count, 30);
        assert_eq!(
            geometry.draws,
            vec![ApplicationDraw::Triangles {
                first_vertex: 0,
                vertex_count,
            }]
        );
    }

    #[test]
    fn polygon_between_circles_preserves_painter_order() {
        let frame = packed_frame(
            vec![circle(10.0), circle(40.0)],
            Vec::new(),
            100.0,
            Vec::new(),
            vec![
                [APPLICATION_CIRCLE, 0],
                [APPLICATION_POLYGON, 0],
                [APPLICATION_CIRCLE, 1],
            ],
            vec![polygon()],
            100.0,
        );

        let geometry = prepare_application_geometry(&frame).unwrap();
        let polygon_vertices =
            (geometry.triangle_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;

        assert_eq!(
            geometry.draws,
            vec![
                ApplicationDraw::Circles {
                    first_instance: 0,
                    instance_count: 1,
                },
                ApplicationDraw::Triangles {
                    first_vertex: 0,
                    vertex_count: polygon_vertices,
                },
                ApplicationDraw::Circles {
                    first_instance: 1,
                    instance_count: 1,
                },
            ]
        );
    }

    #[test]
    fn interleaved_circle_and_line_batches_preserve_painter_order() {
        let frame = packed_frame(
            vec![circle(10.0), circle(30.0), circle(40.0)],
            Vec::new(),
            100.0,
            vec![line()],
            vec![
                [APPLICATION_CIRCLE, 0],
                [APPLICATION_CIRCLE, 1],
                [APPLICATION_LINE, 0],
                [APPLICATION_CIRCLE, 2],
            ],
            Vec::new(),
            100.0,
        );

        let geometry = prepare_application_geometry(&frame).unwrap();
        let line_vertices =
            (geometry.triangle_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;

        assert!(line_vertices > 0);
        assert_eq!(
            geometry.draws,
            vec![
                ApplicationDraw::Circles {
                    first_instance: 0,
                    instance_count: 2,
                },
                ApplicationDraw::Triangles {
                    first_vertex: 0,
                    vertex_count: line_vertices,
                },
                ApplicationDraw::Circles {
                    first_instance: 2,
                    instance_count: 1,
                },
            ]
        );
    }
    #[test]
    fn one_painter_order_run_covers_a_dense_circle_batch() {
        let count = 4_u32;
        let mut frame = packed_frame(
            (0..count).map(|index| circle(f64::from(index))).collect(),
            Vec::new(),
            100.0,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            100.0,
        );
        frame.order = vec![APPLICATION_CIRCLE, 0, count];

        let geometry = prepare_application_geometry(&frame).unwrap();

        assert_eq!(
            geometry.draws,
            vec![ApplicationDraw::Circles {
                first_instance: 0,
                instance_count: count,
            }]
        );
    }

    #[test]
    fn malformed_packed_circles_and_order_fail_closed() {
        let mut frame = packed_frame(
            vec![circle(1.0)],
            Vec::new(),
            100.0,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            100.0,
        );
        assert!(frame.attach_packed(&[0.0; 11], &[]).is_err());
        assert!(frame.attach_packed(&[0.0; 12], &[0, 0]).is_err());
        // An order run beyond the packed circles is rejected, not read out of bounds.
        frame
            .attach_packed(&[0.0; 12], &[APPLICATION_CIRCLE, 0, 2])
            .unwrap();
        assert!(prepare_application_geometry(&frame).is_err());
    }
}

#[cfg(test)]
mod surface_clip_tests {
    use super::*;

    #[test]
    fn viewport_scissor_covers_exactly_the_viewport_inside_the_margin() {
        let clip = SurfaceClip {
            margin: 128.0,
            viewport: Some((1024.0, 768.0)),
            pixel_ratio: 1.0,
        };
        // 1x: the surface is 1280 x 1024 physical pixels.
        assert_eq!(clip.scissor(1280, 1024), Some((128, 128, 1024, 768)));
        // 2x device pixels scale the scissor with the surface.
        assert_eq!(clip.scissor(2560, 2048), Some((256, 256, 2048, 1536)));
    }

    #[test]
    fn fractional_scissors_round_outward_and_stay_inside_the_surface() {
        let clip = SurfaceClip {
            margin: 10.5,
            viewport: Some((99.3, 50.0)),
            pixel_ratio: 1.0,
        };
        let (x, y, width, height) = clip.scissor(241, 142).unwrap();
        let scale_x = 241.0 / (99.3 + 21.0);
        assert!(f64::from(x) <= 10.5 * scale_x);
        assert!(f64::from(x + width) >= (10.5 + 99.3) * scale_x);
        assert!(x + width <= 241 && y + height <= 142);
    }

    #[test]
    fn a_full_surface_render_has_no_scissor() {
        let clip = SurfaceClip {
            margin: 128.0,
            viewport: None,
            pixel_ratio: 1.0,
        };
        assert_eq!(clip.scissor(1280, 1024), None);
    }
}

#[cfg(test)]
mod raster_geometry_tests {
    use super::*;

    #[test]
    fn packed_draws_preserve_camera_clip_tile_identity_and_local_quad() {
        let matrix = [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let mut packed = matrix.to_vec();
        packed.extend([12.0, 99.0, 50.0, 2.0, 2.0, 3.0, 1.0, 100.0, 200.0, 64.0]);

        let (camera, clip, mut placements) = unpack_tile_draws(&packed).unwrap();
        assert_eq!(
            clip,
            SurfaceClip {
                margin: 12.0,
                viewport: Some((99.0, 50.0)),
                pixel_ratio: 2.0,
            }
        );
        let tile = placements.next().unwrap();
        assert_eq!(tile.key, Some((2, 3, 1)));
        assert!(placements.next().is_none());
        let mut vertices = Vec::new();
        append_tile_vertices(&mut vertices, &tile).unwrap();
        let values: Vec<f32> = vertices
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();
        assert_eq!(
            values,
            [
                100.0, 200.0, 0.0, 0.0, 100.0, 136.0, 0.0, 1.0, 164.0, 200.0, 1.0, 0.0, 164.0,
                136.0, 1.0, 1.0
            ]
        );
        assert_eq!(camera_uniform_bytes(camera)[..4], [0, 0, 128, 63]);
        assert_eq!(camera_uniform_bytes(camera)[4..8], [0, 0, 0, 0]);
        assert_eq!(camera_uniform_bytes(camera)[60..], [0, 0, 128, 63]);
    }

    #[test]
    fn malformed_packed_draws_and_unrepresentable_tile_geometry_fail_closed() {
        assert!(unpack_tile_draws(&[]).is_err());
        assert!(unpack_tile_draws(&[0.0; 21]).is_err());
        for (margin, width, height, pixel_ratio) in [
            (-1.0, 0.0, 0.0, 1.0),
            (f64::NAN, 0.0, 0.0, 1.0),
            (0.0, 10.0, 0.0, 1.0),
            (0.0, f64::INFINITY, 10.0, 1.0),
            (0.0, 0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, f64::NAN),
        ] {
            let mut packed = [0.0; 20];
            packed[16..].copy_from_slice(&[margin, width, height, pixel_ratio]);
            assert!(unpack_tile_draws(&packed).is_err());
        }
        for (west, north, size) in [(0.0, 0.0, 0.0), (f64::NAN, 0.0, 1.0), (f64::MAX, 0.0, 1.0)] {
            let tile = WgpuRasterTilePlacement {
                key: Some((0, 0, 0)),
                local_west: west,
                local_north: north,
                local_size: size,
            };
            assert!(append_tile_vertices(&mut Vec::new(), &tile).is_err());
        }
    }
}
