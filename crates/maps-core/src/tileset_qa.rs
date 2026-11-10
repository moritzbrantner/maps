//! Tileset QA kernels (#276): what a decoded tile contains and which tiles a declared
//! coverage requires. Archive I/O, hashing and report assembly stay with the caller; the
//! MVT decoder and the coverage rule are the ones the Map View runtime uses.

use std::collections::{BTreeSet, HashSet};
use std::fmt;

use serde::Serialize;

use crate::tileset::tile_intersects_bounds;
use crate::{MvtGeometryType, TileId, VectorTileError, decode_mvt_layers};

/// Property keys reported per source layer; more are counted as truncated.
pub const TILESET_QA_MAX_PROPERTY_KEYS: usize = 64;

/// One source layer of a decoded tile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtLayerInspection {
    pub name: String,
    pub extent: u32,
    pub features: u32,
    pub points: u32,
    pub lines: u32,
    pub polygons: u32,
    /// Features that carry an MVT feature ID. Shortbread producers may omit them.
    pub features_with_id: u32,
    /// Features whose command stream decodes to no path.
    pub empty_geometries: u32,
    /// Sorted distinct property keys, at most [`TILESET_QA_MAX_PROPERTY_KEYS`].
    pub property_keys: Vec<String>,
    pub property_keys_truncated: bool,
}

/// What one MVT payload contains, in protobuf layer order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtTileInspection {
    pub layers: Vec<MvtLayerInspection>,
    pub features: u32,
    /// Layer names that occur more than once, which the MVT specification forbids.
    pub duplicate_layers: Vec<String>,
}

/// Decodes every layer of `bytes` with the runtime MVT decoder and summarizes it.
pub fn inspect_mvt_tile(bytes: &[u8]) -> Result<MvtTileInspection, VectorTileError> {
    let decoded = decode_mvt_layers(bytes, |_| true)?;
    let mut seen = BTreeSet::new();
    let mut duplicate_layers = BTreeSet::new();
    let mut total = 0_u32;
    let mut layers = Vec::with_capacity(decoded.len());
    for layer in decoded {
        if !seen.insert(layer.name.clone()) {
            duplicate_layers.insert(layer.name.clone());
        }
        let mut inspection = MvtLayerInspection {
            name: layer.name,
            extent: layer.extent,
            features: 0,
            points: 0,
            lines: 0,
            polygons: 0,
            features_with_id: 0,
            empty_geometries: 0,
            property_keys: Vec::new(),
            property_keys_truncated: false,
        };
        let mut keys = BTreeSet::new();
        for feature in layer.features {
            inspection.features += 1;
            match feature.geometry_type {
                MvtGeometryType::Point => inspection.points += 1,
                MvtGeometryType::LineString => inspection.lines += 1,
                MvtGeometryType::Polygon => inspection.polygons += 1,
            }
            if feature.id.is_some() {
                inspection.features_with_id += 1;
            }
            if feature.geometry.iter().all(Vec::is_empty) {
                inspection.empty_geometries += 1;
            }
            keys.extend(feature.properties.into_keys());
        }
        inspection.property_keys_truncated = keys.len() > TILESET_QA_MAX_PROPERTY_KEYS;
        inspection.property_keys = keys
            .into_iter()
            .take(TILESET_QA_MAX_PROPERTY_KEYS)
            .collect();
        total += inspection.features;
        layers.push(inspection);
    }
    Ok(MvtTileInspection {
        layers,
        features: total,
        duplicate_layers: duplicate_layers.into_iter().collect(),
    })
}

/// Coverage of one zoom level. `expected == covered + missing`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TilesetZoomCoverage {
    pub zoom: u8,
    /// Tiles the declared bounds require at this zoom.
    pub expected: u32,
    /// Required tiles the archive addresses.
    pub covered: u32,
    /// Required tiles the archive does not address.
    pub missing: u32,
    /// Addressed tiles at this zoom that lie outside the declared bounds.
    pub outside: u32,
}

/// Declared coverage compared with the tiles an archive addresses.
/// Tile lists are `[z, x, y]`, sorted, and hold at most the requested sample.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TilesetCoverageAudit {
    pub expected: u32,
    pub covered: u32,
    pub missing: u32,
    pub outside: u32,
    /// Addressed tiles below the declared minimum or above the declared maximum zoom.
    pub out_of_zoom_range: u32,
    /// Distinct addressed tiles supplied by the caller.
    pub addressed: u32,
    pub by_zoom: Vec<TilesetZoomCoverage>,
    pub missing_tiles: Vec<[u32; 3]>,
    pub outside_tiles: Vec<[u32; 3]>,
    pub out_of_zoom_range_tiles: Vec<[u32; 3]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TilesetCoverageError {
    InvalidBounds,
    InvalidZoomRange,
    InvalidTile,
    /// The declared coverage requires more tiles than the caller's budget allows.
    BudgetExceeded,
}

impl fmt::Display for TilesetCoverageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidBounds => "invalid coverage bounds",
            Self::InvalidZoomRange => "invalid zoom range",
            Self::InvalidTile => "addressed tile is outside its zoom pyramid",
            Self::BudgetExceeded => "declared coverage exceeds the expected-tile budget",
        })
    }
}

impl std::error::Error for TilesetCoverageError {}

/// Compares the tiles `bounds` and the zoom range require with the `addressed` tiles.
/// Enumerates at most `max_expected` candidate tiles, otherwise fails with
/// [`TilesetCoverageError::BudgetExceeded`] instead of reporting partial coverage.
pub fn audit_tileset_coverage(
    bounds: [f64; 4],
    min_zoom: u8,
    max_zoom: u8,
    addressed: &[TileId],
    sample_limit: usize,
    max_expected: u32,
) -> Result<TilesetCoverageAudit, TilesetCoverageError> {
    let [west, south, east, north] = bounds;
    if !bounds.iter().all(|value| value.is_finite())
        || !(-180.0..=180.0).contains(&west)
        || !(-180.0..=180.0).contains(&east)
        || west == east
        || south >= north
        || south < -85.0511287798066
        || north > 85.0511287798066
    {
        return Err(TilesetCoverageError::InvalidBounds);
    }
    if min_zoom > max_zoom || max_zoom > 31 {
        return Err(TilesetCoverageError::InvalidZoomRange);
    }
    let addressed: HashSet<TileId> = addressed.iter().copied().collect();
    if addressed
        .iter()
        .any(|tile| TileId::new(tile.z, tile.x, tile.y).is_none())
    {
        return Err(TilesetCoverageError::InvalidTile);
    }

    let mut audit = TilesetCoverageAudit {
        expected: 0,
        covered: 0,
        missing: 0,
        outside: 0,
        out_of_zoom_range: 0,
        addressed: u32::try_from(addressed.len())
            .map_err(|_| TilesetCoverageError::BudgetExceeded)?,
        by_zoom: Vec::new(),
        missing_tiles: Vec::new(),
        outside_tiles: Vec::new(),
        out_of_zoom_range_tiles: Vec::new(),
    };
    let mut candidates = 0_u64;
    for zoom in min_zoom..=max_zoom {
        let ranges = candidate_columns(bounds, zoom);
        let rows = candidate_rows(bounds, zoom);
        let row_count = u64::from(rows.1 - rows.0) + 1;
        candidates += ranges
            .iter()
            .map(|(first, last)| (u64::from(last - first) + 1) * row_count)
            .sum::<u64>();
        if candidates > u64::from(max_expected) {
            return Err(TilesetCoverageError::BudgetExceeded);
        }
        let mut level = TilesetZoomCoverage {
            zoom,
            expected: 0,
            covered: 0,
            missing: 0,
            outside: 0,
        };
        for (first, last) in ranges {
            for x in first..=last {
                for y in rows.0..=rows.1 {
                    let tile = TileId { z: zoom, x, y };
                    if !tile_intersects_bounds(bounds, tile) {
                        continue;
                    }
                    level.expected += 1;
                    if addressed.contains(&tile) {
                        level.covered += 1;
                    } else {
                        level.missing += 1;
                        if audit.missing_tiles.len() < sample_limit {
                            audit.missing_tiles.push([u32::from(zoom), x, y]);
                        }
                    }
                }
            }
        }
        audit.expected += level.expected;
        audit.covered += level.covered;
        audit.missing += level.missing;
        audit.by_zoom.push(level);
    }

    let mut outside = Vec::new();
    let mut out_of_range = Vec::new();
    for tile in addressed {
        if tile.z < min_zoom || tile.z > max_zoom {
            out_of_range.push(tile);
        } else if !tile_intersects_bounds(bounds, tile) {
            audit.by_zoom[usize::from(tile.z - min_zoom)].outside += 1;
            outside.push(tile);
        }
    }
    outside.sort_unstable();
    out_of_range.sort_unstable();
    audit.outside = outside.len() as u32;
    audit.out_of_zoom_range = out_of_range.len() as u32;
    let sample = |tiles: Vec<TileId>| {
        tiles
            .into_iter()
            .take(sample_limit)
            .map(|tile| [u32::from(tile.z), tile.x, tile.y])
            .collect()
    };
    audit.outside_tiles = sample(outside);
    audit.out_of_zoom_range_tiles = sample(out_of_range);
    Ok(audit)
}

/// Column ranges that can intersect the bounds, widened by one tile. The intersection
/// rule itself decides membership, so these only bound the enumeration.
fn candidate_columns(bounds: [f64; 4], zoom: u8) -> Vec<(u32, u32)> {
    let last = last_index(zoom);
    let column = |longitude: f64| {
        let scaled = (longitude + 180.0) / 360.0 * dimension(zoom);
        (scaled.floor().max(0.0) as u64).min(u64::from(last)) as u32
    };
    let west = column(bounds[0]).saturating_sub(1);
    let east = column(bounds[2]).saturating_add(1).min(last);
    if bounds[0] < bounds[2] {
        vec![(west, east)]
    } else if east >= west {
        vec![(0, last)]
    } else {
        vec![(0, east), (west, last)]
    }
}

fn candidate_rows(bounds: [f64; 4], zoom: u8) -> (u32, u32) {
    let last = last_index(zoom);
    let row = |latitude: f64| {
        let mercator = latitude.to_radians().tan().asinh();
        let scaled = (1.0 - mercator / std::f64::consts::PI) / 2.0 * dimension(zoom);
        (scaled.floor().max(0.0) as u64).min(u64::from(last)) as u32
    };
    (
        row(bounds[3]).saturating_sub(1),
        row(bounds[1]).saturating_add(1).min(last),
    )
}

fn dimension(zoom: u8) -> f64 {
    2_f64.powi(i32::from(zoom))
}

fn last_index(zoom: u8) -> u32 {
    ((1_u64 << zoom) - 1) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(z: u8, x: u32, y: u32) -> TileId {
        TileId::new(z, x, y).unwrap()
    }

    const WORLD: [f64; 4] = [-180.0, -85.0511287798066, 180.0, 85.0511287798066];

    #[test]
    fn world_coverage_requires_every_tile_and_lists_the_missing_ones() {
        let addressed = [tile(0, 0, 0), tile(1, 0, 1)];
        let audit = audit_tileset_coverage(WORLD, 0, 1, &addressed, 8, 1000).unwrap();
        assert_eq!(
            (audit.expected, audit.covered, audit.missing, audit.outside),
            (5, 2, 3, 0)
        );
        assert_eq!(audit.missing_tiles, [[1, 0, 0], [1, 1, 0], [1, 1, 1]]);
        assert_eq!(audit.by_zoom[1].expected, 4);
        assert_eq!(audit.by_zoom[1].missing, 3);
    }

    #[test]
    fn regional_bounds_require_exactly_the_tiles_they_touch() {
        // Computed independently: at zoom 10 the Liechtenstein box spans fractional
        // columns 538.94–539.42 and fractional rows 358.997 (47.28° N) to 360.0008
        // (47.04° N), so columns 538–539 and rows 358–360.
        let bounds = [9.47, 47.04, 9.64, 47.28];
        let addressed = [tile(10, 538, 358), tile(10, 539, 360), tile(10, 538, 361)];
        let audit = audit_tileset_coverage(bounds, 10, 10, &addressed, 8, 1000).unwrap();
        assert_eq!((audit.expected, audit.covered, audit.missing), (6, 2, 4));
        assert_eq!(
            audit.missing_tiles,
            [
                [10, 538, 359],
                [10, 538, 360],
                [10, 539, 358],
                [10, 539, 359]
            ]
        );
        assert_eq!(audit.outside_tiles, [[10, 538, 361]]);
    }

    #[test]
    fn antimeridian_bounds_wrap_instead_of_spanning_the_world() {
        // 170° E … 170° W at zoom 3 (45° columns): columns 7 and 0 only; rows 3 and 4
        // straddle the equator for ±10° latitude.
        let bounds = [170.0, -10.0, -170.0, 10.0];
        let addressed = [tile(3, 7, 3), tile(3, 0, 4), tile(3, 4, 3)];
        let audit = audit_tileset_coverage(bounds, 3, 3, &addressed, 8, 1000).unwrap();
        assert_eq!(audit.expected, 4);
        assert_eq!(audit.covered, 2);
        assert_eq!(audit.missing_tiles, [[3, 0, 3], [3, 7, 4]]);
        assert_eq!(audit.outside_tiles, [[3, 4, 3]]);
        assert_eq!(audit.by_zoom[0].outside, 1);
    }

    #[test]
    fn tiles_outside_the_declared_zoom_range_are_reported_separately() {
        let addressed = [tile(0, 0, 0), tile(2, 3, 3)];
        let audit = audit_tileset_coverage(WORLD, 0, 0, &addressed, 8, 1000).unwrap();
        assert_eq!(
            (audit.missing, audit.outside, audit.out_of_zoom_range),
            (0, 0, 1)
        );
        assert_eq!(audit.out_of_zoom_range_tiles, [[2, 3, 3]]);
        assert_eq!(audit.addressed, 2);
    }

    #[test]
    fn samples_are_bounded_while_counts_stay_exact() {
        let audit = audit_tileset_coverage(WORLD, 0, 3, &[], 2, 1000).unwrap();
        assert_eq!(audit.missing, 1 + 4 + 16 + 64);
        assert_eq!(audit.missing_tiles, [[0, 0, 0], [1, 0, 0]]);
    }

    #[test]
    fn coverage_beyond_the_budget_is_refused_not_truncated() {
        assert_eq!(
            audit_tileset_coverage(WORLD, 0, 6, &[], 2, 1000),
            Err(TilesetCoverageError::BudgetExceeded)
        );
        assert_eq!(
            audit_tileset_coverage([1.0, 0.0, 1.0, 2.0], 0, 0, &[], 2, 10),
            Err(TilesetCoverageError::InvalidBounds)
        );
        assert_eq!(
            audit_tileset_coverage(WORLD, 3, 2, &[], 2, 10),
            Err(TilesetCoverageError::InvalidZoomRange)
        );
        assert_eq!(
            audit_tileset_coverage(WORLD, 0, 0, &[TileId { z: 1, x: 2, y: 0 }], 2, 10),
            Err(TilesetCoverageError::InvalidTile)
        );
    }

    /// Minimal MVT writer for tests; independent of the decoder under test.
    fn varint(mut value: u64, out: &mut Vec<u8>) {
        while value >= 0x80 {
            out.push((value as u8) | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    }
    fn field(number: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        varint(number << 3 | 2, &mut out);
        varint(payload.len() as u64, &mut out);
        out.extend_from_slice(payload);
        out
    }
    fn scalar(number: u64, value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        varint(number << 3, &mut out);
        varint(value, &mut out);
        out
    }
    fn feature(id: Option<u64>, geometry_type: u64, commands: &[u32], tags: &[u32]) -> Vec<u8> {
        let packed = |values: &[u32]| {
            let mut out = Vec::new();
            for value in values {
                varint(u64::from(*value), &mut out);
            }
            out
        };
        let mut out = Vec::new();
        if let Some(id) = id {
            out.extend(scalar(1, id));
        }
        out.extend(field(2, &packed(tags)));
        out.extend(scalar(3, geometry_type));
        out.extend(field(4, &packed(commands)));
        out
    }
    fn layer(name: &str, features: &[Vec<u8>], keys: &[&str], values: &[&str]) -> Vec<u8> {
        let mut out = field(1, name.as_bytes());
        for feature in features {
            out.extend(field(2, feature));
        }
        for key in keys {
            out.extend(field(3, key.as_bytes()));
        }
        for value in values {
            out.extend(field(4, &field(1, value.as_bytes())));
        }
        out.extend(scalar(5, 4096));
        field(3, &out)
    }

    // MoveTo(1) 10,10 · LineTo(1) 20,0  →  command integers 9, zigzag(10)=20 …
    const LINE: [u32; 6] = [9, 20, 20, 10, 40, 0];
    const POINT: [u32; 3] = [9, 50, 34];

    #[test]
    fn inspection_counts_layers_geometry_types_ids_and_property_keys() {
        let mut bytes = layer(
            "streets",
            &[
                feature(Some(7), 2, &LINE, &[0, 0, 1, 1]),
                feature(None, 2, &LINE, &[0, 0]),
            ],
            &["kind", "name"],
            &["residential", "Fixture Road"],
        );
        bytes.extend(layer("sites", &[feature(None, 1, &POINT, &[])], &[], &[]));
        let tile = inspect_mvt_tile(&bytes).unwrap();
        assert_eq!(tile.features, 3);
        assert!(tile.duplicate_layers.is_empty());
        let streets = &tile.layers[0];
        assert_eq!(
            (streets.name.as_str(), streets.extent, streets.features),
            ("streets", 4096, 2)
        );
        assert_eq!((streets.lines, streets.points, streets.polygons), (2, 0, 0));
        assert_eq!(streets.features_with_id, 1);
        assert_eq!(streets.property_keys, ["kind", "name"]);
        assert_eq!(
            (tile.layers[1].points, tile.layers[1].features_with_id),
            (1, 0)
        );
    }

    #[test]
    fn inspection_reports_repeated_layers_and_an_empty_payload() {
        let mut bytes = layer("land", &[], &[], &[]);
        bytes.extend(layer("land", &[], &[], &[]));
        let tile = inspect_mvt_tile(&bytes).unwrap();
        assert_eq!(tile.duplicate_layers, ["land"]);
        assert_eq!(tile.features, 0);
        assert_eq!(inspect_mvt_tile(&[]).unwrap().layers.len(), 0);
    }

    #[test]
    fn inspection_rejects_payloads_the_runtime_decoder_rejects() {
        // A tag pair that indexes a key the layer does not define.
        let bytes = layer(
            "streets",
            &[feature(None, 2, &LINE, &[3, 0])],
            &["kind"],
            &["x"],
        );
        assert_eq!(
            inspect_mvt_tile(&bytes),
            Err(VectorTileError::InvalidProtobuf)
        );
        assert!(inspect_mvt_tile(&[0x1a, 0x7f, 0x00]).is_err());
    }
}
