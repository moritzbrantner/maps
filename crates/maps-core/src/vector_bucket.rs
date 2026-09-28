//! Tile-local GPU buckets for the Shortbread vector basemap.
//!
//! A decoded tile is lowered once into renderer-neutral buckets whose coordinates are
//! normalized to the tile (`[0, 1]` inside the MVT extent, +x east, +y south; the MVT
//! buffer may extend slightly beyond). Fills are tessellated here, so renderers only
//! transform retained geometry by a per-tile matrix and never reproject or re-tessellate
//! it when the camera moves. Geographic truth stays in `f64` tile arithmetic; the `f32`
//! conversion happens only in this numerically safe tile-local frame.

use core::ops::Range;

use earcut::Earcut;

use crate::TileId;
use crate::vector_tile::{
    ShortbreadFeature, VectorBasemapLineKind, VectorBasemapPolygonKind, VectorTileError,
    split_at_tile_edges, visit_shortbread_features,
};

/// Style identity of a retained basemap primitive. Renderers resolve colors and widths
/// from a style table indexed by this value; the table is owned by the host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VectorBasemapStyleClass {
    Ocean = 0,
    Land = 1,
    LandForest = 2,
    Site = 3,
    Water = 4,
    WaterGlacier = 5,
    Building = 6,
    BuildingOutline = 7,
    Coast = 8,
    WaterLine = 9,
    Street = 10,
    Boundary = 11,
}

impl VectorBasemapStyleClass {
    /// Every class, in index order.
    pub const ALL: [Self; 12] = [
        Self::Ocean,
        Self::Land,
        Self::LandForest,
        Self::Site,
        Self::Water,
        Self::WaterGlacier,
        Self::Building,
        Self::BuildingOutline,
        Self::Coast,
        Self::WaterLine,
        Self::Street,
        Self::Boundary,
    ];
    pub const COUNT: usize = Self::ALL.len();

    /// Stable kebab-case name shared with hosts that build the style table.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Ocean => "ocean",
            Self::Land => "land",
            Self::LandForest => "land-forest",
            Self::Site => "site",
            Self::Water => "water",
            Self::WaterGlacier => "water-glacier",
            Self::Building => "building",
            Self::BuildingOutline => "building-outline",
            Self::Coast => "coast",
            Self::WaterLine => "water-line",
            Self::Street => "street",
            Self::Boundary => "boundary",
        }
    }

    fn fill(kind: VectorBasemapPolygonKind, source_kind: Option<&str>) -> Self {
        match (kind, source_kind) {
            (VectorBasemapPolygonKind::Ocean, _) => Self::Ocean,
            (VectorBasemapPolygonKind::Land, Some("forest")) => Self::LandForest,
            (VectorBasemapPolygonKind::Land, _) => Self::Land,
            (VectorBasemapPolygonKind::Site, _) => Self::Site,
            (VectorBasemapPolygonKind::Water, Some("glacier")) => Self::WaterGlacier,
            (VectorBasemapPolygonKind::Water, _) => Self::Water,
            (VectorBasemapPolygonKind::Building, _) => Self::Building,
        }
    }

    fn line(kind: VectorBasemapLineKind) -> Self {
        match kind {
            VectorBasemapLineKind::Coast => Self::Coast,
            VectorBasemapLineKind::Water => Self::WaterLine,
            VectorBasemapLineKind::Street => Self::Street,
            VectorBasemapLineKind::Boundary => Self::Boundary,
        }
    }
}

/// Fill paint groups in painter order: every tile's group `n` is drawn before any
/// tile's group `n + 1`, so style order spans tiles independent of protobuf order.
pub const VECTOR_FILL_PAINT_ORDER: [VectorBasemapPolygonKind; 5] = [
    VectorBasemapPolygonKind::Ocean,
    VectorBasemapPolygonKind::Land,
    VectorBasemapPolygonKind::Site,
    VectorBasemapPolygonKind::Water,
    VectorBasemapPolygonKind::Building,
];

/// Line paint groups: building outlines (drawn with their fills), then linework.
pub const VECTOR_LINE_GROUP_COUNT: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VectorFillVertex {
    pub position: [f32; 2],
    pub class: VectorBasemapStyleClass,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VectorLineSegment {
    pub start: [f32; 2],
    pub end: [f32; 2],
    pub class: VectorBasemapStyleClass,
}

/// Retained, tile-local geometry of one vector tile.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VectorTileBuckets {
    pub fill_vertices: Vec<VectorFillVertex>,
    /// Triangle list into `fill_vertices`.
    pub fill_indices: Vec<u32>,
    /// `fill_indices` range per [`VECTOR_FILL_PAINT_ORDER`] group.
    pub fill_groups: [Range<u32>; VECTOR_FILL_PAINT_ORDER.len()],
    pub line_segments: Vec<VectorLineSegment>,
    /// `line_segments` range per line group (building outlines, then linework).
    pub line_groups: [Range<u32>; VECTOR_LINE_GROUP_COUNT],
    /// Decoded Shortbread features represented by these buckets.
    pub feature_count: u32,
}

#[derive(Default)]
struct FillGroup {
    vertices: Vec<VectorFillVertex>,
    indices: Vec<u32>,
}

/// Decodes a Shortbread tile and lowers it into tile-local fill/line buckets.
///
/// Polygons keep their holes and multiple exteriors (tessellated with earcut). Linework
/// keeps protobuf order within the tile. Degenerate rings produce no triangles.
pub fn build_shortbread_buckets(bytes: &[u8]) -> Result<VectorTileBuckets, VectorTileError> {
    let mut fills: [FillGroup; VECTOR_FILL_PAINT_ORDER.len()] = Default::default();
    let mut outlines = Vec::new();
    let mut lines = Vec::new();
    let mut feature_count = 0_u32;
    let mut earcut = Earcut::new();
    let mut ring_points = Vec::new();
    let mut hole_starts = Vec::new();
    let mut triangles = Vec::new();

    visit_shortbread_features(bytes, |feature: ShortbreadFeature| {
        feature_count += 1;
        let scale = 1.0 / f64::from(feature.extent);
        let normalize =
            |[x, y]: [i32; 2]| [(f64::from(x) * scale) as f32, (f64::from(y) * scale) as f32];

        if let Some(kind) = feature.line_kind {
            let class = VectorBasemapStyleClass::line(kind);
            for path in &feature.line_paths {
                append_segments(&mut lines, path, class, normalize);
            }
        }

        if let Some(kind) = feature.polygon_kind {
            let class = VectorBasemapStyleClass::fill(kind, feature.source_kind.as_deref());
            let group_index = VECTOR_FILL_PAINT_ORDER
                .iter()
                .position(|candidate| *candidate == kind)
                .expect("every polygon kind has a paint group");
            let group = &mut fills[group_index];
            for rings in &feature.polygons {
                ring_points.clear();
                hole_starts.clear();
                for (ring_index, &path_index) in rings.iter().enumerate() {
                    let ring = open_ring(&feature.paths[path_index]);
                    if ring_index > 0 {
                        hole_starts.push(ring_points.len() as u32);
                    }
                    ring_points.extend(ring.iter().map(|[x, y]| [f64::from(*x), f64::from(*y)]));
                    if kind == VectorBasemapPolygonKind::Building {
                        for run in split_at_tile_edges(&feature.paths[path_index], feature.extent) {
                            append_segments(
                                &mut outlines,
                                &run,
                                VectorBasemapStyleClass::BuildingOutline,
                                normalize,
                            );
                        }
                    }
                }
                earcut.earcut(ring_points.iter().copied(), &hole_starts, &mut triangles);
                if triangles.is_empty() {
                    continue;
                }
                let base = group.vertices.len() as u32;
                group
                    .vertices
                    .extend(ring_points.iter().map(|[x, y]| VectorFillVertex {
                        position: [(x * scale) as f32, (y * scale) as f32],
                        class,
                    }));
                group
                    .indices
                    .extend(triangles.iter().map(|index: &u32| base + index));
            }
        }
        Ok(())
    })?;

    let mut buckets = VectorTileBuckets {
        feature_count,
        ..VectorTileBuckets::default()
    };
    for (group, range) in fills.into_iter().zip(buckets.fill_groups.iter_mut()) {
        let base = buckets.fill_vertices.len() as u32;
        let start = buckets.fill_indices.len() as u32;
        buckets.fill_vertices.extend(group.vertices);
        buckets
            .fill_indices
            .extend(group.indices.into_iter().map(|index| base + index));
        *range = start..buckets.fill_indices.len() as u32;
    }
    for (group, range) in [outlines, lines]
        .into_iter()
        .zip(buckets.line_groups.iter_mut())
    {
        let start = buckets.line_segments.len() as u32;
        buckets.line_segments.extend(group);
        *range = start..buckets.line_segments.len() as u32;
    }
    Ok(buckets)
}

/// A closed MVT ring without its repeated closing point (earcut input).
fn open_ring(path: &[[i32; 2]]) -> &[[i32; 2]] {
    match path {
        [first, .., last] if first == last => &path[..path.len() - 1],
        _ => path,
    }
}

fn append_segments(
    output: &mut Vec<VectorLineSegment>,
    path: &[[i32; 2]],
    class: VectorBasemapStyleClass,
    normalize: impl Fn([i32; 2]) -> [f32; 2],
) {
    for pair in path.windows(2) {
        if pair[0] != pair[1] {
            output.push(VectorLineSegment {
                start: normalize(pair[0]),
                end: normalize(pair[1]),
                class,
            });
        }
    }
}

/// Where one vector tile is drawn, in the same local map-plane frame as raster
/// placements (CSS px around the map center, +x east, +y north).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VectorTilePlacement {
    pub tile: TileId,
    pub local_west: f64,
    pub local_north: f64,
    pub local_size: f64,
}

/// Derives the vector tiles covering a set of raster placements.
///
/// Each raster placement `(tile, local_west, local_north, local_size)` maps to its
/// ancestor at `min(tile.z, max_zoom)`; the ancestor's local rectangle follows exactly
/// from the placement, so world copies stay distinct. Output is deduplicated and ordered
/// by tile identity, then west edge.
#[must_use]
pub fn vector_tile_placements(
    raster: impl IntoIterator<Item = (TileId, f64, f64, f64)>,
    max_zoom: u8,
) -> Vec<VectorTilePlacement> {
    let mut placements: Vec<VectorTilePlacement> = Vec::new();
    for (tile, west, north, size) in raster {
        if !(west.is_finite() && north.is_finite() && size.is_finite() && size > 0.0) {
            continue;
        }
        let depth = tile.z.saturating_sub(max_zoom);
        let Some(scale) = 1_u32.checked_shl(u32::from(depth)) else {
            continue;
        };
        let Some(ancestor) = TileId::new(tile.z - depth, tile.x / scale, tile.y / scale) else {
            continue;
        };
        let placement = VectorTilePlacement {
            tile: ancestor,
            local_west: west - f64::from(tile.x % scale) * size,
            local_north: north + f64::from(tile.y % scale) * size,
            local_size: size * f64::from(scale),
        };
        // Sibling placements of one ancestor agree up to rounding, world copies do not.
        let duplicate = placements.iter().any(|existing| {
            existing.tile == placement.tile
                && (existing.local_west - placement.local_west).abs() < placement.local_size * 0.5
        });
        if !duplicate {
            placements.push(placement);
        }
    }
    placements.sort_by(|left, right| {
        (left.tile.z, left.tile.x, left.tile.y)
            .cmp(&(right.tile.z, right.tile.x, right.tile.y))
            .then(left.local_west.total_cmp(&right.local_west))
    });
    placements
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }

    fn field_varint(field: u32, value: u64) -> Vec<u8> {
        let mut bytes = varint(u64::from(field << 3));
        bytes.extend(varint(value));
        bytes
    }

    fn field_bytes(field: u32, value: &[u8]) -> Vec<u8> {
        let mut bytes = varint(u64::from((field << 3) | 2));
        bytes.extend(varint(value.len() as u64));
        bytes.extend(value);
        bytes
    }

    fn zigzag(value: i32) -> u32 {
        ((value << 1) ^ (value >> 31)) as u32
    }

    fn polygon_commands(rings: &[&[[i32; 2]]]) -> Vec<u32> {
        let mut cursor = [0, 0];
        let mut commands = Vec::new();
        for ring in rings {
            for (index, point) in ring.iter().enumerate() {
                if index == 0 {
                    commands.push((1 << 3) | 1);
                } else if index == 1 {
                    commands.push(((ring.len() as u32 - 1) << 3) | 2);
                }
                commands.push(zigzag(point[0] - cursor[0]));
                commands.push(zigzag(point[1] - cursor[1]));
                cursor = *point;
            }
            commands.push((1 << 3) | 7);
        }
        commands
    }

    fn line_commands(points: &[[i32; 2]]) -> Vec<u32> {
        polygon_commands(&[points])[..points.len() * 2 + 2].to_vec()
    }

    /// One layer holding `features` as (geometry type, commands, optional kind tag).
    fn layer(name: &str, features: &[(u32, Vec<u32>, Option<&str>)]) -> Vec<u8> {
        let mut layer = field_bytes(1, name.as_bytes());
        let mut values = Vec::new();
        for (geometry_type, commands, kind) in features {
            let mut feature = Vec::new();
            if let Some(kind) = kind {
                let value_index = values.len() as u64;
                values.push(*kind);
                let tags = [varint(0), varint(value_index)].concat();
                feature.extend(field_bytes(2, &tags));
            }
            feature.extend(field_varint(3, u64::from(*geometry_type)));
            let packed = commands
                .iter()
                .flat_map(|value| varint(u64::from(*value)))
                .collect::<Vec<_>>();
            feature.extend(field_bytes(4, &packed));
            layer.extend(field_bytes(2, &feature));
        }
        if !values.is_empty() {
            layer.extend(field_bytes(3, b"kind"));
            for value in values {
                layer.extend(field_bytes(4, &field_bytes(1, value.as_bytes())));
            }
        }
        layer.extend(field_varint(5, 4096));
        layer.extend(field_varint(15, 2));
        field_bytes(3, &layer)
    }

    const SQUARE: &[[i32; 2]] = &[[0, 0], [4096, 0], [4096, 4096], [0, 4096]];
    const HOLE: &[[i32; 2]] = &[[1024, 1024], [1024, 3072], [3072, 3072], [3072, 1024]];

    fn triangle_area(buckets: &VectorTileBuckets, range: Range<u32>) -> f64 {
        buckets.fill_indices[range.start as usize..range.end as usize]
            .as_chunks::<3>()
            .0
            .iter()
            .map(|triangle| {
                let [a, b, c] = [0, 1, 2].map(|corner| {
                    let [x, y] = buckets.fill_vertices[triangle[corner] as usize].position;
                    [f64::from(x), f64::from(y)]
                });
                ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0
            })
            .sum()
    }

    #[test]
    fn tessellated_water_keeps_its_island_hole() {
        let bytes = layer(
            "water_polygons",
            &[(3, polygon_commands(&[SQUARE, HOLE]), None)],
        );
        let buckets = build_shortbread_buckets(&bytes).unwrap();

        let water = buckets.fill_groups[3].clone();
        assert!(!water.is_empty());
        // Exterior 1.0 minus the 0.5 x 0.5 island.
        assert!((triangle_area(&buckets, water) - 0.75).abs() < 1e-6);
        assert!(
            buckets
                .fill_vertices
                .iter()
                .all(|vertex| vertex.class == VectorBasemapStyleClass::Water)
        );
        // The island ring is shore linework; the exterior is the tile clip edge.
        assert_eq!(buckets.line_groups[1].len(), 4);
        assert_eq!(buckets.feature_count, 1);
    }

    #[test]
    fn fills_are_grouped_in_paint_order_regardless_of_protobuf_order() {
        let small: &[[i32; 2]] = &[[0, 0], [1024, 0], [1024, 1024], [0, 1024]];
        let bytes = [
            layer("buildings", &[(3, polygon_commands(&[small]), None)]),
            layer("land", &[(3, polygon_commands(&[SQUARE]), Some("forest"))]),
            layer("ocean", &[(3, polygon_commands(&[SQUARE]), None)]),
        ]
        .concat();
        let buckets = build_shortbread_buckets(&bytes).unwrap();

        let classes = buckets
            .fill_groups
            .iter()
            .map(|range| {
                (!range.is_empty()).then(|| {
                    buckets.fill_vertices[buckets.fill_indices[range.start as usize] as usize].class
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            classes,
            [
                Some(VectorBasemapStyleClass::Ocean),
                Some(VectorBasemapStyleClass::LandForest),
                None,
                None,
                Some(VectorBasemapStyleClass::Building),
            ]
        );
        assert!((triangle_area(&buckets, buckets.fill_groups[4].clone()) - 0.0625).abs() < 1e-6);
        // Building outlines skip the two sides on the tile edge; the full-tile ocean
        // has no shore at all.
        assert_eq!(buckets.line_groups[0].len(), 2);
        assert!(
            buckets.line_segments[buckets.line_groups[1].start as usize..]
                .iter()
                .all(|segment| segment.class == VectorBasemapStyleClass::Coast)
        );
    }

    #[test]
    fn multiple_exteriors_each_tessellate_with_their_own_holes() {
        let second: &[[i32; 2]] = &[[5000, 0], [6000, 0], [6000, 1000], [5000, 1000]];
        let bytes = layer(
            "land",
            &[(3, polygon_commands(&[SQUARE, HOLE, second]), None)],
        );
        let buckets = build_shortbread_buckets(&bytes).unwrap();
        let area = triangle_area(&buckets, buckets.fill_groups[1].clone());
        let second_area = (1000.0 / 4096.0_f64).powi(2);
        assert!((area - (0.75 + second_area)).abs() < 1e-6, "area {area}");
    }

    #[test]
    fn degenerate_rings_and_repeated_points_produce_no_geometry() {
        // A collinear exterior has zero signed area and is rejected by the decoder, so
        // exercise a sliver with repeated points and a zero-length street instead.
        let sliver: &[[i32; 2]] = &[[0, 0], [4096, 0], [4096, 1], [4096, 1]];
        let bytes = [
            layer("sites", &[(3, polygon_commands(&[sliver]), None)]),
            layer(
                "streets",
                &[(2, line_commands(&[[10, 10], [10, 10]]), None)],
            ),
        ]
        .concat();
        let buckets = build_shortbread_buckets(&bytes).unwrap();
        assert!(triangle_area(&buckets, buckets.fill_groups[2].clone()) < 1e-3);
        assert!(buckets.line_segments.is_empty());
        assert_eq!(buckets.feature_count, 2);
    }

    #[test]
    fn linework_is_tile_normalized_and_keeps_protobuf_order() {
        let bytes = [
            layer(
                "streets",
                &[(2, line_commands(&[[0, 0], [4096, 2048]]), None)],
            ),
            layer(
                "boundaries",
                &[(2, line_commands(&[[0, 4096], [2048, 4096]]), None)],
            ),
        ]
        .concat();
        let buckets = build_shortbread_buckets(&bytes).unwrap();
        assert_eq!(
            buckets.line_segments,
            [
                VectorLineSegment {
                    start: [0.0, 0.0],
                    end: [1.0, 0.5],
                    class: VectorBasemapStyleClass::Street,
                },
                VectorLineSegment {
                    start: [0.0, 1.0],
                    end: [0.5, 1.0],
                    class: VectorBasemapStyleClass::Boundary,
                },
            ]
        );
        assert_eq!(buckets.line_groups, [0..0, 0..2]);
    }

    #[test]
    fn malformed_tiles_are_rejected_like_the_geographic_decoder() {
        let bytes = layer("land", &[(3, polygon_commands(&[HOLE]), None)]);
        assert_eq!(
            build_shortbread_buckets(&bytes),
            Err(VectorTileError::InvalidGeometry)
        );
    }

    #[test]
    fn placements_derive_ancestor_rectangles_and_keep_world_copies() {
        let tile = |z, x, y| TileId::new(z, x, y).unwrap();
        // Four z16 children of one z14 tile would be 4 x 4; take two of them plus the
        // same child in the next world copy (west shifted by one world width).
        let size = 100.0;
        let world = size * 65536.0;
        let placements = vector_tile_placements(
            [
                (tile(16, 8801, 5378), 0.0, 0.0, size),
                (tile(16, 8802, 5378), 100.0, 0.0, size),
                (tile(16, 8801, 5378), world, 0.0, size),
            ],
            14,
        );
        assert_eq!(
            placements,
            [
                VectorTilePlacement {
                    tile: tile(14, 2200, 1344),
                    local_west: -100.0,
                    local_north: 200.0,
                    local_size: 400.0,
                },
                VectorTilePlacement {
                    tile: tile(14, 2200, 1344),
                    local_west: world - 100.0,
                    local_north: 200.0,
                    local_size: 400.0,
                },
            ]
        );
    }

    #[test]
    fn placements_below_the_source_max_zoom_are_used_directly() {
        let tile = TileId::new(5, 17, 10).unwrap();
        let placements = vector_tile_placements([(tile, -12.5, 40.0, 256.0)], 14);
        assert_eq!(
            placements,
            [VectorTilePlacement {
                tile,
                local_west: -12.5,
                local_north: 40.0,
                local_size: 256.0,
            }]
        );
    }
}
