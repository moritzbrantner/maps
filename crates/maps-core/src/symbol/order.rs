//! The order in which a symbol layer's symbols are placed and drawn (#346): MapLibre's
//! `symbol-sort-key` and `symbol-z-order`, ported from MapLibre GL JS 6.17
//! (`SymbolBucket.getSortedSymbolIndexes` / `sortFeatures`, `Placement.getBucketParts` /
//! `placeLayerBucketPart`, `LayerPlacement` and `drawLayerSymbols`).
//!
//! - Placement: with a data-driven sort key (and `symbol-z-order` not `viewport-y`) runs of
//!   equal keys from every tile are placed by ascending key, so a lower key wins collisions
//!   across tiles; with `symbol-z-order: viewport-y` each tile places its symbols from the
//!   bottom of the screen up; otherwise in layout order.
//! - Drawing: a layer whose symbols may overlap draws runs of equal keys by ascending key
//!   across tiles; without keys it draws each tile's symbols from the top of the screen down
//!   (`viewport-y`, the default `auto`), or in layout order (`source`).

use super::collision::PlacedSymbol;
use super::expression::js_round;
use super::layout::{EXTENT, SymbolBucket, SymbolInstance};

/// `getSortedSymbolIndexes(-bearing)`: instance indices from the top of the rotated screen to
/// the bottom, later features first among equal rows. `bearing` is MapLibre's
/// `bearingInRadians`.
#[must_use]
pub fn viewport_y_order(instances: &[SymbolInstance], bearing: f64) -> Vec<usize> {
    let (sin, cos) = (-bearing).sin_cos();
    let rotated: Vec<i64> = instances
        .iter()
        .map(|instance| {
            let [x, y] = [instance.anchor[0] * EXTENT, instance.anchor[1] * EXTENT];
            // `Math.round(...) | 0`.
            js_round(sin * x + cos * y) as i32 as i64
        })
        .collect();
    let mut order: Vec<usize> = (0..instances.len()).collect();
    order.sort_by(|&a, &b| {
        rotated[a]
            .cmp(&rotated[b])
            .then(instances[b].feature_index.cmp(&instances[a].feature_index))
    });
    order
}

/// Runs of equal `symbol-sort-key` in layout order (`bucket.sortKeyRanges`).
fn sort_key_runs(bucket: &SymbolBucket) -> Vec<(f64, std::ops::Range<usize>)> {
    let mut runs: Vec<(f64, std::ops::Range<usize>)> = Vec::new();
    for (index, instance) in bucket.instances.iter().enumerate() {
        let Some(key) = instance.sort_key else {
            continue;
        };
        match runs.last_mut() {
            Some((last, range)) if *last == key && range.end == index => range.end = index + 1,
            _ => runs.push((key, index..index + 1)),
        }
    }
    runs
}

/// One layer's placement order: `(tile, instance)` pairs, `tile` indexing `tiles`, which come
/// in MapLibre's placement tile order.
#[must_use]
pub fn placement_order(tiles: &[Option<&SymbolBucket>], bearing: f64) -> Vec<(usize, usize)> {
    let sort_across_tiles = tiles
        .iter()
        .flatten()
        .any(|bucket| bucket.sort_features_by_key);
    if sort_across_tiles {
        let mut parts: Vec<(f64, usize, std::ops::Range<usize>)> = Vec::new();
        for (tile, bucket) in tiles.iter().enumerate() {
            if let Some(bucket) = bucket {
                parts.extend(
                    sort_key_runs(bucket)
                        .into_iter()
                        .map(|(key, range)| (key, tile, range)),
                );
            }
        }
        // A stable sort, as JavaScript's `Array.prototype.sort`.
        parts.sort_by(|a, b| a.0.total_cmp(&b.0));
        return parts
            .into_iter()
            .flat_map(|(_, tile, range)| range.map(move |instance| (tile, instance)))
            .collect();
    }
    let mut order = Vec::new();
    for (tile, bucket) in tiles.iter().enumerate() {
        let Some(bucket) = bucket else {
            continue;
        };
        if bucket.z_order_viewport_y {
            order.extend(
                viewport_y_order(&bucket.instances, bearing)
                    .into_iter()
                    .rev()
                    .map(|instance| (tile, instance)),
            );
        } else {
            order.extend((0..bucket.instances.len()).map(|instance| (tile, instance)));
        }
    }
    order
}

/// One draw of a layer's symbols: MapLibre's `SymbolTileRenderState`, a tile's buffers or one
/// sort-key segment of them. Halos and their text pass per group.
#[derive(Clone, Debug, PartialEq)]
pub struct SymbolDrawGroup {
    /// The placement tile, as [`PlacedSymbol::tile`].
    pub tile: usize,
    pub symbols: Vec<PlacedSymbol>,
}

/// One layer's draws: `tiles` in MapLibre's symbol draw order with their bucket, `placed`
/// the layer's placed symbols, whose `tile` matches the first element of `tiles`.
#[must_use]
pub fn draw_groups(
    tiles: &[(usize, &SymbolBucket)],
    placed: &[PlacedSymbol],
    bearing: f64,
) -> Vec<SymbolDrawGroup> {
    let mut groups: Vec<(Option<f64>, SymbolDrawGroup)> = Vec::new();
    for &(tile, bucket) in tiles {
        // Where each instance sits in the tile's index buffer.
        let mut rank: Vec<usize> = (0..bucket.instances.len()).collect();
        if bucket.sort_features_by_y {
            for (position, instance) in viewport_y_order(&bucket.instances, bearing)
                .into_iter()
                .enumerate()
            {
                rank[instance] = position;
            }
        }
        let mut symbols: Vec<PlacedSymbol> = placed
            .iter()
            .filter(|symbol| symbol.tile == tile)
            .copied()
            .collect();
        if symbols.is_empty() {
            continue;
        }
        symbols.sort_by_key(|symbol| rank[symbol.instance]);
        // `prepareSegment(..., canOverlap ? sortKey : undefined)`: one segment per key run.
        if bucket.can_overlap && bucket.sort_features_by_key {
            for symbol in symbols {
                let key = bucket.instances[symbol.instance].sort_key;
                match groups.last_mut() {
                    Some((last, group)) if group.tile == tile && *last == key => {
                        group.symbols.push(symbol);
                    }
                    _ => groups.push((
                        key,
                        SymbolDrawGroup {
                            tile,
                            symbols: vec![symbol],
                        },
                    )),
                }
            }
        } else {
            groups.push((None, SymbolDrawGroup { tile, symbols }));
        }
    }
    // `tileRenderState.sort` by key, stable; groups without a key keep their tile order.
    if groups.iter().any(|(key, _)| key.is_some()) {
        groups.sort_by(|a, b| a.0.unwrap_or(0.0).total_cmp(&b.0.unwrap_or(0.0)));
    }
    groups.into_iter().map(|(_, group)| group).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(x: f64, y: f64, feature_index: usize, sort_key: Option<f64>) -> SymbolInstance {
        SymbolInstance {
            anchor: [x / EXTENT, y / EXTENT],
            line: None,
            text: None,
            icon: None,
            feature_index,
            sort_key,
        }
    }

    fn placed(tile: usize, instance: usize) -> PlacedSymbol {
        PlacedSymbol {
            tile,
            layer: 0,
            instance,
            perspective_ratio: 1.0,
            text: true,
            icon: false,
            variable_anchor: None,
        }
    }

    #[test]
    fn viewport_y_order_runs_top_down_in_the_turned_frame_later_features_first() {
        let instances = [
            instance(100.0, 300.0, 0, None),
            instance(500.0, 100.0, 1, None),
            instance(900.0, 300.0, 2, None),
        ];
        // North up: top to bottom, the later of two equal rows first.
        assert_eq!(viewport_y_order(&instances, 0.0), vec![1, 2, 0]);
        // Bearing 90°: the camera faces east, so the easternmost symbol is at the top.
        assert_eq!(
            viewport_y_order(&instances, std::f64::consts::FRAC_PI_2),
            vec![2, 1, 0]
        );
    }

    #[test]
    fn sort_keys_order_placement_across_tiles_and_keep_tile_order_among_equals() {
        let first = SymbolBucket {
            instances: vec![
                instance(0.0, 0.0, 0, Some(1.0)),
                instance(0.0, 0.0, 1, Some(3.0)),
            ],
            sort_features_by_key: true,
            ..SymbolBucket::default()
        };
        let second = SymbolBucket {
            instances: vec![
                instance(0.0, 0.0, 0, Some(0.0)),
                instance(0.0, 0.0, 1, Some(3.0)),
                instance(0.0, 0.0, 2, Some(3.0)),
            ],
            sort_features_by_key: true,
            ..SymbolBucket::default()
        };
        assert_eq!(
            placement_order(&[Some(&first), None, Some(&second)], 0.0),
            vec![(2, 0), (0, 0), (0, 1), (2, 1), (2, 2)]
        );
    }

    #[test]
    fn viewport_y_placement_starts_at_the_bottom_of_each_tile_and_source_keeps_layout_order() {
        let mut bucket = SymbolBucket {
            instances: vec![
                instance(0.0, 100.0, 0, None),
                instance(0.0, 900.0, 1, None),
                instance(0.0, 500.0, 2, None),
            ],
            ..SymbolBucket::default()
        };
        assert_eq!(
            placement_order(&[Some(&bucket)], 0.0),
            vec![(0, 0), (0, 1), (0, 2)]
        );
        bucket.z_order_viewport_y = true;
        assert_eq!(
            placement_order(&[Some(&bucket)], 0.0),
            vec![(0, 1), (0, 2), (0, 0)]
        );
    }

    #[test]
    fn overlapping_symbols_draw_by_key_across_tiles_or_top_down_without_keys() {
        let keyed = |keys: &[f64]| SymbolBucket {
            instances: keys
                .iter()
                .enumerate()
                .map(|(index, key)| instance(0.0, 0.0, index, Some(*key)))
                .collect(),
            sort_features_by_key: true,
            can_overlap: true,
            ..SymbolBucket::default()
        };
        let (a, b) = (keyed(&[1.0, 2.0]), keyed(&[0.0, 2.0]));
        // Tiles 7 and 4 of the placement, drawn in that order.
        let placed_symbols = [placed(4, 1), placed(7, 1), placed(4, 0), placed(7, 0)];
        let groups = draw_groups(&[(7, &a), (4, &b)], &placed_symbols, 0.0);
        let drawn: Vec<(usize, Vec<usize>)> = groups
            .iter()
            .map(|group| {
                (
                    group.tile,
                    group.symbols.iter().map(|symbol| symbol.instance).collect(),
                )
            })
            .collect();
        assert_eq!(
            drawn,
            vec![(4, vec![0]), (7, vec![0]), (7, vec![1]), (4, vec![1])]
        );

        // Without overlap the keys only order placement: layout order, one draw per tile.
        let mut quiet = keyed(&[2.0, 1.0]);
        quiet.can_overlap = false;
        let groups = draw_groups(&[(0, &quiet)], &[placed(0, 1), placed(0, 0)], 0.0);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].symbols[0].instance, 0);

        // Overlapping symbols without keys draw top-down (`auto`), unless `source`.
        let mut stacked = SymbolBucket {
            instances: vec![instance(0.0, 900.0, 0, None), instance(0.0, 100.0, 1, None)],
            can_overlap: true,
            sort_features_by_y: true,
            ..SymbolBucket::default()
        };
        let both = [placed(0, 0), placed(0, 1)];
        let order = |bucket: &SymbolBucket| -> Vec<usize> {
            draw_groups(&[(0, bucket)], &both, 0.0)[0]
                .symbols
                .iter()
                .map(|symbol| symbol.instance)
                .collect()
        };
        assert_eq!(order(&stacked), vec![1, 0]);
        stacked.sort_features_by_y = false;
        assert_eq!(order(&stacked), vec![0, 1]);
    }
}
