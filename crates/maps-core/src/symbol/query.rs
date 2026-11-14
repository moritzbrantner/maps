//! `queryRenderedFeatures` for tileset `circle` and `symbol` style layers (#346), ported from
//! MapLibre GL JS 6.15 `query_features.ts`: symbols are hit where the last placement put their
//! collision boxes and circles (`CollisionIndex.queryRenderedSymbols`), circles where they were
//! drawn (`CircleStyleLayer.queryIntersectsFeature`). Results run from the top style layer down;
//! within a layer, tiles by zoom, then y, then x, and later features of a tile first.
//! Renderers draw the frame; they do not decide what a pointer hits.

use std::collections::{BTreeSet, HashMap};

use serde_json::{Map, Value};

use super::collision::{PlacedSymbol, PlacementTile, SymbolCollision, VIEWPORT_PADDING};
use super::layout::{LayerBucket, SymbolBucket};
use super::order::viewport_y_order;
use super::style::{StyleLayer, StyleLayerKind};
use crate::TileId;
use crate::mvt_features::MvtFeature;

#[derive(Clone, Copy, Debug, PartialEq)]
enum QueryShape {
    /// A placed symbol's collision box, in grid px.
    Box([f64; 4]),
    /// A placed line label's collision circle (x, y, radius), in grid px.
    CollisionCircle([f64; 3]),
    /// A drawn circle: center in viewport px and its drawn radius plus stroke.
    Circle { center: [f64; 2], radius: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct QueryEntry {
    layer: usize,
    /// The tile's position in the frame's placement list.
    tile_index: usize,
    tile: TileId,
    feature_index: usize,
    /// Where the feature draws in its tile: hits run later ranks first.
    rank: usize,
    shape: QueryShape,
}

/// One feature of a style layer under a query point.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RenderedFeatureHit {
    /// The style layer's index.
    pub layer: usize,
    pub tile: TileId,
    /// The feature's index in its tile's source layer.
    pub feature_index: usize,
}

/// What one frame drew of its circle and symbol layers, retained for queries until the next
/// frame (MapLibre's `retainedQueryData` and collision index).
#[derive(Clone, Debug, Default)]
pub struct RenderedFeatureIndex {
    entries: Vec<QueryEntry>,
}

impl RenderedFeatureIndex {
    /// Indexes the circles drawn and the symbols `placed` with their `collisions` (per layer, as
    /// `place_symbols_with_collisions` returns them) over `tiles` at the camera `zoom`. Hidden layers and layers outside their
    /// zoom range draw nothing and are not indexed.
    #[must_use]
    pub fn new(
        tiles: &[PlacementTile<'_>],
        placed: &[Vec<PlacedSymbol>],
        collisions: &[Vec<SymbolCollision>],
        layers: &[StyleLayer],
        zoom: f64,
        bearing: f64,
    ) -> Self {
        let mut entries = Vec::new();
        for (layer_index, layer) in layers.iter().enumerate() {
            if !layer.visible || zoom < layer.min_zoom || zoom >= layer.max_zoom {
                continue;
            }
            match layer.kind {
                StyleLayerKind::Circle => {
                    for (tile_index, tile) in tiles.iter().enumerate() {
                        let Some(LayerBucket::Circles(circles)) =
                            tile.buckets.layers.get(layer_index)
                        else {
                            continue;
                        };
                        for circle in circles {
                            let Some((center, ratio)) = tile.projection.anchor(circle.anchor)
                            else {
                                continue;
                            };
                            // `circle-pitch-scale: map` under `circle-pitch-alignment:
                            // viewport`: the drawn size shrinks with the depth, as `w` grows.
                            let outer = f64::from(circle.radius + circle.stroke_width);
                            if outer <= 0.0 {
                                continue;
                            }
                            entries.push(QueryEntry {
                                layer: layer_index,
                                tile_index,
                                tile: tile.tile,
                                feature_index: circle.feature_index,
                                rank: circle.feature_index,
                                shape: QueryShape::Circle {
                                    center,
                                    radius: outer * (2.0 * ratio - 1.0),
                                },
                            });
                        }
                    }
                }
                StyleLayerKind::Symbol => {
                    let (Some(symbols), Some(collisions)) =
                        (placed.get(layer_index), collisions.get(layer_index))
                    else {
                        continue;
                    };
                    let mut ranks: HashMap<usize, Box<dyn Fn(usize) -> usize>> = HashMap::new();
                    for (symbol, collision) in symbols.iter().zip(collisions) {
                        let Some(tile) = tiles.get(symbol.tile) else {
                            continue;
                        };
                        let Some(LayerBucket::Symbols(bucket)) =
                            tile.buckets.layers.get(layer_index)
                        else {
                            continue;
                        };
                        let Some(instance) = bucket.instances.get(symbol.instance) else {
                            continue;
                        };
                        let rank = ranks
                            .entry(symbol.tile)
                            .or_insert_with(|| symbol_hit_ranks(bucket, bearing))(
                            instance.feature_index,
                        );
                        let shapes = collision
                            .text_box
                            .into_iter()
                            .chain(collision.icon_box)
                            .map(QueryShape::Box)
                            .chain(
                                collision
                                    .text_circles
                                    .iter()
                                    .map(|circle| QueryShape::CollisionCircle(*circle)),
                            );
                        for shape in shapes {
                            entries.push(QueryEntry {
                                layer: layer_index,
                                tile_index: symbol.tile,
                                tile: tile.tile,
                                feature_index: instance.feature_index,
                                rank,
                                shape,
                            });
                        }
                    }
                }
                StyleLayerKind::Fill | StyleLayerKind::Line => {}
            }
        }
        Self { entries }
    }

    /// The features of `layers` (style layer indices) under a viewport point in CSS px, each
    /// once per tile: the top layer first; within a layer, tiles by zoom, y and x ascending
    /// (`sortTilesIn`), and within a tile the later feature first (`topDownFeatureComparator`).
    #[must_use]
    pub fn query_point(&self, point: [f64; 2], layers: &[usize]) -> Vec<RenderedFeatureHit> {
        let wanted: BTreeSet<usize> = layers.iter().copied().collect();
        let mut hits: Vec<&QueryEntry> = self
            .entries
            .iter()
            .filter(|entry| wanted.contains(&entry.layer) && entry.shape.contains(point))
            .collect();
        hits.sort_by(|a, b| {
            b.layer
                .cmp(&a.layer)
                .then(a.tile.z.cmp(&b.tile.z))
                .then(a.tile.y.cmp(&b.tile.y))
                .then(a.tile_index.cmp(&b.tile_index))
                .then(a.tile.x.cmp(&b.tile.x))
                .then(b.rank.cmp(&a.rank))
                .then(b.feature_index.cmp(&a.feature_index))
        });
        hits.dedup_by_key(|entry| (entry.layer, entry.tile_index, entry.feature_index));
        hits.into_iter()
            .map(|entry| RenderedFeatureHit {
                layer: entry.layer,
                tile: entry.tile,
                feature_index: entry.feature_index,
            })
            .collect()
    }
}

/// Where each feature of a symbol bucket draws, for its hit order: a bucket sorted by viewport y
/// ranks a feature by its first anchor in `featureSortOrder` (`viewport_y_order`), others by
/// feature index (`queryRenderedSymbols`).
fn symbol_hit_ranks(bucket: &SymbolBucket, bearing: f64) -> Box<dyn Fn(usize) -> usize> {
    if !bucket.sort_features_by_y {
        return Box::new(|feature| feature);
    }
    let mut ranks = HashMap::new();
    for (position, instance) in viewport_y_order(&bucket.instances, bearing)
        .into_iter()
        .enumerate()
    {
        ranks
            .entry(bucket.instances[instance].feature_index)
            .or_insert(position);
    }
    Box::new(move |feature| ranks.get(&feature).copied().unwrap_or(usize::MAX))
}

impl QueryShape {
    fn contains(&self, point: [f64; 2]) -> bool {
        match *self {
            // `queryRenderedSymbols`: the grid's box, then `polygonIntersectsPolygon` with
            // the query point, whose ray casting includes the top and left edges only.
            Self::Box(b) => {
                let (x, y) = (point[0] + VIEWPORT_PADDING, point[1] + VIEWPORT_PADDING);
                b[0] <= x && x < b[2] && b[1] <= y && y < b[3]
            }
            // The grid tests the circle, the query then the circle's bounding box.
            Self::CollisionCircle([cx, cy, radius]) => {
                let (x, y) = (point[0] + VIEWPORT_PADDING, point[1] + VIEWPORT_PADDING);
                let (dx, dy) = (x - cx, y - cy);
                dx * dx + dy * dy <= radius * radius
                    && cx - radius <= x
                    && x < cx + radius
                    && cy - radius <= y
                    && y < cy + radius
            }
            // `polygonIntersectsBufferedPoint` for a one-point query: strictly inside.
            Self::Circle { center, radius } => {
                let (dx, dy) = (point[0] - center[0], point[1] - center[1]);
                dx * dx + dy * dy < radius * radius
            }
        }
    }
}

/// The style layer indices of `ids`. Only `circle` and `symbol` layers can be queried; other
/// kinds and unknown ids are errors, not silently empty results.
pub fn query_layer_indices<S: AsRef<str>>(
    layers: &[StyleLayer],
    ids: &[S],
) -> Result<Vec<usize>, String> {
    ids.iter()
        .map(|id| {
            let id = id.as_ref();
            let index = layers
                .iter()
                .position(|layer| layer.id == id)
                .ok_or_else(|| format!("no tileset style layer \"{id}\" to query"))?;
            match layers[index].kind {
                StyleLayerKind::Circle | StyleLayerKind::Symbol => Ok(index),
                StyleLayerKind::Fill | StyleLayerKind::Line => Err(format!(
                    "tileset style layer \"{id}\" is a {} layer; only circle and symbol layers are queryable",
                    match layers[index].kind {
                        StyleLayerKind::Fill => "fill",
                        _ => "line",
                    }
                )),
            }
        })
        .collect()
}

/// A hit as MapLibre's `GeoJSONFeature` reports it, without geometry: `type`, `id` (the MVT
/// feature id, when it has one), `properties`, `layer` (`id` and `type`) and `sourceLayer`.
#[must_use]
pub fn rendered_feature(layer: &StyleLayer, feature: &MvtFeature) -> Value {
    let mut out = Map::new();
    out.insert("type".to_owned(), Value::from("Feature"));
    if let Some(id) = feature.id {
        out.insert("id".to_owned(), Value::from(id));
    }
    out.insert(
        "properties".to_owned(),
        Value::Object(feature.properties.clone().into_iter().collect()),
    );
    let mut style_layer = Map::new();
    style_layer.insert("id".to_owned(), Value::from(layer.id.as_str()));
    style_layer.insert(
        "type".to_owned(),
        Value::from(match layer.kind {
            StyleLayerKind::Circle => "circle",
            StyleLayerKind::Symbol => "symbol",
            StyleLayerKind::Fill => "fill",
            StyleLayerKind::Line => "line",
        }),
    );
    out.insert("layer".to_owned(), Value::Object(style_layer));
    out.insert(
        "sourceLayer".to_owned(),
        Value::from(layer.source_layer.as_str()),
    );
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mvt_features::MvtGeometryType;

    fn tile(z: u8, x: u32, y: u32) -> TileId {
        TileId::new(z, x, y).unwrap()
    }

    fn entry(
        layer: usize,
        tile_index: usize,
        tile: TileId,
        feature_index: usize,
        shape: QueryShape,
    ) -> QueryEntry {
        QueryEntry {
            layer,
            tile_index,
            tile,
            feature_index,
            rank: feature_index,
            shape,
        }
    }

    #[test]
    fn symbol_boxes_include_their_top_left_edges_only() {
        let p = VIEWPORT_PADDING;
        let index = RenderedFeatureIndex {
            entries: vec![entry(
                0,
                0,
                tile(1, 0, 0),
                3,
                QueryShape::Box([p + 10.0, p + 20.0, p + 30.0, p + 40.0]),
            )],
        };
        let hit = |x: f64, y: f64| !index.query_point([x, y], &[0]).is_empty();
        assert!(hit(10.0, 20.0));
        assert!(hit(29.9, 39.9));
        assert!(!hit(30.0, 30.0));
        assert!(!hit(20.0, 40.0));
        assert!(!hit(9.9, 30.0));
        // Only queried layers are hit.
        assert!(index.query_point([20.0, 30.0], &[1]).is_empty());
    }

    #[test]
    fn circles_are_hit_strictly_inside_their_drawn_radius_and_line_label_circles_inclusively() {
        let p = VIEWPORT_PADDING;
        let index = RenderedFeatureIndex {
            entries: vec![
                entry(
                    0,
                    0,
                    tile(1, 0, 0),
                    0,
                    QueryShape::Circle {
                        center: [50.0, 50.0],
                        radius: 5.0,
                    },
                ),
                entry(
                    1,
                    0,
                    tile(1, 0, 0),
                    0,
                    QueryShape::CollisionCircle([p + 150.0, p + 50.0, 5.0]),
                ),
            ],
        };
        let hits = |x: f64, y: f64| index.query_point([x, y], &[0, 1]).len();
        assert_eq!(hits(54.9, 50.0), 1);
        assert_eq!(hits(55.0, 50.0), 0);
        assert_eq!(hits(53.0, 53.0), 1);
        assert_eq!(hits(54.0, 54.0), 0);
        // On the circle: in it, but on the right edge of its box.
        assert_eq!(hits(145.0, 50.0), 1);
        assert_eq!(hits(155.0, 50.0), 0);
    }

    #[test]
    fn hits_run_from_the_top_layer_down_tiles_ascending_and_later_features_first_once_each() {
        let whole = QueryShape::Circle {
            center: [0.0, 0.0],
            radius: 100.0,
        };
        let p = VIEWPORT_PADDING;
        let label = QueryShape::Box([p - 10.0, p - 10.0, p + 10.0, p + 10.0]);
        let (a, b, c) = (tile(2, 1, 1), tile(2, 0, 2), tile(2, 2, 1));
        let index = RenderedFeatureIndex {
            entries: vec![
                entry(0, 0, a, 1, whole),
                entry(0, 0, a, 4, whole),
                entry(0, 1, b, 0, whole),
                entry(0, 2, c, 7, whole),
                // A multi-point feature: one hit.
                entry(0, 2, c, 2, whole),
                entry(0, 2, c, 2, whole),
                // Text and icon boxes of one symbol: one hit.
                entry(2, 1, b, 5, label),
                entry(2, 1, b, 5, label),
            ],
        };
        let hits: Vec<(usize, TileId, usize)> = index
            .query_point([0.0, 0.0], &[0, 2])
            .into_iter()
            .map(|hit| (hit.layer, hit.tile, hit.feature_index))
            .collect();
        assert_eq!(
            hits,
            vec![
                (2, b, 5),
                (0, a, 4),
                (0, a, 1),
                (0, c, 7),
                (0, c, 2),
                (0, b, 0)
            ]
        );
    }

    #[test]
    fn viewport_y_sorted_symbols_are_hit_in_their_drawn_order_and_others_by_feature() {
        use crate::symbol::layout::{SymbolBucket, SymbolInstance};
        let instance = |y: f64, feature_index: usize| SymbolInstance {
            anchor: [0.5, y],
            line: None,
            text: None,
            icon: None,
            feature_index,
            sort_key: None,
        };
        // Feature 0 lowest on screen, feature 2 highest; feature 1 has two anchors.
        let instances = vec![
            instance(0.9, 0),
            instance(0.5, 1),
            instance(0.1, 2),
            instance(0.95, 1),
        ];
        let by_y = SymbolBucket {
            instances: instances.clone(),
            sort_features_by_y: true,
            ..SymbolBucket::default()
        };
        // `featureSortOrder`: top of the screen first; a feature ranks by its first anchor.
        let ranks = symbol_hit_ranks(&by_y, 0.0);
        assert!(
            ranks(2) < ranks(1) && ranks(1) < ranks(0),
            "{:?}",
            [ranks(0), ranks(1), ranks(2)]
        );
        let unsorted = SymbolBucket {
            instances,
            ..SymbolBucket::default()
        };
        let ranks = symbol_hit_ranks(&unsorted, 0.0);
        assert_eq!([ranks(0), ranks(1), ranks(2)], [0, 1, 2]);

        // Later in the drawn order is hit first.
        let whole = QueryShape::Circle {
            center: [0.0, 0.0],
            radius: 10.0,
        };
        let index = RenderedFeatureIndex {
            entries: vec![
                QueryEntry {
                    rank: 1,
                    ..entry(0, 0, tile(1, 0, 0), 7, whole)
                },
                QueryEntry {
                    rank: 2,
                    ..entry(0, 0, tile(1, 0, 0), 3, whole)
                },
            ],
        };
        let hits: Vec<usize> = index
            .query_point([0.0, 0.0], &[0])
            .iter()
            .map(|hit| hit.feature_index)
            .collect();
        assert_eq!(hits, vec![3, 7]);
    }

    #[test]
    fn only_circle_and_symbol_layers_are_queryable() {
        let layers = StyleLayer::parse_all(
            r#"[{"id":"dots","type":"circle","source-layer":"p"},
                {"id":"roads","type":"line","source-layer":"s"},
                {"id":"names","type":"symbol","source-layer":"p","layout":{"text-field":"x"}}]"#,
        )
        .unwrap();
        assert_eq!(
            query_layer_indices(&layers, &["names", "dots"]),
            Ok(vec![2, 0])
        );
        assert!(
            query_layer_indices(&layers, &["roads"])
                .unwrap_err()
                .contains("line layer")
        );
        assert!(
            query_layer_indices(&layers, &["lakes"])
                .unwrap_err()
                .contains("no tileset style layer")
        );
    }

    #[test]
    fn hits_report_the_feature_id_properties_and_layer() {
        let layers =
            StyleLayer::parse_all(r#"[{"id":"dots","type":"circle","source-layer":"places"}]"#)
                .unwrap();
        let feature = MvtFeature {
            id: Some(42),
            geometry_type: MvtGeometryType::Point,
            geometry: vec![vec![[0, 0]]],
            properties: [
                ("name".to_owned(), Value::from("Zürich")),
                ("rank".to_owned(), Value::from(2)),
            ]
            .into_iter()
            .collect(),
        };
        assert_eq!(
            rendered_feature(&layers[0], &feature),
            serde_json::json!({
                "type": "Feature",
                "id": 42,
                "properties": { "name": "Zürich", "rank": 2 },
                "layer": { "id": "dots", "type": "circle" },
                "sourceLayer": "places",
            })
        );
        let anonymous = MvtFeature {
            id: None,
            ..feature
        };
        assert!(rendered_feature(&layers[0], &anonymous).get("id").is_none());
    }
}
