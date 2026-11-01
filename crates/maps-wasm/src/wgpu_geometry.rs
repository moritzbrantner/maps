//! Maps-specific pixel geometry preparation, shared by the browser backend and native tests.

use maps_core::{LineCap, LineJoin, LineLayout, LineMesh};
use serde::Deserialize;
use std::borrow::Cow;

/// Homogeneous clip position `(x, y, w)` (3 x f32), RGBA (4 x f32), edge (3 x f32): see
/// `shaders/application.wgsl`.
pub(super) const APPLICATION_VERTEX_SIZE: u64 = 40;
/// The edge of fills and markers: never faded.
const FILL_EDGE: [f32; 3] = [0.0, 0.0, 1.0e6];
/// Fill outline vertices carry their endpoint's window position (physical px) in `edge.xy`;
/// `edge.z` is unused by `fs_outline`.
const OUTLINE_EDGE: f32 = 0.0;
pub(super) const APPLICATION_CIRCLE_INSTANCE_SIZE: u64 = 56;
const LINE_CAP_SEGMENTS: usize = 12;
const GEOMETRY_EPSILON: f64 = 1.0e-9;
const GEOMETRY_EPSILON_SQUARED: f64 = GEOMETRY_EPSILON * GEOMETRY_EPSILON;
pub(super) const APPLICATION_CIRCLE: u32 = 0;
const APPLICATION_LINE: u32 = 1;
const APPLICATION_DIRECTION_MARKER: u32 = 2;
const APPLICATION_POLYGON: u32 = 3;
/// A retained point group (#155), drawn at this painter-order position: run
/// (kind, group key, 1).
const APPLICATION_RETAINED_POINTS: u32 = 4;
/// A retained polygon group (#196): run (kind, group key, 1).
const APPLICATION_RETAINED_POLYGONS: u32 = 5;

/// Raster tile identity (z, x, y) shared with the host's tile lifecycle.
pub(super) type RasterTileKey = (u8, u32, u32);

/// Packed tile draw input shared with `src/wgpu-base-map-wasm.ts`: 16
/// view-projection elements, the render-surface margin (CSS px per side), the
/// viewport clip width/height (CSS px; 0 draws the whole surface), the CSS-to-
/// physical pixel ratio and the raster pixel-grid alignment x, y (local CSS px, 0
/// in motion), followed by one [`PACKED_TILE_DRAW_STRIDE`] record per placement
/// (z, x, y, local west, local north, local size, opacity).
const PACKED_TILE_DRAW_HEADER_LENGTH: usize = 22;
const PACKED_TILE_DRAW_STRIDE: usize = 7;

pub(super) struct WgpuRasterTilePlacement {
    pub(super) key: Option<RasterTileKey>,
    pub(super) local_west: f64,
    pub(super) local_north: f64,
    pub(super) local_size: f64,
    pub(super) opacity: f32,
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
        RasterAlignment,
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
    let alignment = [header[20], header[21]];
    if alignment
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 1.0)
    {
        return Err("invalid wgpu raster alignment");
    }
    Ok((
        view_projection,
        SurfaceClip {
            margin,
            viewport,
            pixel_ratio,
        },
        alignment,
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
        opacity: record[6] as f32,
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
            for point in polygon.rings.iter_mut().flatten() {
                point.x += margin;
                point.y += margin;
            }
        }
    }

    /// Takes line and polygon points from the render surface back onto the flat map plane
    /// of a pitched camera, where they are stroked like MapLibre's tile geometry. Circles
    /// and direction markers stay screen-aligned.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "wgpu-base-map")),
        allow(dead_code)
    )]
    pub(super) fn place_on_ground(
        &mut self,
        ground: &GroundPerspective,
    ) -> Result<(), &'static str> {
        let lines = self
            .lines
            .iter_mut()
            .flat_map(|line| line.points.iter_mut());
        let polygons = self
            .polygons
            .iter_mut()
            .flat_map(|polygon| polygon.rings.iter_mut().flatten());
        for point in lines.chain(polygons) {
            let (x, y) = ground
                .flat(point.x, point.y)
                .ok_or("wgpu application point lies beyond the horizon")?;
            point.x = x;
            point.y = y;
        }
        // Polygon vertices lie where MapLibre's GeoJSON tiles quantize them (#331).
        if let Some(tiles) = ground.geojson_tiles {
            for point in self
                .polygons
                .iter_mut()
                .flat_map(|polygon| polygon.rings.iter_mut().flatten())
            {
                (point.x, point.y) = tiles.snap(point.x, point.y);
            }
        }
        Ok(())
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
    /// `line-cap` (0 butt, 1 round, 2 square), `line-join` (0 bevel, 1 round, 2 miter),
    /// `line-miter-limit`, `line-round-limit`, as the retained paint record holds them.
    #[serde(default = "round_line_layout")]
    pub(super) line_layout: [f64; 4],
}

fn round_line_layout() -> [f64; 4] {
    [1.0, 1.0, 2.0, 1.05]
}

fn decode_line_layout(
    [cap, join, miter_limit, round_limit]: [f64; 4],
) -> Result<LineLayout, &'static str> {
    Ok(LineLayout {
        cap: match cap {
            0.0 => LineCap::Butt,
            1.0 => LineCap::Round,
            2.0 => LineCap::Square,
            _ => return Err("invalid wgpu application line cap"),
        },
        join: match join {
            0.0 => LineJoin::Bevel,
            1.0 => LineJoin::Round,
            2.0 => LineJoin::Miter,
            _ => return Err("invalid wgpu application line join"),
        },
        miter_limit,
        round_limit,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WgpuApplicationPolygon {
    pub(super) fill_color: [f32; 4],
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
    RetainedPoints {
        group: u32,
    },
    /// A retained polygon group by key; its geometry stays on the GPU across frames.
    RetainedPolygons {
        group: u32,
    },
    Polygon(PolygonDraw),
}

/// One polygon's ranges in the application triangle buffer. The fill is even-odd, like
/// Canvas: a fan per ring inverts the stencil, then a bounding cover paints and clears it.
/// The stroke paints each pixel once, so a translucent stroke blends like one Canvas stroke.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct PolygonDraw {
    pub(super) fan_first: u32,
    /// Zero when the polygon has no visible fill; the cover follows the fan.
    pub(super) fan_count: u32,
    pub(super) cover_first: u32,
    /// MapLibre's `fill-antialias` outline over the fill, under the stroke (#331).
    pub(super) outline_first: u32,
    pub(super) outline_count: u32,
    pub(super) stroke_first: u32,
    pub(super) stroke_count: u32,
}

pub(super) const POLYGON_COVER_VERTEX_COUNT: u32 = 6;

#[derive(Default)]
pub(super) struct ApplicationGeometry {
    pub(super) circle_instances: Vec<u8>,
    pub(super) triangle_vertices: Vec<u8>,
    pub(super) draws: Vec<ApplicationDraw>,
}

/// Local-plane offset (CSS px, +x east, +y north) added to raster tile quads only.
pub(super) type RasterAlignment = [f64; 2];

pub(super) fn append_tile_vertices(
    output: &mut Vec<u8>,
    placement: &WgpuRasterTilePlacement,
    [align_x, align_y]: RasterAlignment,
) -> Result<(), &'static str> {
    let values = [
        placement.local_west,
        placement.local_north,
        placement.local_size,
        f64::from(placement.opacity),
    ];
    if values.iter().any(|value| !value.is_finite())
        || placement.local_size <= 0.0
        || !(0.0..=1.0).contains(&placement.opacity)
    {
        return Err("invalid raster tile local placement");
    }

    let west = placement.local_west + align_x;
    let north = placement.local_north + align_y;
    let left = west as f32;
    let top = north as f32;
    let right = (west + placement.local_size) as f32;
    let bottom = (north - placement.local_size) as f32;
    if [left, top, right, bottom]
        .into_iter()
        .any(|value| !value.is_finite())
    {
        return Err("raster tile local placement is not representable as f32");
    }

    for vertex in [
        [left, top, 0.0, 0.0, placement.opacity],
        [left, bottom, 0.0, 1.0, placement.opacity],
        [right, top, 1.0, 0.0, placement.opacity],
        [right, bottom, 1.0, 1.0, placement.opacity],
    ] {
        for value in vertex {
            output.extend_from_slice(&value.to_le_bytes());
        }
    }
    Ok(())
}

/// The pitched camera's map plane, seen from the application frame (#328).
///
/// MapLibre draws circles, lines and fills as tile geometry on the ground: line widths and
/// joins are extruded on the map plane and shrink with distance, and circles scale with
/// `camera_to_center_distance / w` (`circle-pitch-scale: map`). Under a pitched render camera
/// the application frame's screen points are taken back to the flat, north-up plane at the
/// camera zoom (CSS px, +y south), stroked there, and every vertex is projected with the
/// homography `flat -> clip` read from the render camera's view-projection.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct GroundPerspective {
    /// Rows of the `flat (x, y, 1) -> clip (x, y, w)` homography.
    forward: [[f64; 3]; 3],
    inverse: [[f64; 3]; 3],
    /// Clip `w` (eye depth, CSS px) of the map center: MapLibre's `camera_to_center_distance`.
    center_depth: f64,
    width: f64,
    height: f64,
    /// MapLibre's GeoJSON tile grid on this plane, which clips fill outlines (#331).
    geojson_tiles: Option<GeoJsonTileGrid>,
}

impl GroundPerspective {
    /// The ground homography of `view_projection` (column-major, local map plane in CSS px,
    /// +y north) for a `width` x `height` CSS-px surface; `None` for an unpitched camera, whose
    /// clip `w` does not vary over the map plane.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "wgpu-base-map")),
        allow(dead_code)
    )]
    pub(super) fn new(view_projection: [f32; 16], width: f64, height: f64) -> Option<Self> {
        let m = |column: usize, row: usize| f64::from(view_projection[column * 4 + row]);
        if m(0, 3) == 0.0 && m(1, 3) == 0.0 {
            return None;
        }
        let forward = [
            [m(0, 0), -m(1, 0), m(3, 0)],
            [m(0, 1), -m(1, 1), m(3, 1)],
            [m(0, 3), -m(1, 3), m(3, 3)],
        ];
        let inverse = invert_3x3(forward)?;
        let center_depth = m(3, 3);
        if center_depth.is_nan() || center_depth <= 0.0 || !width.is_finite() || !height.is_finite()
        {
            return None;
        }
        Some(Self {
            forward,
            inverse,
            center_depth,
            width,
            height,
            geojson_tiles: None,
        })
    }

    /// This plane with MapLibre's GeoJSON tile grid, which clips fill outlines (#331).
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "wgpu-base-map")),
        allow(dead_code)
    )]
    pub(super) fn with_geojson_tiles(self, geojson_tiles: Option<GeoJsonTileGrid>) -> Self {
        Self {
            geojson_tiles,
            ..self
        }
    }

    /// Homogeneous clip position `(x, y, w)` of a flat-plane point.
    fn clip(&self, x: f64, y: f64) -> [f64; 3] {
        self.forward.map(|row| row[0] * x + row[1] * y + row[2])
    }

    /// The flat-plane point under a surface CSS-px position.
    pub(super) fn flat(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let ndc = [x / self.width * 2.0 - 1.0, 1.0 - y / self.height * 2.0, 1.0];
        let [fx, fy, fw] = self
            .inverse
            .map(|row| row[0] * ndc[0] + row[1] * ndc[1] + row[2] * ndc[2]);
        if !fw.is_finite() || fw.abs() <= f64::EPSILON {
            return None;
        }
        let point = (fx / fw, fy / fw);
        (point.0.is_finite() && point.1.is_finite()).then_some(point)
    }

    /// MapLibre's `circle-pitch-scale: map` factor at a surface CSS-px position.
    fn depth_scale(&self, x: f64, y: f64) -> Option<f64> {
        let (fx, fy) = self.flat(x, y)?;
        let [_, _, w] = self.clip(fx, fy);
        let scale = self.center_depth / w;
        (scale.is_finite() && scale > 0.0).then_some(scale)
    }
}

fn invert_3x3(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let minor =
        |r0: usize, r1: usize, c0: usize, c1: usize| m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0];
    let adjugate = [
        [minor(1, 2, 1, 2), -minor(0, 2, 1, 2), minor(0, 1, 1, 2)],
        [-minor(1, 2, 0, 2), minor(0, 2, 0, 2), -minor(0, 1, 0, 2)],
        [minor(1, 2, 0, 1), -minor(0, 2, 0, 1), minor(0, 1, 0, 1)],
    ];
    let determinant =
        m[0][0] * adjugate[0][0] + m[0][1] * adjugate[1][0] + m[0][2] * adjugate[2][0];
    if !determinant.is_finite() || determinant.abs() <= f64::MIN_POSITIVE {
        return None;
    }
    Some(adjugate.map(|row| row.map(|value| value / determinant)))
}

/// MapLibre's GeoJSON source tiles (512 px, at the floored camera zoom) on the flat plane of
/// a pitched camera (#331). geojson-vt clips each tile's polygons 128 of its 512 px beyond
/// the tile, and each tile draws its clipped copy inside its own stencil; a fill outline's
/// `v_pos` runs between the clipped endpoints, so the grid decides where it drifts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct GeoJsonTileGrid {
    /// Flat-plane position of the world's north-west corner (CSS px, +y south).
    origin: [f64; 2],
    /// One tile's flat-plane size (CSS px).
    size: f64,
}

/// geojson-vt's `buffer` over MapLibre's 512 px GeoJSON tile.
const GEOJSON_TILE_BUFFER: f64 = 128.0 / 512.0;
/// MapLibre's GeoJSON tile extent (`EXTENT`).
const GEOJSON_TILE_EXTENT: f64 = 8192.0;

impl GeoJsonTileGrid {
    /// The grid from a raster placement, whose quadtree key and local-plane extent fix the
    /// world's position and size on the plane.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "wgpu-base-map")),
        allow(dead_code)
    )]
    pub(super) fn from_placement(placement: &WgpuRasterTilePlacement) -> Option<Self> {
        let (z, x, y) = placement.key?;
        let size = placement.local_size;
        if !size.is_finite() || size <= 0.0 {
            return None;
        }
        // Any quadtree tile spans 512 CSS px at its own zoom.
        let zoom = f64::from(z) + (size / 512.0).log2();
        let tile_zoom = (zoom + 1.0e-9).floor().max(0.0);
        let grid = Self {
            origin: [
                placement.local_west - f64::from(x) * size,
                -placement.local_north - f64::from(y) * size,
            ],
            size: size * (f64::from(z) - tile_zoom).exp2(),
        };
        (grid.origin.iter().all(|value| value.is_finite()) && grid.size.is_finite()).then_some(grid)
    }

    /// A flat-plane point rounded to the tile extent grid, as geojson-vt's `Math.round` of
    /// the tile coordinates does.
    fn snap(&self, x: f64, y: f64) -> (f64, f64) {
        let unit = self.size / GEOJSON_TILE_EXTENT;
        let round =
            |value: f64, origin: f64| origin + ((value - origin) / unit + 0.5).floor() * unit;
        (round(x, self.origin[0]), round(y, self.origin[1]))
    }

    /// The pieces of the flat segment `start -> end` that the tiles draw: per tile, the
    /// segment parameters `(drawn, interpolated)` of the part inside the tile and of the
    /// buffered part its clipped geometry holds.
    fn pieces(
        &self,
        start: WgpuApplicationPoint,
        end: WgpuApplicationPoint,
    ) -> Vec<([f64; 2], [f64; 2])> {
        let index = |value: f64, origin: f64| ((value - origin) / self.size).floor() as i64;
        let (x0, x1) = (
            index(start.x.min(end.x), self.origin[0]),
            index(start.x.max(end.x), self.origin[0]),
        );
        let (y0, y1) = (
            index(start.y.min(end.y), self.origin[1]),
            index(start.y.max(end.y), self.origin[1]),
        );
        let mut pieces = Vec::new();
        for column in x0..=x1 {
            for row in y0..=y1 {
                let west = self.origin[0] + column as f64 * self.size;
                let north = self.origin[1] + row as f64 * self.size;
                let clip = |margin: f64| {
                    clip_segment(
                        start,
                        end,
                        [west - margin, north - margin],
                        [west + self.size + margin, north + self.size + margin],
                    )
                };
                if let (Some(drawn), Some(interpolated)) =
                    (clip(0.0), clip(self.size * GEOJSON_TILE_BUFFER))
                    && drawn[1] > drawn[0]
                {
                    pieces.push((drawn, interpolated));
                }
            }
        }
        pieces
    }
}

/// Liang-Barsky: the parameter range of `start -> end` inside the box `min..max`.
fn clip_segment(
    start: WgpuApplicationPoint,
    end: WgpuApplicationPoint,
    min: [f64; 2],
    max: [f64; 2],
) -> Option<[f64; 2]> {
    let (mut low, mut high) = (0.0_f64, 1.0_f64);
    for (origin, delta, min, max) in [
        (start.x, end.x - start.x, min[0], max[0]),
        (start.y, end.y - start.y, min[1], max[1]),
    ] {
        if delta == 0.0 {
            if origin < min || origin > max {
                return None;
            }
            continue;
        }
        let (a, b) = ((min - origin) / delta, (max - origin) / delta);
        low = low.max(a.min(b));
        high = high.min(a.max(b));
    }
    (low <= high).then_some([low, high])
}

/// Where application vertices are written: the screen (surface CSS px), or the flat map
/// plane of a pitched camera.
#[derive(Clone, Copy, Debug)]
struct ApplicationSpace {
    width: f64,
    height: f64,
    ground: Option<GroundPerspective>,
}

pub(super) fn prepare_application_geometry(
    frame: &WgpuApplicationFrame,
    pixel_ratio: f64,
    ground: Option<GroundPerspective>,
) -> Result<ApplicationGeometry, &'static str> {
    if !frame.width.is_finite()
        || !frame.height.is_finite()
        || frame.width <= 0.0
        || frame.height <= 0.0
    {
        return Err("invalid wgpu application frame extent");
    }
    let screen = ApplicationSpace {
        width: frame.width,
        height: frame.height,
        ground: None,
    };
    let space = ApplicationSpace { ground, ..screen };

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
                    space,
                    pixel_ratio,
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
                    space,
                    pixel_ratio,
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
                // Markers stay screen-aligned arrows, like MapLibre's viewport-aligned icons.
                append_application_direction_marker(
                    &mut geometry.triangle_vertices,
                    screen,
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
                let draw = append_application_polygon(
                    &mut geometry.triangle_vertices,
                    space,
                    pixel_ratio,
                    frame
                        .polygons
                        .get(index)
                        .ok_or("invalid wgpu polygon order index")?,
                )?;
                if draw.fan_count > 0 || draw.stroke_count > 0 {
                    geometry.draws.push(ApplicationDraw::Polygon(draw));
                }
            }
            APPLICATION_RETAINED_POINTS => {
                let group = u32::try_from(index).map_err(|_| "invalid retained point group")?;
                geometry
                    .draws
                    .push(ApplicationDraw::RetainedPoints { group });
            }
            APPLICATION_RETAINED_POLYGONS => {
                let group = u32::try_from(index).map_err(|_| "invalid retained polygon group")?;
                geometry
                    .draws
                    .push(ApplicationDraw::RetainedPolygons { group });
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
    space: ApplicationSpace,
    pixel_ratio: f64,
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

    // MapLibre circles: the stroke lies outside the radius.
    let outer_radius = circle.radius + circle.stroke_width;
    let ApplicationSpace { width, height, .. } = space;
    // Under pitch the circle stays screen-aligned but scales with its depth.
    let depth_scale = match space.ground {
        Some(ground) => ground
            .depth_scale(circle.x, circle.y)
            .ok_or("wgpu application circle lies beyond the horizon")?,
        None => 1.0,
    };
    let center_clip = [
        (circle.x / width * 2.0 - 1.0) as f32,
        (1.0 - circle.y / height * 2.0) as f32,
    ];
    let outer_clip = [
        (outer_radius * depth_scale / width * 2.0) as f32,
        (outer_radius * depth_scale / height * 2.0) as f32,
    ];
    if center_clip
        .into_iter()
        .chain(outer_clip)
        .any(|value| !value.is_finite())
    {
        return Err("wgpu application circle is not representable as f32");
    }
    // MapLibre: no stroke below 0.01 px; a one-physical-pixel smoothstep at each edge.
    let (fill_ratio, blur) = if outer_radius > 0.0 {
        (
            if circle.stroke_width >= 0.01 {
                (circle.radius / outer_radius) as f32
            } else {
                2.0
            },
            (1.0 / (pixel_ratio * outer_radius)) as f32,
        )
    } else {
        (2.0, 1.0)
    };

    for value in center_clip
        .into_iter()
        .chain(outer_clip)
        .chain([fill_ratio, blur])
        .chain(circle.fill_color)
        .chain(circle.stroke_color)
    {
        output.extend_from_slice(&value.to_le_bytes());
    }
    Ok(())
}

fn append_application_direction_marker(
    output: &mut Vec<u8>,
    space: ApplicationSpace,
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
        append_application_vertex(output, space, x, y, marker.color, FILL_EDGE)?;
    }
    Ok(())
}

/// MapLibre's line antialiasing (#309): a stroke extends half a physical pixel past its half
/// width, fading linearly over one pixel.
#[derive(Clone, Copy)]
struct StrokeEdges {
    /// Half width plus the antialiasing outset (CSS px).
    outset: f64,
    /// Outer extent in physical px.
    extent: f32,
    /// Vertex edges (MapLibre's `v_normal`, then the extent) at the stroke centre, its
    /// left and its right boundary.
    centre: [f32; 3],
    left: [f32; 3],
    right: [f32; 3],
}

impl StrokeEdges {
    fn with_normal(self, normal: [f32; 2]) -> [f32; 3] {
        [normal[0], normal[1], self.extent]
    }
}

fn stroke_edges(half_width: f64, pixel_ratio: f64) -> StrokeEdges {
    let outset = half_width + 0.5 / pixel_ratio;
    let extent = (outset * pixel_ratio) as f32;
    StrokeEdges {
        outset,
        extent,
        centre: [0.0, 0.0, extent],
        left: [1.0, 0.0, extent],
        right: [-1.0, 0.0, extent],
    }
}

fn append_application_polygon(
    output: &mut Vec<u8>,
    space: ApplicationSpace,
    pixel_ratio: f64,
    polygon: &WgpuApplicationPolygon,
) -> Result<PolygonDraw, &'static str> {
    if polygon.rings.is_empty()
        || polygon
            .rings
            .iter()
            .flatten()
            .any(|point| !point.x.is_finite() || !point.y.is_finite())
        || !valid_color(polygon.fill_color)
        || !valid_color(polygon.stroke_color)
        || !polygon.stroke_width.is_finite()
        || polygon.stroke_width < 0.0
    {
        return Err("invalid wgpu application polygon");
    }

    // Degenerate rings cover no area; Canvas still strokes them.
    let rings: Vec<Cow<'_, [WgpuApplicationPoint]>> = polygon
        .rings
        .iter()
        .map(|ring| open_polygon_ring(ring))
        .filter(|ring| ring.len() >= 2)
        .collect();
    let vertex_index = |output: &Vec<u8>| (output.len() as u64 / APPLICATION_VERTEX_SIZE) as u32;
    let mut draw = PolygonDraw::default();

    let fill_rings = || rings.iter().filter(|ring| ring.len() >= 3);
    if polygon.fill_color[3] > 0.0
        && let Some(anchor) = fill_rings().next().map(|ring| ring[0])
    {
        draw.fan_first = vertex_index(output);
        let (mut min_x, mut min_y) = (anchor.x, anchor.y);
        let (mut max_x, mut max_y) = (anchor.x, anchor.y);
        for ring in fill_rings() {
            for (index, &point) in ring.iter().enumerate() {
                let next = ring[(index + 1) % ring.len()];
                for vertex in [anchor, point, next] {
                    append_application_vertex(
                        output,
                        space,
                        vertex.x,
                        vertex.y,
                        polygon.fill_color,
                        FILL_EDGE,
                    )?;
                }
                min_x = min_x.min(point.x);
                min_y = min_y.min(point.y);
                max_x = max_x.max(point.x);
                max_y = max_y.max(point.y);
            }
        }
        draw.cover_first = vertex_index(output);
        draw.fan_count = draw.cover_first - draw.fan_first;
        for (x, y) in [
            (min_x, min_y),
            (max_x, min_y),
            (max_x, max_y),
            (min_x, min_y),
            (max_x, max_y),
            (min_x, max_y),
        ] {
            append_application_vertex(output, space, x, y, polygon.fill_color, FILL_EDGE)?;
        }

        draw.outline_first = vertex_index(output);
        for ring in fill_rings() {
            for (index, &start) in ring.iter().enumerate() {
                let end = ring[(index + 1) % ring.len()];
                append_fill_outline_segment(
                    output,
                    space,
                    pixel_ratio,
                    start,
                    end,
                    polygon.fill_color,
                )?;
            }
        }
        draw.outline_count = vertex_index(output) - draw.outline_first;
    }

    if polygon.stroke_width > 0.0 && polygon.stroke_color[3] > 0.0 && !rings.is_empty() {
        draw.stroke_first = vertex_index(output);
        let edges = stroke_edges(polygon.stroke_width / 2.0, pixel_ratio);
        for ring in &rings {
            for (index, &start) in ring.iter().enumerate() {
                let end = ring[(index + 1) % ring.len()];
                let offset = line_endpoint_offset(unit_direction(start, end)?, edges.outset);
                let start_left = (start.x + offset.0, start.y + offset.1);
                let start_right = (start.x - offset.0, start.y - offset.1);
                let end_left = (end.x + offset.0, end.y + offset.1);
                let end_right = (end.x - offset.0, end.y - offset.1);
                let (start_centre, end_centre) = ((start.x, start.y), (end.x, end.y));
                for (centre, point, edge) in [
                    (start_centre, start_left, edges.left),
                    (start_centre, start_right, edges.right),
                    (end_centre, end_left, edges.left),
                    (start_centre, start_right, edges.right),
                    (end_centre, end_right, edges.right),
                    (end_centre, end_left, edges.left),
                ] {
                    append_stroke_vertex(
                        output,
                        space,
                        point,
                        (centre, point),
                        polygon.stroke_color,
                        edge,
                    )?;
                }
                // Round joins, as MapLibre's `line-join: round` outline layer.
                append_round_join(output, space, start, polygon.stroke_color, edges)?;
            }
        }
        draw.stroke_count = vertex_index(output) - draw.stroke_first;
    }
    Ok(draw)
}

/// Distinct consecutive points of a ring, without the closing repeat of its first point.
fn open_polygon_ring(ring: &[WgpuApplicationPoint]) -> Cow<'_, [WgpuApplicationPoint]> {
    let mut points = deduplicate_line_points(ring);
    if points.len() > 1 {
        let first = points[0];
        let last = points[points.len() - 1];
        let dx = last.x - first.x;
        let dy = last.y - first.y;
        if dx * dx + dy * dy <= GEOMETRY_EPSILON_SQUARED {
            points.to_mut().pop();
        }
    }
    points
}

fn append_round_join(
    output: &mut Vec<u8>,
    space: ApplicationSpace,
    center: WgpuApplicationPoint,
    color: [f32; 4],
    edges: StrokeEdges,
) -> Result<(), &'static str> {
    let segments = 2 * LINE_CAP_SEGMENTS;
    let radius = edges.outset;
    for segment in 0..segments {
        let angle_a = std::f64::consts::TAU * segment as f64 / segments as f64;
        let angle_b = std::f64::consts::TAU * (segment + 1) as f64 / segments as f64;
        let centre = (center.x, center.y);
        let rim = |angle: f64| {
            (
                center.x + radius * angle.cos(),
                center.y + radius * angle.sin(),
            )
        };
        let (a, b) = (rim(angle_a), rim(angle_b));
        let middle = rim((angle_a + angle_b) / 2.0);
        append_stroke_vertex(output, space, centre, (centre, middle), color, edges.centre)?;
        append_stroke_vertex(output, space, a, (centre, a), color, edges.left)?;
        append_stroke_vertex(output, space, b, (centre, b), color, edges.left)?;
    }
    Ok(())
}

fn append_application_line(
    output: &mut Vec<u8>,
    space: ApplicationSpace,
    pixel_ratio: f64,
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

    // MapLibre's line strip (#326, #322) with the line's caps and joins: joins are filled without
    // overlap, so a translucent line blends once per pixel (#325).
    let edges = stroke_edges(line.stroke_width / 2.0, pixel_ratio);
    // Screen px at about the tile zoom: 16 MapLibre tile units each.
    let mut mesh = LineMesh::with_units(16.0, 1.0);
    let path: Vec<[f64; 2]> = points.iter().map(|point| [point.x, point.y]).collect();
    mesh.add_line(&path, &decode_line_layout(line.line_layout)?, false);
    for &index in &mesh.indices {
        let vertex = mesh.vertices[index as usize];
        let centre = (vertex.point[0], vertex.point[1]);
        let at = (
            centre.0 + vertex.extrude[0] * edges.outset,
            centre.1 + vertex.extrude[1] * edges.outset,
        );
        append_stroke_vertex(
            output,
            space,
            at,
            (centre, at),
            line.color,
            edges.with_normal(vertex.normal),
        )?;
    }
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

/// A stroke vertex at `at`, whose extrusion runs from the stroke centre `extrusion.0` to
/// `extrusion.1` (the vertex itself on the stroke boundary, a boundary point for a centre).
///
/// On the ground plane of a pitched camera the stroke fades over one screen pixel the way
/// MapLibre's line shader measures it (`v_gamma_scale`): the extrusion's clip-space length
/// over the extruded vertex's `w`. The vertex carries the reciprocal of that screen extent
/// as a negative edge extent, interpolated across the stroke like MapLibre's varying.
fn append_stroke_vertex(
    output: &mut Vec<u8>,
    space: ApplicationSpace,
    at: (f64, f64),
    (centre, extruded): ((f64, f64), (f64, f64)),
    color: [f32; 4],
    edge: [f32; 3],
) -> Result<(), &'static str> {
    let Some(ground) = space.ground else {
        return append_application_vertex(output, space, at.0, at.1, color, edge);
    };
    // Plain sqrt: WASM has no hypot/fma instruction, and libm's software ones dominated
    // pitched frames (#343). The operands are small, finite surface distances.
    let ground_outset = length(extruded.0 - centre.0, extruded.1 - centre.1);
    let [cx, cy, _] = ground.clip(centre.0, centre.1);
    let [ex, ey, ew] = ground.clip(extruded.0, extruded.1);
    let screen_outset = length(
        (ex - cx) / ew * space.width * 0.5,
        (ey - cy) / ew * space.height * 0.5,
    );
    // `edge[2]` is the outset in physical px on a flat map: scale it by the projection.
    let extent = f64::from(edge[2]) * screen_outset / ground_outset;
    if !(extent.is_finite() && extent > 0.0) {
        return Err("wgpu application stroke has no screen extent");
    }
    append_application_vertex(
        output,
        space,
        at.0,
        at.1,
        color,
        [edge[0], edge[1], (-1.0 / extent) as f32],
    )
}

/// One edge of MapLibre's `fill-antialias` outline (#331): a one-pixel `gl.LINES` segment in
/// the fill colour (`fill-outline-color` unset), drawn over the fill. Its fragment shader
/// (`fill_outline.fragment.glsl`) fades by the distance from the fragment centre to `v_pos`,
/// the endpoints' window positions interpolated along the line. That interpolation is
/// perspective-correct, so on a pitched camera `v_pos` drifts off the drawn line between
/// endpoints of different depth: long near edges fade out a pixel from their vertices,
/// while short far edges keep the outline beside their thin strokes.
///
/// Each GeoJSON tile draws the part of the edge inside it, with `v_pos` running between the
/// endpoints of the part its buffered tile holds ([`GeoJsonTileGrid`]). Within that part
/// `v_pos` is the window position interpolated linearly over the map plane, so a drawn piece
/// is a quad half a physical pixel to either side along its minor axis (the pixels a
/// one-pixel line produces, one per major-axis column) whose corners carry their own clip `w`
/// and that `v_pos`: the hardware then interpolates it exactly as the line would.
fn append_fill_outline_segment(
    output: &mut Vec<u8>,
    space: ApplicationSpace,
    pixel_ratio: f64,
    start: WgpuApplicationPoint,
    end: WgpuApplicationPoint,
    color: [f32; 4],
) -> Result<(), &'static str> {
    let (width, height) = (space.width * pixel_ratio, space.height * pixel_ratio);
    let at = |t: f64| WgpuApplicationPoint {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
    };
    // Window position (physical px, +y down) and clip `w` of the segment at `t`.
    let window = |t: f64| {
        let point = at(t);
        let [x, y, w] = clip_position(space, point.x, point.y);
        (w > 0.0).then(|| {
            (
                [(x / w + 1.0) * 0.5 * width, (1.0 - y / w) * 0.5 * height],
                w,
            )
        })
    };
    let (Some((a, _)), Some((b, _))) = (window(0.0), window(1.0)) else {
        return Ok(());
    };
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    if dx * dx + dy * dy <= GEOMETRY_EPSILON_SQUARED {
        return Ok(());
    }
    let minor = if dx.abs() >= dy.abs() {
        [0.0, 0.5]
    } else {
        [0.5, 0.0]
    };
    let pieces = match space.ground.and_then(|ground| ground.geojson_tiles) {
        Some(tiles) => tiles.pieces(start, end),
        None => vec![([0.0, 1.0], [0.0, 1.0])],
    };
    for (drawn, interpolated) in pieces {
        let (Some((from, _)), Some((to, _))) = (window(interpolated[0]), window(interpolated[1]))
        else {
            continue;
        };
        let span = interpolated[1] - interpolated[0];
        let v_pos = |t: f64| {
            let along = if span > 0.0 {
                (t - interpolated[0]) / span
            } else {
                0.0
            };
            [
                from[0] + (to[0] - from[0]) * along,
                from[1] + (to[1] - from[1]) * along,
            ]
        };
        let (Some(first), Some(last)) = (window(drawn[0]), window(drawn[1])) else {
            continue;
        };
        let ends = [(first, v_pos(drawn[0])), (last, v_pos(drawn[1]))];
        for (end_index, side) in [
            (0, -1.0),
            (0, 1.0),
            (1, 1.0),
            (0, -1.0),
            (1, 1.0),
            (1, -1.0),
        ] {
            let ((position, w), v_pos) = ends[end_index];
            let corner = [position[0] + minor[0] * side, position[1] + minor[1] * side];
            let clip = [
                ((corner[0] / width * 2.0 - 1.0) * w) as f32,
                ((1.0 - corner[1] / height * 2.0) * w) as f32,
                w as f32,
            ];
            let edge = [v_pos[0] as f32, v_pos[1] as f32, OUTLINE_EDGE];
            if clip.iter().chain(&edge).any(|value| !value.is_finite()) {
                return Err("wgpu application position is not representable as f32");
            }
            for value in clip.into_iter().chain(color).chain(edge) {
                output.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    Ok(())
}

/// Homogeneous clip position `(x, y, w)` of an application point.
fn clip_position(space: ApplicationSpace, x: f64, y: f64) -> [f64; 3] {
    match space.ground {
        Some(ground) => ground.clip(x, y),
        None => [
            x / space.width * 2.0 - 1.0,
            1.0 - y / space.height * 2.0,
            1.0,
        ],
    }
}

fn append_application_vertex(
    output: &mut Vec<u8>,
    space: ApplicationSpace,
    x: f64,
    y: f64,
    color: [f32; 4],
    edge: [f32; 3],
) -> Result<(), &'static str> {
    let clip = clip_position(space, x, y).map(|value| value as f32);
    if clip.iter().any(|value| !value.is_finite()) {
        return Err("wgpu application position is not representable as f32");
    }

    let values = [
        clip[0], clip[1], clip[2], color[0], color[1], color[2], color[3], edge[0], edge[1],
        edge[2],
    ];
    let mut bytes = [0_u8; 40];
    for (index, value) in values.into_iter().enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    output.extend_from_slice(&bytes);
    Ok(())
}

fn length(x: f64, y: f64) -> f64 {
    (x * x + y * y).sqrt()
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

    fn camera(pitch: f64) -> maps_core::MapCamera {
        maps_core::MapCamera::new(
            10.4,
            51.2,
            5.55,
            -20.0,
            pitch,
            maps_core::ViewportSize::new(720.0, 480.0).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn ground_perspective_is_the_pitched_camera_seen_from_its_flat_plane() {
        assert_eq!(
            GroundPerspective::new(
                camera(0.0)
                    .local_render_frame()
                    .unwrap()
                    .view_projection_elements(),
                720.0,
                480.0,
            ),
            None
        );

        let pitched = camera(50.0);
        let frame = pitched.local_render_frame().unwrap();
        let ground = GroundPerspective::new(frame.view_projection_elements(), 720.0, 480.0)
            .expect("pitched ground");
        let flat_camera = maps_core::MapCamera::new(
            10.4,
            51.2,
            5.55,
            0.0,
            0.0,
            maps_core::ViewportSize::new(720.0, 480.0).unwrap(),
        )
        .unwrap();
        for (longitude, latitude) in [(10.4, 51.2), (7.6, 52.0), (12.4, 49.2)] {
            let screen = frame.project(longitude, latitude).unwrap();
            let flat = flat_camera.project_screen(longitude, latitude).unwrap();
            let (x, y) = ground.flat(screen.x, screen.y).unwrap();
            // The flat plane is centred on the map center: CSS px east and south of it.
            assert!((x - (flat.x - 360.0)).abs() < 1.0e-3, "x {x} vs {}", flat.x);
            assert!((y - (flat.y - 240.0)).abs() < 1.0e-3, "y {y} vs {}", flat.y);
        }

        // Circles at the center keep their size; nearer ones (lower on screen) grow.
        let center = ground.depth_scale(360.0, 240.0).unwrap();
        assert!((center - 1.0).abs() < 1.0e-5, "center scale {center}");
        assert!(ground.depth_scale(360.0, 460.0).unwrap() > 1.1);
        assert!(ground.depth_scale(360.0, 20.0).unwrap() < 0.9);
    }

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
            line_layout: round_line_layout(),
        }
    }

    fn polygon() -> WgpuApplicationPolygon {
        WgpuApplicationPolygon {
            fill_color: [0.1, 0.4, 0.2, 0.8],
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

        let geometry = prepare_application_geometry(&frame, 1.0, None).unwrap();

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

    fn polygon_draw(polygon: WgpuApplicationPolygon) -> (ApplicationGeometry, PolygonDraw) {
        let frame = packed_frame(
            Vec::new(),
            Vec::new(),
            100.0,
            Vec::new(),
            vec![[APPLICATION_POLYGON, 0]],
            vec![polygon],
            100.0,
        );
        let geometry = prepare_application_geometry(&frame, 1.0, None).unwrap();
        let [ApplicationDraw::Polygon(draw)] = geometry.draws[..] else {
            panic!("expected one polygon draw, got {:?}", geometry.draws);
        };
        (geometry, draw)
    }

    fn vertex_count(geometry: &ApplicationGeometry) -> u32 {
        (geometry.triangle_vertices.len() as u64 / APPLICATION_VERTEX_SIZE) as u32
    }

    #[test]
    fn polygon_fill_fans_every_ring_then_covers_its_bounds() {
        let mut with_hole = polygon();
        with_hole.rings.push(vec![
            WgpuApplicationPoint { x: 15.0, y: 15.0 },
            WgpuApplicationPoint { x: 25.0, y: 15.0 },
            WgpuApplicationPoint { x: 25.0, y: 25.0 },
            WgpuApplicationPoint { x: 15.0, y: 25.0 },
            WgpuApplicationPoint { x: 15.0, y: 15.0 },
        ]);

        let (geometry, draw) = polygon_draw(with_hole);

        // One fan triangle per ring edge; the closing repeat adds no edge.
        assert_eq!((draw.fan_first, draw.fan_count), (0, 8 * 3));
        assert_eq!(draw.cover_first, draw.fan_count);
        // MapLibre's fill-antialias outline: one quad per ring edge, holes included (#331).
        assert_eq!(
            (draw.outline_first, draw.outline_count),
            (draw.cover_first + POLYGON_COVER_VERTEX_COUNT, 8 * 6)
        );
        assert_eq!(draw.stroke_first, draw.outline_first + draw.outline_count);
        // A rectangle and a round join per ring vertex.
        let per_vertex = 6 + 2 * LINE_CAP_SEGMENTS as u32 * 3;
        assert_eq!(draw.stroke_count, 8 * per_vertex);
        assert_eq!(
            vertex_count(&geometry),
            draw.stroke_first + draw.stroke_count
        );
    }

    /// Vertex `index` of the triangle buffer: clip (x, y, w), RGBA, edge.
    fn vertex(geometry: &ApplicationGeometry, index: u32) -> [f32; 10] {
        let start = index as usize * APPLICATION_VERTEX_SIZE as usize;
        let bytes = &geometry.triangle_vertices[start..start + APPLICATION_VERTEX_SIZE as usize];
        std::array::from_fn(|value| {
            f32::from_le_bytes(bytes[value * 4..value * 4 + 4].try_into().unwrap())
        })
    }

    #[test]
    fn fill_outline_is_a_one_pixel_quad_per_edge_carrying_its_endpoints_window_position() {
        let (geometry, draw) = polygon_draw(polygon());
        // The top edge (10, 10) -> (30, 10) is x-major: half a pixel above and below it.
        let corners: Vec<[f32; 10]> = (0..6)
            .map(|index| vertex(&geometry, draw.outline_first + index))
            .collect();
        let window = |clip: &[f32; 10]| ((clip[0] + 1.0) * 50.0, (1.0 - clip[1]) * 50.0);
        let expected = [
            ((10.0, 9.5), (10.0, 10.0)),
            ((10.0, 10.5), (10.0, 10.0)),
            ((30.0, 10.5), (30.0, 10.0)),
            ((10.0, 9.5), (10.0, 10.0)),
            ((30.0, 10.5), (30.0, 10.0)),
            ((30.0, 9.5), (30.0, 10.0)),
        ];
        for (corner, (position, v_pos)) in corners.iter().zip(expected) {
            let (x, y) = window(corner);
            assert!((x - position.0).abs() < 1.0e-4 && (y - position.1).abs() < 1.0e-4);
            assert_eq!((corner[7], corner[8]), v_pos);
            // The fill colour, as MapLibre's outline without `fill-outline-color`.
            assert_eq!(corner[3..7], [0.1, 0.4, 0.2, 0.8]);
        }
    }

    #[test]
    fn geojson_tiles_split_an_outline_edge_and_interpolate_over_their_buffered_part() {
        let tiles = GeoJsonTileGrid {
            origin: [0.0, 0.0],
            size: 100.0,
        };
        let point = |x: f64, y: f64| WgpuApplicationPoint { x, y };
        let pieces = tiles.pieces(point(50.0, 50.0), point(250.0, 50.0));
        let expected = [
            ([0.0, 0.25], [0.0, 0.375]),
            ([0.25, 0.75], [0.125, 0.875]),
            ([0.75, 1.0], [0.625, 1.0]),
        ];
        assert_eq!(pieces.len(), expected.len());
        for ((drawn, interpolated), (want_drawn, want_interpolated)) in pieces.iter().zip(expected)
        {
            for (value, want) in drawn
                .iter()
                .chain(interpolated)
                .zip(want_drawn.iter().chain(&want_interpolated))
            {
                assert!((value - want).abs() < 1.0e-12, "{pieces:?}");
            }
        }
        // geojson-vt rounds tile coordinates to its extent (Math.round: halves go up).
        let tiles = GeoJsonTileGrid {
            origin: [-3.0, 0.0],
            size: GEOJSON_TILE_EXTENT,
        };
        assert_eq!(tiles.snap(-1.5, 2.49), (-1.0, 2.0));
    }

    #[test]
    fn geojson_tile_grid_is_the_floored_zoom_quadtree_of_a_raster_placement() {
        // A zoom-6 raster tile seen at camera zoom 5.5: GeoJSON tiles are zoom 5.
        let size = 512.0 * 0.5_f64.sqrt();
        let grid = GeoJsonTileGrid::from_placement(&WgpuRasterTilePlacement {
            key: Some((6, 34, 21)),
            local_west: 10.0,
            local_north: 20.0,
            local_size: size,
            opacity: 1.0,
        })
        .unwrap();
        assert!((grid.size - size * 2.0).abs() < 1.0e-9);
        assert!((grid.origin[0] - (10.0 - 34.0 * size)).abs() < 1.0e-9);
        assert!((grid.origin[1] - (-20.0 - 21.0 * size)).abs() < 1.0e-9);
    }

    #[test]
    fn polygon_without_visible_fill_or_stroke_skips_those_passes() {
        let mut stroke_only = polygon();
        stroke_only.fill_color[3] = 0.0;
        let (_, draw) = polygon_draw(stroke_only);
        assert_eq!(draw.fan_count, 0);
        assert!(draw.stroke_count > 0);

        let mut fill_only = polygon();
        fill_only.stroke_width = 0.0;
        let (_, draw) = polygon_draw(fill_only);
        assert!(draw.fan_count > 0);
        assert_eq!(draw.stroke_count, 0);
    }

    #[test]
    fn zero_area_ring_keeps_its_canvas_stroke_without_failing_the_frame() {
        let mut collinear = polygon();
        collinear.rings = vec![vec![
            WgpuApplicationPoint { x: 10.0, y: 10.0 },
            WgpuApplicationPoint { x: 20.0, y: 10.0 },
            WgpuApplicationPoint { x: 10.0, y: 10.0 },
        ]];

        let (_, draw) = polygon_draw(collinear);

        assert_eq!(draw.fan_count, 0);
        assert!(draw.stroke_count > 0);
    }

    #[test]
    fn non_finite_polygon_fails_the_frame_closed() {
        let mut invalid = polygon();
        invalid.rings[0][1].x = f64::NAN;
        let frame = packed_frame(
            Vec::new(),
            Vec::new(),
            100.0,
            Vec::new(),
            vec![[APPLICATION_POLYGON, 0]],
            vec![invalid],
            100.0,
        );

        assert!(prepare_application_geometry(&frame, 1.0, None).is_err());
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

        let geometry = prepare_application_geometry(&frame, 1.0, None).unwrap();

        assert!(matches!(
            geometry.draws[..],
            [
                ApplicationDraw::Circles {
                    first_instance: 0,
                    instance_count: 1,
                },
                ApplicationDraw::Polygon(_),
                ApplicationDraw::Circles {
                    first_instance: 1,
                    instance_count: 1,
                },
            ]
        ));
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

        let geometry = prepare_application_geometry(&frame, 1.0, None).unwrap();
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

        let geometry = prepare_application_geometry(&frame, 1.0, None).unwrap();

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
        assert!(prepare_application_geometry(&frame, 1.0, None).is_err());
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
        packed.extend([
            12.0, 99.0, 50.0, 2.0, 0.25, -0.5, 2.0, 3.0, 1.0, 100.0, 200.0, 64.0, 0.5,
        ]);

        let (camera, clip, alignment, mut placements) = unpack_tile_draws(&packed).unwrap();
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
        assert_eq!(tile.opacity, 0.5);
        assert!(placements.next().is_none());
        let mut vertices = Vec::new();
        append_tile_vertices(&mut vertices, &tile, alignment).unwrap();
        let values: Vec<f32> = vertices
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();
        assert_eq!(
            values,
            [
                100.25, 199.5, 0.0, 0.0, 0.5, 100.25, 135.5, 0.0, 1.0, 0.5, 164.25, 199.5, 1.0,
                0.0, 0.5, 164.25, 135.5, 1.0, 1.0, 0.5
            ]
        );
        assert_eq!(camera_uniform_bytes(camera)[..4], [0, 0, 128, 63]);
        assert_eq!(camera_uniform_bytes(camera)[4..8], [0, 0, 0, 0]);
        assert_eq!(camera_uniform_bytes(camera)[60..], [0, 0, 128, 63]);
    }

    #[test]
    fn malformed_packed_draws_and_unrepresentable_tile_geometry_fail_closed() {
        assert!(unpack_tile_draws(&[]).is_err());
        assert!(unpack_tile_draws(&[0.0; 23]).is_err());
        for (margin, width, height, pixel_ratio) in [
            (-1.0, 0.0, 0.0, 1.0),
            (f64::NAN, 0.0, 0.0, 1.0),
            (0.0, 10.0, 0.0, 1.0),
            (0.0, f64::INFINITY, 10.0, 1.0),
            (0.0, 0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, f64::NAN),
        ] {
            let mut packed = [0.0; 22];
            packed[16..20].copy_from_slice(&[margin, width, height, pixel_ratio]);
            assert!(unpack_tile_draws(&packed).is_err());
        }
        for alignment in [f64::NAN, 2.0] {
            let mut packed = [0.0; 22];
            packed[19] = 1.0;
            packed[21] = alignment;
            assert!(unpack_tile_draws(&packed).is_err());
        }
        for (west, north, size) in [(0.0, 0.0, 0.0), (f64::NAN, 0.0, 1.0), (f64::MAX, 0.0, 1.0)] {
            let tile = WgpuRasterTilePlacement {
                key: Some((0, 0, 0)),
                local_west: west,
                local_north: north,
                local_size: size,
                opacity: 1.0,
            };
            assert!(append_tile_vertices(&mut Vec::new(), &tile, [0.0, 0.0]).is_err());
        }
    }
}
