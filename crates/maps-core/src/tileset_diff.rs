//! Tileset revision diff kernel (#276, part 2): what changed between the same tile of two
//! revisions of one source. Both payloads go through the runtime MVT decoder; archive I/O,
//! coverage deltas and report assembly stay with the caller.
//!
//! Identity rules, deliberately conservative:
//! - a feature whose geometry type, MVT ID, decoded geometry and properties are all equal on
//!   both sides is unchanged, regardless of protobuf field order, key/value table order or
//!   feature order (a multiset comparison);
//! - an MVT feature ID that occurs exactly once in a layer on each side identifies a feature,
//!   so it can be reported added, removed or changed;
//! - without such an ID (Shortbread producers may omit them) nothing asserts identity: a
//!   leftover feature whose type and properties equal a leftover on the other side is an
//!   `ambiguous` change candidate, every other leftover is `unmatched-added` or
//!   `unmatched-removed`;
//! - a layer whose extent differs between the sides is not comparable: quantization differs,
//!   so all its features are unmatched.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

use serde::Serialize;
use serde_json::Value;

use crate::{MvtFeature, MvtGeometryType, MvtLayer, VectorTileError, decode_mvt_layers};

/// Properties reported per sampled change; more are dropped from the sample only.
pub const TILESET_DIFF_MAX_CHANGE_PROPERTIES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MvtFeatureChangeKind {
    /// ID-identified feature only in the candidate.
    Added,
    /// ID-identified feature only in the base.
    Removed,
    /// ID-identified feature present on both sides with different geometry or properties.
    Changed,
    /// No stable ID; equal type and properties on both sides, different geometry.
    Ambiguous,
    /// No stable ID and no candidate counterpart in the base.
    UnmatchedAdded,
    /// No stable ID and no base counterpart in the candidate.
    UnmatchedRemoved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MvtLayerPresence {
    Both,
    Added,
    Removed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtDiffCounts {
    pub unchanged: u32,
    pub added: u32,
    pub removed: u32,
    pub changed: u32,
    pub ambiguous: u32,
    pub unmatched_added: u32,
    pub unmatched_removed: u32,
}

impl MvtDiffCounts {
    fn count(&mut self, kind: MvtFeatureChangeKind) {
        match kind {
            MvtFeatureChangeKind::Added => self.added += 1,
            MvtFeatureChangeKind::Removed => self.removed += 1,
            MvtFeatureChangeKind::Changed => self.changed += 1,
            MvtFeatureChangeKind::Ambiguous => self.ambiguous += 1,
            MvtFeatureChangeKind::UnmatchedAdded => self.unmatched_added += 1,
            MvtFeatureChangeKind::UnmatchedRemoved => self.unmatched_removed += 1,
        }
    }

    fn add(&mut self, other: &Self) {
        self.unchanged += other.unchanged;
        self.added += other.added;
        self.removed += other.removed;
        self.changed += other.changed;
        self.ambiguous += other.ambiguous;
        self.unmatched_added += other.unmatched_added;
        self.unmatched_removed += other.unmatched_removed;
    }

    /// Whether any feature differs between the sides.
    #[must_use]
    pub fn differs(&self) -> bool {
        self.added
            + self.removed
            + self.changed
            + self.ambiguous
            + self.unmatched_added
            + self.unmatched_removed
            > 0
    }
}

/// One source layer compared across the two tiles.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtLayerDiff {
    pub name: String,
    pub presence: MvtLayerPresence,
    pub base_extent: Option<u32>,
    pub candidate_extent: Option<u32>,
    /// False when the extents differ; every feature is then unmatched.
    pub comparable: bool,
    pub base_features: u32,
    pub candidate_features: u32,
    pub base_features_with_id: u32,
    pub candidate_features_with_id: u32,
    pub counts: MvtDiffCounts,
    /// Property keys only the candidate carries, sorted; empty unless both sides have the layer.
    pub property_keys_added: Vec<String>,
    /// Property keys only the base carries, sorted.
    pub property_keys_removed: Vec<String>,
}

/// A sampled feature difference in tile-local coordinates of the layer's extent.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtFeatureChange {
    pub kind: MvtFeatureChangeKind,
    pub layer: String,
    pub geometry_type: &'static str,
    pub id: Option<u64>,
    /// `[min_x, min_y, max_x, max_y]` of the base feature, when there is one.
    pub base_bounds: Option<[i32; 4]>,
    /// `[min_x, min_y, max_x, max_y]` of the candidate feature, when there is one.
    pub candidate_bounds: Option<[i32; 4]>,
    pub geometry_changed: bool,
    pub properties_changed: bool,
    /// Properties of the candidate feature (else the base one), at most
    /// [`TILESET_DIFF_MAX_CHANGE_PROPERTIES`] in key order.
    pub properties: BTreeMap<String, Value>,
}

/// Semantic difference between the base and candidate payload of one tile.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtTileDiff {
    /// No layer, property-key or feature difference.
    pub equal: bool,
    pub counts: MvtDiffCounts,
    /// Union of both sides' layers, sorted by name.
    pub layers: Vec<MvtLayerDiff>,
    /// At most the requested number of changes, by layer, kind and protobuf order.
    pub changes: Vec<MvtFeatureChange>,
    pub changes_truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MvtTileSide {
    Base,
    Candidate,
}

impl fmt::Display for MvtTileSide {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Base => "base",
            Self::Candidate => "candidate",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MvtTileDiffError {
    Undecodable(MvtTileSide, VectorTileError),
    /// The MVT specification forbids repeating a layer name in one tile.
    DuplicateLayer(MvtTileSide, String),
}

impl fmt::Display for MvtTileDiffError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Undecodable(side, error) => write!(formatter, "{side} tile: {error:?}"),
            Self::DuplicateLayer(side, name) => {
                write!(formatter, "{side} tile repeats source layer {name}")
            }
        }
    }
}

impl std::error::Error for MvtTileDiffError {}

/// Compares the base and candidate payload of one tile with the runtime MVT decoder.
pub fn diff_mvt_tiles(
    base: &[u8],
    candidate: &[u8],
    sample_limit: usize,
) -> Result<MvtTileDiff, MvtTileDiffError> {
    let base = layers_by_name(base, MvtTileSide::Base)?;
    let candidate = layers_by_name(candidate, MvtTileSide::Candidate)?;
    let names: BTreeSet<&String> = base.keys().chain(candidate.keys()).collect();
    let mut diff = MvtTileDiff {
        equal: true,
        counts: MvtDiffCounts::default(),
        layers: Vec::with_capacity(names.len()),
        changes: Vec::new(),
        changes_truncated: false,
    };
    for name in names {
        let (layer, changes) = diff_layer(name, base.get(name), candidate.get(name));
        diff.equal &= layer.presence == MvtLayerPresence::Both
            && layer.comparable
            && !layer.counts.differs()
            && layer.property_keys_added.is_empty()
            && layer.property_keys_removed.is_empty();
        diff.counts.add(&layer.counts);
        diff.layers.push(layer);
        for change in changes {
            if diff.changes.len() < sample_limit {
                diff.changes.push(change);
            } else {
                diff.changes_truncated = true;
            }
        }
    }
    Ok(diff)
}

fn layers_by_name(
    bytes: &[u8],
    side: MvtTileSide,
) -> Result<BTreeMap<String, MvtLayer>, MvtTileDiffError> {
    let mut layers = BTreeMap::new();
    for layer in decode_mvt_layers(bytes, |_| true)
        .map_err(|error| MvtTileDiffError::Undecodable(side, error))?
    {
        if layers.contains_key(&layer.name) {
            return Err(MvtTileDiffError::DuplicateLayer(side, layer.name));
        }
        layers.insert(layer.name.clone(), layer);
    }
    Ok(layers)
}

/// Exact identity of a decoded feature: type, ID, geometry and canonical properties.
#[derive(Hash, PartialEq, Eq)]
struct FeatureKey<'a> {
    geometry_type: u8,
    id: Option<u64>,
    geometry: &'a [Vec<[i32; 2]>],
    properties: String,
}

fn type_code(geometry_type: MvtGeometryType) -> u8 {
    match geometry_type {
        MvtGeometryType::Point => 1,
        MvtGeometryType::LineString => 2,
        MvtGeometryType::Polygon => 3,
    }
}

fn type_name(geometry_type: MvtGeometryType) -> &'static str {
    match geometry_type {
        MvtGeometryType::Point => "point",
        MvtGeometryType::LineString => "line",
        MvtGeometryType::Polygon => "polygon",
    }
}

/// Properties as canonical JSON; `BTreeMap` keeps the keys sorted.
fn canonical_properties(feature: &MvtFeature) -> String {
    serde_json::to_string(&feature.properties).unwrap_or_default()
}

fn key(feature: &MvtFeature) -> FeatureKey<'_> {
    FeatureKey {
        geometry_type: type_code(feature.geometry_type),
        id: feature.id,
        geometry: &feature.geometry,
        properties: canonical_properties(feature),
    }
}

fn bounds(feature: &MvtFeature) -> Option<[i32; 4]> {
    let mut points = feature.geometry.iter().flatten();
    let first = points.next()?;
    Some(
        points.fold([first[0], first[1], first[0], first[1]], |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        }),
    )
}

fn change(
    kind: MvtFeatureChangeKind,
    layer: &str,
    base: Option<&MvtFeature>,
    candidate: Option<&MvtFeature>,
) -> MvtFeatureChange {
    let shown = candidate.or(base).expect("a change has at least one side");
    let (geometry_changed, properties_changed) = match (base, candidate) {
        (Some(base), Some(candidate)) => (
            base.geometry_type != candidate.geometry_type || base.geometry != candidate.geometry,
            base.properties != candidate.properties,
        ),
        _ => (false, false),
    };
    MvtFeatureChange {
        kind,
        layer: layer.to_owned(),
        geometry_type: type_name(shown.geometry_type),
        id: shown.id,
        base_bounds: base.and_then(bounds),
        candidate_bounds: candidate.and_then(bounds),
        geometry_changed,
        properties_changed,
        properties: shown
            .properties
            .iter()
            .take(TILESET_DIFF_MAX_CHANGE_PROPERTIES)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    }
}

/// MVT feature IDs of one layer side: the index of each ID seen once, `None` when repeated.
struct LayerIds(HashMap<u64, Option<usize>>);

impl LayerIds {
    fn contains_key(&self, id: &u64) -> bool {
        self.0.contains_key(id)
    }

    fn repeated(&self, id: u64) -> bool {
        matches!(self.0.get(&id), Some(None))
    }

    /// The feature carrying `id`, when it is the only one.
    fn get(&self, id: &u64) -> Option<&usize> {
        self.0.get(id).and_then(Option::as_ref)
    }
}

fn unique_ids(features: &[MvtFeature]) -> LayerIds {
    let mut seen: HashMap<u64, Option<usize>> = HashMap::new();
    for (index, feature) in features.iter().enumerate() {
        if let Some(id) = feature.id {
            seen.entry(id)
                .and_modify(|slot| *slot = None)
                .or_insert(Some(index));
        }
    }
    LayerIds(seen)
}

fn property_keys(features: &[MvtFeature]) -> BTreeSet<&str> {
    features
        .iter()
        .flat_map(|feature| feature.properties.keys().map(String::as_str))
        .collect()
}

fn diff_layer(
    name: &str,
    base: Option<&MvtLayer>,
    candidate: Option<&MvtLayer>,
) -> (MvtLayerDiff, Vec<MvtFeatureChange>) {
    let empty: &[MvtFeature] = &[];
    let base_features = base.map_or(empty, |layer| layer.features.as_slice());
    let candidate_features = candidate.map_or(empty, |layer| layer.features.as_slice());
    let base_extent = base.map(|layer| layer.extent);
    let candidate_extent = candidate.map(|layer| layer.extent);
    let comparable =
        base_extent.is_none() || candidate_extent.is_none() || base_extent == candidate_extent;
    let with_id =
        |features: &[MvtFeature]| features.iter().filter(|f| f.id.is_some()).count() as u32;
    // Key drift is meaningful only for a layer both sides carry; presence covers the rest.
    let (base_keys, candidate_keys) = if base.is_some() && candidate.is_some() {
        (
            property_keys(base_features),
            property_keys(candidate_features),
        )
    } else {
        (BTreeSet::new(), BTreeSet::new())
    };
    let mut layer = MvtLayerDiff {
        name: name.to_owned(),
        presence: match (base, candidate) {
            (Some(_), Some(_)) => MvtLayerPresence::Both,
            (None, _) => MvtLayerPresence::Added,
            (_, None) => MvtLayerPresence::Removed,
        },
        base_extent,
        candidate_extent,
        comparable,
        base_features: base_features.len() as u32,
        candidate_features: candidate_features.len() as u32,
        base_features_with_id: with_id(base_features),
        candidate_features_with_id: with_id(candidate_features),
        counts: MvtDiffCounts::default(),
        property_keys_added: candidate_keys
            .difference(&base_keys)
            .map(|key| (*key).to_owned())
            .collect(),
        property_keys_removed: base_keys
            .difference(&candidate_keys)
            .map(|key| (*key).to_owned())
            .collect(),
    };
    let mut changes = Vec::new();
    let mut record = |counts: &mut MvtDiffCounts,
                      kind: MvtFeatureChangeKind,
                      base: Option<&MvtFeature>,
                      candidate: Option<&MvtFeature>| {
        counts.count(kind);
        changes.push(change(kind, name, base, candidate));
    };

    if !comparable {
        for feature in base_features {
            record(
                &mut layer.counts,
                MvtFeatureChangeKind::UnmatchedRemoved,
                Some(feature),
                None,
            );
        }
        for feature in candidate_features {
            record(
                &mut layer.counts,
                MvtFeatureChangeKind::UnmatchedAdded,
                None,
                Some(feature),
            );
        }
        changes.sort_by_key(|change| change.kind);
        return (layer, changes);
    }

    // 1. Exact multiset matches are unchanged.
    let mut pending: HashMap<FeatureKey<'_>, Vec<usize>> = HashMap::new();
    for (index, feature) in base_features.iter().enumerate().rev() {
        pending.entry(key(feature)).or_default().push(index);
    }
    let mut base_left = vec![false; base_features.len()];
    let mut candidate_left = Vec::new();
    for (index, feature) in candidate_features.iter().enumerate() {
        match pending.get_mut(&key(feature)).and_then(Vec::pop) {
            Some(_) => layer.counts.unchanged += 1,
            None => candidate_left.push(index),
        }
    }
    for indices in pending.values() {
        for &index in indices {
            base_left[index] = true;
        }
    }
    let base_left: Vec<usize> = (0..base_features.len()).filter(|&i| base_left[i]).collect();

    // 2. Unique MVT IDs identify features across the sides.
    let base_ids = unique_ids(base_features);
    let candidate_ids = unique_ids(candidate_features);
    // An ID identifies only when neither side repeats it.
    let identified = |feature: &MvtFeature| {
        feature.id.is_some_and(|id| {
            (base_ids.contains_key(&id) || candidate_ids.contains_key(&id))
                && !base_ids.repeated(id)
                && !candidate_ids.repeated(id)
        })
    };
    let mut pool_base = Vec::new();
    for &index in &base_left {
        let feature = &base_features[index];
        if !identified(feature) {
            pool_base.push(index);
            continue;
        }
        let id = feature.id.expect("identified features carry an ID");
        match candidate_ids.get(&id) {
            Some(&other) => record(
                &mut layer.counts,
                MvtFeatureChangeKind::Changed,
                Some(feature),
                Some(&candidate_features[other]),
            ),
            None => record(
                &mut layer.counts,
                MvtFeatureChangeKind::Removed,
                Some(feature),
                None,
            ),
        }
    }
    let mut pool_candidate = Vec::new();
    for &index in &candidate_left {
        let feature = &candidate_features[index];
        if !identified(feature) {
            pool_candidate.push(index);
        } else if !base_ids.contains_key(&feature.id.expect("identified features carry an ID")) {
            record(
                &mut layer.counts,
                MvtFeatureChangeKind::Added,
                None,
                Some(feature),
            );
        }
    }

    // 3. Without identity, equal type and properties make only an ambiguous candidate.
    let mut groups: BTreeMap<(u8, String), (Vec<usize>, Vec<usize>)> = BTreeMap::new();
    for &index in &pool_base {
        let feature = &base_features[index];
        groups
            .entry((
                type_code(feature.geometry_type),
                canonical_properties(feature),
            ))
            .or_default()
            .0
            .push(index);
    }
    for &index in &pool_candidate {
        let feature = &candidate_features[index];
        groups
            .entry((
                type_code(feature.geometry_type),
                canonical_properties(feature),
            ))
            .or_default()
            .1
            .push(index);
    }
    for (base_group, candidate_group) in groups.values() {
        let paired = base_group.len().min(candidate_group.len());
        for (&b, &c) in base_group.iter().zip(candidate_group) {
            record(
                &mut layer.counts,
                MvtFeatureChangeKind::Ambiguous,
                Some(&base_features[b]),
                Some(&candidate_features[c]),
            );
        }
        for &b in &base_group[paired..] {
            record(
                &mut layer.counts,
                MvtFeatureChangeKind::UnmatchedRemoved,
                Some(&base_features[b]),
                None,
            );
        }
        for &c in &candidate_group[paired..] {
            record(
                &mut layer.counts,
                MvtFeatureChangeKind::UnmatchedAdded,
                None,
                Some(&candidate_features[c]),
            );
        }
    }
    changes.sort_by_key(|change| change.kind);
    (layer, changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mvt_test_writer::{feature, layer, layer_with_extent, path_commands};

    const ROAD_A: &[[i32; 2]] = &[[0, 100], [4096, 100]];
    const ROAD_B: &[[i32; 2]] = &[[0, 900], [4096, 900]];
    const OUTER: &[[i32; 2]] = &[[0, 0], [0, 4096], [4096, 4096], [4096, 0]];
    const HOLE: &[[i32; 2]] = &[[1024, 1024], [3072, 1024], [3072, 3072], [1024, 3072]];
    const MOVED_HOLE: &[[i32; 2]] = &[[1200, 1024], [3072, 1024], [3072, 3072], [1200, 3072]];

    fn line(points: &[[i32; 2]]) -> Vec<u32> {
        path_commands(&[points], false)
    }

    fn streets(features: &[Vec<u8>]) -> Vec<u8> {
        layer(
            "streets",
            features,
            &["kind", "name"],
            &["primary", "Alpha Road", "Beta Road"],
        )
    }

    #[test]
    fn identical_and_reordered_payloads_are_equal() {
        let tile = streets(&[
            feature(None, 2, &line(ROAD_A), &[0, 0, 1, 1]),
            feature(None, 2, &line(ROAD_B), &[0, 0, 1, 2]),
        ]);
        let diff = diff_mvt_tiles(&tile, &tile, 8).unwrap();
        assert!(diff.equal);
        assert_eq!(diff.counts.unchanged, 2);

        // Same features in another order, with the key and value tables reordered.
        let reordered = layer(
            "streets",
            &[
                feature(None, 2, &line(ROAD_B), &[0, 0, 1, 1]),
                feature(None, 2, &line(ROAD_A), &[0, 2, 1, 1]),
            ],
            &["name", "kind"],
            &["Beta Road", "primary", "Alpha Road"],
        );
        assert_ne!(tile, reordered);
        let diff = diff_mvt_tiles(&tile, &reordered, 8).unwrap();
        assert!(diff.equal, "{diff:?}");
        assert_eq!(diff.counts.unchanged, 2);
        assert!(diff.changes.is_empty());
    }

    #[test]
    fn features_without_ids_are_unmatched_or_ambiguous_never_identified() {
        let base = streets(&[
            feature(None, 2, &line(ROAD_A), &[0, 0, 1, 1]),
            feature(None, 2, &line(ROAD_B), &[0, 0, 1, 2]),
        ]);
        // Alpha Road removed; a new Gamma Road added; Beta Road moved.
        let candidate = layer(
            "streets",
            &[
                feature(None, 2, &line(&[[0, 950], [4096, 950]]), &[0, 0, 1, 1]),
                feature(None, 2, &line(&[[0, 2000], [4096, 2000]]), &[0, 0, 1, 2]),
            ],
            &["kind", "name"],
            &["primary", "Beta Road", "Gamma Road"],
        );
        let diff = diff_mvt_tiles(&base, &candidate, 8).unwrap();
        assert!(!diff.equal);
        let counts = diff.counts;
        assert_eq!(
            (
                counts.unchanged,
                counts.added,
                counts.removed,
                counts.changed
            ),
            (0, 0, 0, 0)
        );
        assert_eq!(
            (
                counts.ambiguous,
                counts.unmatched_added,
                counts.unmatched_removed
            ),
            (1, 1, 1)
        );
        let ambiguous = &diff.changes[0];
        assert_eq!(ambiguous.kind, MvtFeatureChangeKind::Ambiguous);
        assert_eq!(ambiguous.properties["name"], "Beta Road");
        assert_eq!(ambiguous.base_bounds, Some([0, 900, 4096, 900]));
        assert_eq!(ambiguous.candidate_bounds, Some([0, 950, 4096, 950]));
        assert!(ambiguous.geometry_changed && !ambiguous.properties_changed);
        assert_eq!(diff.changes[1].kind, MvtFeatureChangeKind::UnmatchedAdded);
        assert_eq!(diff.changes[1].properties["name"], "Gamma Road");
        assert_eq!(diff.changes[2].kind, MvtFeatureChangeKind::UnmatchedRemoved);
        assert_eq!(diff.changes[2].properties["name"], "Alpha Road");
    }

    #[test]
    fn unique_ids_identify_added_removed_and_changed_features() {
        let base = streets(&[
            feature(Some(1), 2, &line(ROAD_A), &[0, 0, 1, 1]),
            feature(Some(2), 2, &line(ROAD_B), &[0, 0, 1, 2]),
        ]);
        let candidate = streets(&[
            feature(Some(2), 2, &line(ROAD_A), &[0, 0, 1, 2]),
            feature(Some(3), 2, &line(ROAD_B), &[0, 0, 1, 1]),
        ]);
        let diff = diff_mvt_tiles(&base, &candidate, 8).unwrap();
        let counts = diff.counts;
        assert_eq!((counts.added, counts.removed, counts.changed), (1, 1, 1));
        assert_eq!(
            counts.ambiguous + counts.unmatched_added + counts.unmatched_removed,
            0
        );
        let changed = diff
            .changes
            .iter()
            .find(|change| change.kind == MvtFeatureChangeKind::Changed)
            .unwrap();
        assert_eq!(changed.id, Some(2));
        assert!(changed.geometry_changed && !changed.properties_changed);
        assert_eq!(diff.layers[0].base_features_with_id, 2);
    }

    #[test]
    fn repeated_ids_are_not_treated_as_identity() {
        let base = streets(&[
            feature(Some(5), 2, &line(ROAD_A), &[0, 0, 1, 1]),
            feature(Some(5), 2, &line(ROAD_B), &[0, 0, 1, 2]),
        ]);
        let candidate = streets(&[feature(Some(5), 2, &line(ROAD_B), &[0, 0, 1, 1])]);
        let counts = diff_mvt_tiles(&base, &candidate, 8).unwrap().counts;
        assert_eq!((counts.added, counts.removed, counts.changed), (0, 0, 0));
        assert_eq!((counts.ambiguous, counts.unmatched_removed), (1, 1));
    }

    #[test]
    fn a_moved_polygon_hole_is_an_ambiguous_geometry_change() {
        let water = |hole: &[[i32; 2]]| {
            layer(
                "water_polygons",
                &[feature(
                    None,
                    3,
                    &path_commands(&[OUTER, hole], true),
                    &[0, 0],
                )],
                &["kind"],
                &["water"],
            )
        };
        let diff = diff_mvt_tiles(&water(HOLE), &water(MOVED_HOLE), 8).unwrap();
        assert_eq!(diff.counts.ambiguous, 1);
        assert_eq!(diff.changes[0].geometry_type, "polygon");
        assert!(diff.changes[0].geometry_changed);
        assert!(diff_mvt_tiles(&water(HOLE), &water(HOLE), 8).unwrap().equal);
    }

    #[test]
    fn schema_drift_reports_layers_and_property_keys() {
        let base = streets(&[feature(None, 2, &line(ROAD_A), &[0, 0, 1, 1])]);
        let mut candidate = layer(
            "streets",
            &[feature(None, 2, &line(ROAD_A), &[0, 0])],
            &["kind"],
            &["primary"],
        );
        candidate.extend(layer(
            "pois",
            &[feature(None, 1, &[9, 50, 34], &[])],
            &[],
            &[],
        ));
        let diff = diff_mvt_tiles(&base, &candidate, 8).unwrap();
        assert!(!diff.equal);
        assert_eq!(diff.layers[0].name, "pois");
        assert_eq!(diff.layers[0].presence, MvtLayerPresence::Added);
        assert_eq!(diff.layers[0].counts.unmatched_added, 1);
        assert_eq!(diff.layers[1].property_keys_removed, ["name"]);
        assert_eq!(diff.layers[1].counts.unmatched_removed, 1);
        assert_eq!(diff.layers[1].counts.unmatched_added, 1);
    }

    #[test]
    fn a_changed_extent_makes_the_layer_incomparable() {
        let base = streets(&[feature(None, 2, &line(ROAD_A), &[0, 0, 1, 1])]);
        let candidate = layer_with_extent(
            "streets",
            &[feature(
                None,
                2,
                &line(&[[0, 200], [8192, 200]]),
                &[0, 0, 1, 1],
            )],
            &["kind", "name"],
            &["primary", "Alpha Road"],
            8192,
        );
        let diff = diff_mvt_tiles(&base, &candidate, 8).unwrap();
        assert!(!diff.layers[0].comparable);
        assert_eq!(
            diff.counts.unmatched_added + diff.counts.unmatched_removed,
            2
        );
        assert_eq!(diff.counts.ambiguous, 0);
    }

    #[test]
    fn samples_are_bounded_while_counts_stay_exact() {
        let many: Vec<Vec<u8>> = (0..10)
            .map(|row| {
                feature(
                    None,
                    2,
                    &line(&[[0, row * 10], [10, row * 10]]),
                    &[0, 0, 1, 1],
                )
            })
            .collect();
        let diff = diff_mvt_tiles(&[], &streets(&many), 3).unwrap();
        assert_eq!(diff.counts.unmatched_added, 10);
        assert_eq!(diff.changes.len(), 3);
        assert!(diff.changes_truncated);
        assert_eq!(diff.layers[0].presence, MvtLayerPresence::Added);
    }

    #[test]
    fn undecodable_and_invalid_payloads_name_their_side() {
        let good = streets(&[]);
        assert!(matches!(
            diff_mvt_tiles(&good, &[0x1a, 0x7f, 0x00], 1),
            Err(MvtTileDiffError::Undecodable(MvtTileSide::Candidate, _))
        ));
        let mut repeated = good.clone();
        repeated.extend(&good);
        assert_eq!(
            diff_mvt_tiles(&repeated, &good, 1),
            Err(MvtTileDiffError::DuplicateLayer(
                MvtTileSide::Base,
                "streets".into()
            ))
        );
    }
}
