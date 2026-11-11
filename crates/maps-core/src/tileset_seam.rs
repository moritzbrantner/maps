//! Tile seam QA kernel (#276, part 3): whether lines and polygons continue across the shared
//! edge of two adjacent tiles. Both payloads go through the runtime MVT decoder; pair selection,
//! archive I/O and report assembly stay with the caller.
//!
//! Each tile is examined only at the shared edge, in edge coordinates: `u` is the distance from
//! the edge towards the tile's interior and `t` the position along the edge as a fraction of
//! the layer extent, so tiles with different extents compare directly.
//!
//! - **Lines** become edge events: the path crosses the edge (a buffered tile), or a path end
//!   lies on it (a tile clipped exactly at its edge). Touching the edge and turning back is not
//!   an event. Events of one side pair with the other side's events of the same layer, geometry
//!   type and properties. MVT feature IDs are ignored: a seam never asserts feature identity.
//! - **Polygons** become the spans of a strip along the edge their interior covers (even-odd
//!   over all rings, so a hole that crosses the edge leaves a gap), unioned per layer, type and
//!   properties. When a tile's layer reaches beyond its edge (a buffer), it also shows the strip
//!   just inside its neighbour, so each strip is compared as both tiles see it: a polygon whose
//!   boundary lies on the edge is not a seam. When both tiles are clipped at the edge, only
//!   continuity across it can be compared, so a polygon ending exactly on such an edge is
//!   reported. The parts of a strip only one tile covers are compared with the tolerance.
//! - **Tolerance.** Every vertex carries the ±0.5 unit of its quantization. A crossing
//!   interpolated inside a segment scales that by the segment's slope against the edge (a line
//!   nearly parallel to the edge has an uncertain crossing). On top of both sides' uncertainty,
//!   `slack_units` (in units of the finer extent) absorbs per-tile simplification of a
//!   provider. A line event left over after that pairs with a counterpart within
//!   `offset_window_units` as a displaced line (`line-offset`); the rest are duplicated, when a
//!   same-group event of the same side coincides with it, or interrupted.

use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;
use serde_json::Value;

use crate::{MvtFeature, MvtGeometryType, MvtLayer, VectorTileError, decode_mvt_layers};

/// Properties reported per sampled finding; more are dropped from the sample only.
pub const TILESET_SEAM_MAX_FINDING_PROPERTIES: usize = 8;

/// Where the second tile of a pair lies relative to the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MvtSeamEdge {
    /// The second tile is the eastern neighbour (`x + 1`).
    East,
    /// The second tile is the eastern neighbour across the antimeridian (the last column's
    /// neighbour is the first; a single-tile zoom is its own). Producers rarely wrap a buffer
    /// across it, so only continuity across the edge is compared.
    Antimeridian,
    /// The second tile is the southern neighbour (`y + 1`).
    South,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MvtSeamSide {
    First,
    Second,
}

impl fmt::Display for MvtSeamSide {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::First => "first",
            Self::Second => "second",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MvtSeamTolerance {
    /// Allowed offset beyond quantization, in units of the finer extent of the pair.
    pub slack_units: f64,
    /// Leftover line events this close (finer-extent units) are one displaced line.
    pub offset_window_units: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MvtSeamFindingKind {
    /// A line reaches the edge on one side and has no counterpart on the other.
    LineInterrupted,
    /// An unpaired line event coinciding with another event of the same side and group.
    LineDuplicated,
    /// A line continues across the edge, displaced beyond the tolerance.
    LineOffset,
    /// Part of the edge covered by a polygon group on one side only, beyond the tolerance.
    PolygonEdgeMismatch,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtSeamCounts {
    /// Line events paired within quantization and slack.
    pub line_crossings: u32,
    /// Of those, pairs that needed the slack beyond quantization.
    pub line_slack_used: u32,
    pub line_interrupted: u32,
    pub line_duplicated: u32,
    pub line_offset: u32,
    /// Polygon groups with edge coverage on either side.
    pub polygon_groups: u32,
    /// One-sided edge parts within tolerance (clipping, quantization, slack).
    pub polygon_slack_used: u32,
    pub polygon_mismatches: u32,
}

impl MvtSeamCounts {
    fn add(&mut self, other: &Self) {
        self.line_crossings += other.line_crossings;
        self.line_slack_used += other.line_slack_used;
        self.line_interrupted += other.line_interrupted;
        self.line_duplicated += other.line_duplicated;
        self.line_offset += other.line_offset;
        self.polygon_groups += other.polygon_groups;
        self.polygon_slack_used += other.polygon_slack_used;
        self.polygon_mismatches += other.polygon_mismatches;
    }

    /// Whether any seam defect was found.
    #[must_use]
    pub fn defective(&self) -> bool {
        self.line_interrupted + self.line_duplicated + self.line_offset + self.polygon_mismatches
            > 0
    }
}

/// One source layer at the shared edge.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtSeamLayer {
    pub name: String,
    pub first_extent: Option<u32>,
    pub second_extent: Option<u32>,
    /// How far (units of its extent) any geometry of the layer reaches beyond the tile: `0`
    /// for a tile clipped at its edge. A provider characteristic, not a defect.
    pub first_buffer: Option<u32>,
    pub second_buffer: Option<u32>,
    pub first_line_events: u32,
    pub second_line_events: u32,
    pub counts: MvtSeamCounts,
}

/// A sampled seam defect.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtSeamFinding {
    pub kind: MvtSeamFindingKind,
    pub layer: String,
    pub geometry_type: &'static str,
    /// The side carrying the unpaired event or the one-sided coverage; `None` for an offset.
    pub side: Option<MvtSeamSide>,
    /// For a polygon: the tile whose inside strip along the edge both tiles disagree on, or
    /// `None` when both tiles are clipped at the edge and coverage must continue across it.
    pub strip: Option<MvtSeamSide>,
    /// Positions along the edge as fractions of the extent (`t` of the first and second side
    /// for an offset; start and end of the one-sided part for a polygon).
    pub along: [f64; 2],
    /// Offset or one-sided length in units of the finer extent; `0` for an unpaired event.
    pub distance_units: f64,
    /// Properties of the group, at most [`TILESET_SEAM_MAX_FINDING_PROPERTIES`] in key order.
    pub properties: BTreeMap<String, Value>,
}

/// Seam continuity between two adjacent tiles.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MvtSeam {
    pub edge: MvtSeamEdge,
    pub counts: MvtSeamCounts,
    /// Union of both sides' layers, sorted by name.
    pub layers: Vec<MvtSeamLayer>,
    /// At most the requested number of findings, by layer, group and position.
    pub findings: Vec<MvtSeamFinding>,
    pub findings_truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MvtSeamError {
    Undecodable(MvtSeamSide, VectorTileError),
    /// The MVT specification forbids repeating a layer name in one tile.
    DuplicateLayer(MvtSeamSide, String),
    InvalidTolerance,
}

impl fmt::Display for MvtSeamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Undecodable(side, error) => write!(formatter, "{side} tile: {error}"),
            Self::DuplicateLayer(side, name) => {
                write!(formatter, "{side} tile repeats source layer {name}")
            }
            Self::InvalidTolerance => {
                formatter.write_str("seam tolerances must be finite and non-negative")
            }
        }
    }
}

impl std::error::Error for MvtSeamError {}

/// Checks the shared edge of two adjacent tiles with the runtime MVT decoder. `second` lies
/// `edge` of `first`; a single-tile zoom level is its own eastern neighbour.
pub fn check_mvt_seam(
    first: &[u8],
    second: &[u8],
    edge: MvtSeamEdge,
    tolerance: MvtSeamTolerance,
    sample_limit: usize,
) -> Result<MvtSeam, MvtSeamError> {
    if !(tolerance.slack_units.is_finite()
        && tolerance.slack_units >= 0.0
        && tolerance.offset_window_units.is_finite()
        && tolerance.offset_window_units >= 0.0)
    {
        return Err(MvtSeamError::InvalidTolerance);
    }
    let first = layers_by_name(first, MvtSeamSide::First)?;
    let second = layers_by_name(second, MvtSeamSide::Second)?;
    let mut names: Vec<&String> = first.keys().chain(second.keys()).collect();
    names.sort();
    names.dedup();
    let mut seam = MvtSeam {
        edge,
        counts: MvtSeamCounts::default(),
        layers: Vec::with_capacity(names.len()),
        findings: Vec::new(),
        findings_truncated: false,
    };
    for name in names {
        let mut findings = Vec::new();
        let layer = check_layer(
            name,
            first.get(name),
            second.get(name),
            edge,
            tolerance,
            &mut findings,
        );
        seam.counts.add(&layer.counts);
        seam.layers.push(layer);
        for finding in findings {
            if seam.findings.len() < sample_limit {
                seam.findings.push(finding);
            } else {
                seam.findings_truncated = true;
            }
        }
    }
    Ok(seam)
}

fn layers_by_name(
    bytes: &[u8],
    side: MvtSeamSide,
) -> Result<BTreeMap<String, MvtLayer>, MvtSeamError> {
    let mut layers = BTreeMap::new();
    for layer in decode_mvt_layers(bytes, |_| true)
        .map_err(|error| MvtSeamError::Undecodable(side, error))?
    {
        if layers.contains_key(&layer.name) {
            return Err(MvtSeamError::DuplicateLayer(side, layer.name));
        }
        layers.insert(layer.name.clone(), layer);
    }
    Ok(layers)
}

/// A point in edge coordinates of one tile: `u` towards the interior, `v` along the edge, both
/// in units of the layer extent.
fn edge_point(point: [i32; 2], extent: f64, edge: MvtSeamEdge, side: MvtSeamSide) -> [f64; 2] {
    let [x, y] = [f64::from(point[0]), f64::from(point[1])];
    match (edge, side) {
        (MvtSeamEdge::East | MvtSeamEdge::Antimeridian, MvtSeamSide::First) => [extent - x, y],
        (MvtSeamEdge::East | MvtSeamEdge::Antimeridian, MvtSeamSide::Second) => [x, y],
        (MvtSeamEdge::South, MvtSeamSide::First) => [extent - y, x],
        (MvtSeamEdge::South, MvtSeamSide::Second) => [y, x],
    }
}

/// A position on the edge in units of the layer extent, with its quantization uncertainty.
#[derive(Clone, Copy, Debug)]
struct EdgePosition {
    v: f64,
    uncertainty: f64,
}

/// Where segment `a`–`b` (`u` of opposite signs, or `b` on the edge) meets the edge.
fn crossing(a: [f64; 2], b: [f64; 2]) -> EdgePosition {
    let along = b[1] - a[1];
    let across = b[0] - a[0];
    let v = a[1] - a[0] * along / across;
    // ±0.5 unit in `u` moves the crossing by the slope; it stays within the segment.
    let slope = (along / across).abs();
    EdgePosition {
        v,
        uncertainty: (0.5 * (1.0 + slope)).min(along.abs().max(0.5)),
    }
}

const VERTEX: f64 = 0.5;

fn side_of(point: [f64; 2]) -> i8 {
    if point[0] > 0.0 {
        1
    } else if point[0] < 0.0 {
        -1
    } else {
        0
    }
}

/// Edge events of one line path: crossings, and path ends lying on the edge.
fn line_events(path: &[[f64; 2]], out: &mut Vec<EdgePosition>) {
    let mut previous: Option<(i8, usize)> = None;
    let mut index = 0;
    while index < path.len() {
        let side = side_of(path[index]);
        if side != 0 {
            if let Some((before, at)) = previous
                && before != side
                && at + 1 == index
            {
                out.push(crossing(path[at], path[index]));
            }
            previous = Some((side, index));
            index += 1;
            continue;
        }
        let start = index;
        while index < path.len() && side_of(path[index]) == 0 {
            index += 1;
        }
        let end = index - 1;
        let before = previous.map(|(side, _)| side);
        let after = path.get(index).map(|point| side_of(*point));
        let at = |position: usize| EdgePosition {
            v: path[position][1],
            uncertainty: VERTEX,
        };
        match (before, after) {
            // Passes through the edge, or ends on it.
            (Some(a), Some(b)) if a != b => out.push(at(start)),
            (Some(_), None) => out.push(at(start)),
            (None, Some(_)) => out.push(at(end)),
            // Touches and turns back, or lies along the edge only.
            _ => {}
        }
    }
}

/// Edge spans a polygon's interior covers immediately inside the tile (`inside`, `u → 0⁺`) or
/// immediately beyond its edge in the buffer (`u → 0⁻`): even-odd over all rings. Points on the
/// edge count as the other side, so a polygon clipped at the edge covers the inside strip and a
/// polygon whose boundary lies on the edge covers only the strip it lies in.
fn polygon_spans(
    rings: &[Vec<[f64; 2]>],
    inside: bool,
    out: &mut Vec<(EdgePosition, EdgePosition)>,
) {
    let within = |point: [f64; 2]| {
        if inside {
            point[0] > 0.0
        } else {
            point[0] < 0.0
        }
    };
    let mut crossings = Vec::new();
    for ring in rings {
        for pair in ring.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if within(a) != within(b) {
                crossings.push(crossing(a, b));
            }
        }
    }
    crossings.sort_by(|a, b| a.v.total_cmp(&b.v));
    for [start, end] in crossings.as_chunks::<2>().0 {
        if end.v > start.v {
            out.push((*start, *end));
        }
    }
}

#[derive(Default)]
struct Group {
    properties: BTreeMap<String, Value>,
    /// Per side, positions normalized by that side's extent.
    lines: [Vec<EdgePosition>; 2],
    /// Per side: spans of the strip inside the tile, then of the strip beyond its edge.
    spans: [[Vec<(EdgePosition, EdgePosition)>; 2]; 2],
}

fn overshoot(features: &[MvtFeature], extent: u32) -> u32 {
    let extent = i64::from(extent);
    features
        .iter()
        .flat_map(|feature| feature.geometry.iter().flatten())
        .map(|point| {
            let [x, y] = [i64::from(point[0]), i64::from(point[1])];
            (-x).max(-y).max(x - extent).max(y - extent).max(0)
        })
        .max()
        .map_or(0, |value| u32::try_from(value).unwrap_or(u32::MAX))
}

fn type_name(geometry_type: MvtGeometryType) -> &'static str {
    match geometry_type {
        MvtGeometryType::Point => "point",
        MvtGeometryType::LineString => "line",
        MvtGeometryType::Polygon => "polygon",
    }
}

fn round(value: f64, scale: f64) -> f64 {
    (value * scale).round() / scale
}

fn check_layer(
    name: &str,
    first: Option<&MvtLayer>,
    second: Option<&MvtLayer>,
    edge: MvtSeamEdge,
    tolerance: MvtSeamTolerance,
    findings: &mut Vec<MvtSeamFinding>,
) -> MvtSeamLayer {
    let mut summary = MvtSeamLayer {
        name: name.to_owned(),
        first_extent: first.map(|layer| layer.extent),
        second_extent: second.map(|layer| layer.extent),
        first_buffer: first.map(|layer| overshoot(&layer.features, layer.extent)),
        second_buffer: second.map(|layer| overshoot(&layer.features, layer.extent)),
        first_line_events: 0,
        second_line_events: 0,
        counts: MvtSeamCounts::default(),
    };
    let finer = f64::from(
        summary
            .first_extent
            .unwrap_or(0)
            .max(summary.second_extent.unwrap_or(0))
            .max(1),
    );
    let slack = tolerance.slack_units / finer;
    let window = tolerance.offset_window_units / finer;
    // Only the shared edge counts: events in a buffer corner beyond it belong to another pair,
    // but are kept within the matching distance so a counterpart just inside still pairs.
    let margin = slack + window + 1.0 / finer;
    let trusted = edge != MvtSeamEdge::Antimeridian;
    let buffered = [
        trusted && summary.first_buffer.is_some_and(|buffer| buffer > 0),
        trusted && summary.second_buffer.is_some_and(|buffer| buffer > 0),
    ];
    // Groups by geometry type and canonical properties; `BTreeMap` keeps them deterministic.
    let mut groups: BTreeMap<(&'static str, String), Group> = BTreeMap::new();
    for (index, layer) in [first, second].into_iter().enumerate() {
        let Some(layer) = layer else { continue };
        let side = if index == 0 {
            MvtSeamSide::First
        } else {
            MvtSeamSide::Second
        };
        let extent = f64::from(layer.extent);
        for feature in &layer.features {
            if feature.geometry_type == MvtGeometryType::Point {
                continue;
            }
            let paths: Vec<Vec<[f64; 2]>> = feature
                .geometry
                .iter()
                .map(|path| {
                    path.iter()
                        .map(|point| edge_point(*point, extent, edge, side))
                        .collect()
                })
                .collect();
            let key = (
                type_name(feature.geometry_type),
                serde_json::to_string(&feature.properties).unwrap_or_default(),
            );
            let group = groups.entry(key).or_insert_with(|| Group {
                properties: feature.properties.clone(),
                ..Group::default()
            });
            let normalize = |position: EdgePosition| EdgePosition {
                v: position.v / extent,
                uncertainty: position.uncertainty / extent,
            };
            if feature.geometry_type == MvtGeometryType::LineString {
                let mut events = Vec::new();
                for path in &paths {
                    line_events(path, &mut events);
                }
                group.lines[index].extend(
                    events
                        .into_iter()
                        .map(normalize)
                        .filter(|event| event.v >= -margin && event.v <= 1.0 + margin),
                );
            } else {
                for (strip, inside) in [true, false].into_iter().enumerate() {
                    let mut spans = Vec::new();
                    polygon_spans(&paths, inside, &mut spans);
                    group.spans[index][strip].extend(spans.into_iter().filter_map(|(a, b)| {
                        let (mut a, mut b) = (normalize(a), normalize(b));
                        if a.v < 0.0 {
                            a = EdgePosition {
                                v: 0.0,
                                uncertainty: 0.0,
                            };
                        }
                        if b.v > 1.0 {
                            b = EdgePosition {
                                v: 1.0,
                                uncertainty: 0.0,
                            };
                        }
                        (b.v > a.v).then_some((a, b))
                    }));
                }
            }
        }
    }
    for ((geometry_type, _), group) in &mut groups {
        let properties: BTreeMap<String, Value> = group
            .properties
            .iter()
            .take(TILESET_SEAM_MAX_FINDING_PROPERTIES)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let geometry_type: &'static str = geometry_type;
        let finding = |kind, side, strip, along: [f64; 2], distance: f64| MvtSeamFinding {
            kind,
            layer: name.to_owned(),
            geometry_type,
            side,
            strip,
            along: along.map(|value| round(value, 1e6)),
            distance_units: round(distance * finer, 1e3),
            properties: properties.clone(),
        };
        if geometry_type == "line" {
            summary.first_line_events += group.lines[0].len() as u32;
            summary.second_line_events += group.lines[1].len() as u32;
            check_lines(
                &mut group.lines,
                slack,
                window,
                &mut summary.counts,
                &mut |kind, side, along, distance| {
                    findings.push(finding(kind, side, None, along, distance));
                },
            );
        } else {
            // A tile whose layer reaches beyond its edge shows the strip just inside its
            // neighbour too: compare each strip as both tiles see it, so a polygon whose
            // boundary lies on the edge is not a seam. Two tiles clipped at the edge show only
            // their own strips; then the coverage must continue across the edge.
            let [first_spans, second_spans] = &group.spans;
            let comparisons: Vec<(&[_], &[_], Option<MvtSeamSide>)> = if buffered[0] || buffered[1]
            {
                let mut strips = Vec::new();
                if buffered[1] {
                    strips.push((
                        first_spans[0].as_slice(),
                        second_spans[1].as_slice(),
                        Some(MvtSeamSide::First),
                    ));
                }
                if buffered[0] {
                    strips.push((
                        first_spans[1].as_slice(),
                        second_spans[0].as_slice(),
                        Some(MvtSeamSide::Second),
                    ));
                }
                strips
            } else {
                vec![(first_spans[0].as_slice(), second_spans[0].as_slice(), None)]
            };
            if comparisons
                .iter()
                .any(|(first, second, _)| !first.is_empty() || !second.is_empty())
            {
                summary.counts.polygon_groups += 1;
            }
            for (first, second, strip) in comparisons {
                check_spans(
                    [first, second],
                    slack,
                    &mut summary.counts,
                    &mut |side, along, distance| {
                        findings.push(finding(
                            MvtSeamFindingKind::PolygonEdgeMismatch,
                            Some(side),
                            strip,
                            along,
                            distance,
                        ));
                    },
                );
            }
        }
    }
    summary
}

/// Greedy pairing by increasing distance, then index; deterministic for equal distances.
fn pair_events(
    first: &[EdgePosition],
    second: &[EdgePosition],
    first_open: &[bool],
    second_open: &[bool],
    allowed: impl Fn(&EdgePosition, &EdgePosition) -> f64,
) -> Vec<(usize, usize, f64)> {
    let mut candidates = Vec::new();
    for (i, a) in first.iter().enumerate() {
        if !first_open[i] {
            continue;
        }
        for (j, b) in second.iter().enumerate() {
            if !second_open[j] {
                continue;
            }
            let distance = (a.v - b.v).abs();
            if distance <= allowed(a, b) {
                candidates.push((distance, i, j));
            }
        }
    }
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut first_taken = vec![false; first.len()];
    let mut second_taken = vec![false; second.len()];
    let mut pairs = Vec::new();
    for (distance, i, j) in candidates {
        if first_taken[i] || second_taken[j] {
            continue;
        }
        first_taken[i] = true;
        second_taken[j] = true;
        pairs.push((i, j, distance));
    }
    pairs
}

fn check_lines(
    events: &mut [Vec<EdgePosition>; 2],
    slack: f64,
    window: f64,
    counts: &mut MvtSeamCounts,
    report: &mut impl FnMut(MvtSeamFindingKind, Option<MvtSeamSide>, [f64; 2], f64),
) {
    for side in events.iter_mut() {
        side.sort_by(|a, b| a.v.total_cmp(&b.v));
    }
    let [first, second] = &*events;
    let mut first_open = vec![true; first.len()];
    let mut second_open = vec![true; second.len()];
    for (i, j, distance) in pair_events(first, second, &first_open, &second_open, |a, b| {
        a.uncertainty + b.uncertainty + slack
    }) {
        first_open[i] = false;
        second_open[j] = false;
        counts.line_crossings += 1;
        if distance > first[i].uncertainty + second[j].uncertainty {
            counts.line_slack_used += 1;
        }
    }
    let inside = |event: &EdgePosition| (0.0..=1.0).contains(&event.v);
    for (i, j, distance) in pair_events(first, second, &first_open, &second_open, |_, _| window) {
        first_open[i] = false;
        second_open[j] = false;
        if !inside(&first[i]) && !inside(&second[j]) {
            continue;
        }
        counts.line_offset += 1;
        report(
            MvtSeamFindingKind::LineOffset,
            None,
            [first[i].v, second[j].v],
            distance,
        );
    }
    for (side, (own, open)) in [(first, &first_open), (second, &second_open)]
        .into_iter()
        .enumerate()
    {
        let label = if side == 0 {
            MvtSeamSide::First
        } else {
            MvtSeamSide::Second
        };
        for (index, event) in own.iter().enumerate() {
            if !open[index] || !inside(event) {
                continue;
            }
            let duplicated = own.iter().enumerate().any(|(other, position)| {
                other != index
                    && (position.v - event.v).abs()
                        <= position.uncertainty + event.uncertainty + slack
            });
            let kind = if duplicated {
                counts.line_duplicated += 1;
                MvtSeamFindingKind::LineDuplicated
            } else {
                counts.line_interrupted += 1;
                MvtSeamFindingKind::LineInterrupted
            };
            report(kind, Some(label), [event.v, event.v], 0.0);
        }
    }
}

/// Unions one side's spans; an end keeps the uncertainty of the span that set it.
fn union(spans: &[(EdgePosition, EdgePosition)]) -> Vec<(EdgePosition, EdgePosition)> {
    let mut sorted = spans.to_vec();
    sorted.sort_by(|a, b| a.0.v.total_cmp(&b.0.v).then(a.1.v.total_cmp(&b.1.v)));
    let mut merged: Vec<(EdgePosition, EdgePosition)> = Vec::new();
    for span in sorted {
        match merged.last_mut() {
            Some(last) if span.0.v <= last.1.v => {
                if span.1.v > last.1.v {
                    last.1 = span.1;
                }
            }
            _ => merged.push(span),
        }
    }
    merged
}

/// Compares the first and second tile's view of one strip along the edge.
fn check_spans(
    spans: [&[(EdgePosition, EdgePosition)]; 2],
    slack: f64,
    counts: &mut MvtSeamCounts,
    report: &mut impl FnMut(MvtSeamSide, [f64; 2], f64),
) {
    let unions = [union(spans[0]), union(spans[1])];
    // Boundaries of both unions in edge order: (position, side, opens).
    let mut boundaries: Vec<(EdgePosition, usize, bool)> = Vec::new();
    for (side, spans) in unions.iter().enumerate() {
        for (start, end) in spans {
            boundaries.push((*start, side, true));
            boundaries.push((*end, side, false));
        }
    }
    boundaries.sort_by(|a, b| a.0.v.total_cmp(&b.0.v).then(a.1.cmp(&b.1)));
    let mut covered = [false, false];
    for pair in boundaries.windows(2) {
        let (at, side, opens) = pair[0];
        covered[side] = opens;
        let next = pair[1].0;
        let length = next.v - at.v;
        if covered[0] == covered[1] || length <= 0.0 {
            continue;
        }
        if length <= at.uncertainty + next.uncertainty + slack {
            counts.polygon_slack_used += 1;
            continue;
        }
        counts.polygon_mismatches += 1;
        let label = if covered[0] {
            MvtSeamSide::First
        } else {
            MvtSeamSide::Second
        };
        report(label, [at.v, next.v], length);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mvt_test_writer::{feature, layer, layer_with_extent, path_commands};

    const TOLERANCE: MvtSeamTolerance = MvtSeamTolerance {
        slack_units: 2.0,
        offset_window_units: 64.0,
    };

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

    fn road(points: &[[i32; 2]], name: u32) -> Vec<u8> {
        feature(None, 2, &line(points), &[0, 0, 1, name])
    }

    fn water(rings: &[&[[i32; 2]]]) -> Vec<u8> {
        layer(
            "water_polygons",
            &[feature(None, 3, &path_commands(rings, true), &[0, 0])],
            &["kind"],
            &["water"],
        )
    }

    fn check(first: &[u8], second: &[u8], edge: MvtSeamEdge) -> MvtSeam {
        check_mvt_seam(first, second, edge, TOLERANCE, 16).unwrap()
    }

    #[test]
    fn a_line_clipped_at_the_edge_or_buffered_continues() {
        // Clipped exactly at the edge: the path ends on it on both sides.
        let west = streets(&[road(&[[100, 1000], [4096, 1200]], 1)]);
        let east = streets(&[road(&[[0, 1200], [3000, 1400]], 1)]);
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert!(!seam.counts.defective(), "{seam:?}");
        assert_eq!(seam.counts.line_crossings, 1);
        // Buffered by 64 units: the path crosses the edge on both sides.
        let west = streets(&[road(&[[100, 1000], [4160, 1203]], 1)]);
        let east = streets(&[road(&[[-64, 1197], [3000, 1400]], 1)]);
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert_eq!(seam.counts.line_crossings, 1, "{seam:?}");
        assert_eq!(seam.layers[0].first_buffer, Some(64));
        assert_eq!(seam.layers[0].second_buffer, Some(64));
        // Mixed clipping on the southern edge.
        let north = streets(&[road(&[[2000, 10], [2010, 4096]], 2)]);
        let south = streets(&[road(&[[2010, -32], [2020, 900]], 2)]);
        let seam = check(&north, &south, MvtSeamEdge::South);
        assert_eq!(seam.counts.line_crossings, 1, "{seam:?}");
        assert!(!seam.counts.defective());
    }

    #[test]
    fn interrupted_duplicated_and_offset_lines_are_reported() {
        let west = streets(&[
            road(&[[100, 1000], [4096, 1000]], 1),
            road(&[[100, 3000], [4096, 3000]], 2),
        ]);
        // Alpha Road is missing east of the edge; Beta Road is there twice.
        let east = streets(&[
            road(&[[0, 3000], [900, 3000]], 2),
            road(&[[0, 3000], [900, 3100]], 2),
        ]);
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert_eq!(seam.counts.line_crossings, 1);
        assert_eq!(seam.counts.line_interrupted, 1);
        assert_eq!(seam.counts.line_duplicated, 1);
        let kinds: Vec<_> = seam
            .findings
            .iter()
            .map(|finding| (finding.kind, finding.side, finding.along[0]))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (
                    MvtSeamFindingKind::LineInterrupted,
                    Some(MvtSeamSide::First),
                    0.244141
                ),
                (
                    MvtSeamFindingKind::LineDuplicated,
                    Some(MvtSeamSide::Second),
                    0.732422
                ),
            ]
        );
        assert_eq!(seam.findings[0].properties["name"], "Alpha Road");

        // Displaced by 20 units: beyond quantization and slack, within the offset window.
        let east = streets(&[
            road(&[[0, 1020], [900, 1020]], 1),
            road(&[[0, 3000], [900, 3000]], 2),
        ]);
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert_eq!(seam.counts.line_offset, 1, "{seam:?}");
        assert_eq!(seam.findings[0].distance_units, 20.0);
        assert_eq!(seam.findings[0].side, None);
    }

    #[test]
    fn quantization_and_slack_absorb_small_offsets_only() {
        let west = streets(&[road(&[[100, 1000], [4096, 1000]], 1)]);
        // 1 unit: quantization alone. 3 units: needs the 2-unit slack. 4 units: beyond both.
        for (offset, crossings, slack_used) in [(1, 1, 0), (3, 1, 1), (4, 0, 0)] {
            let east = streets(&[road(&[[0, 1000 + offset], [900, 1000]], 1)]);
            let seam = check(&west, &east, MvtSeamEdge::East);
            assert_eq!(
                (seam.counts.line_crossings, seam.counts.line_slack_used),
                (crossings, slack_used),
                "offset {offset}: {seam:?}"
            );
            assert_eq!(seam.counts.defective(), crossings == 0);
        }
        // A buffered segment nearly parallel to the edge crosses it imprecisely: a 6-unit
        // difference is within its slope-scaled uncertainty.
        let west = streets(&[road(&[[4090, 1000], [4102, 1060]], 1)]);
        let east = streets(&[road(&[[-6, 1009], [6, 1063]], 1)]);
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert_eq!(seam.counts.line_crossings, 1, "{seam:?}");
    }

    #[test]
    fn touching_or_parallel_lines_are_not_events_and_attributes_must_agree() {
        let west = streets(&[
            // Touches the edge and turns back.
            road(&[[4000, 500], [4096, 600], [4000, 700]], 1),
            // Runs along the edge only.
            road(&[[4096, 2000], [4096, 2400]], 1),
        ]);
        let seam = check(&west, &streets(&[]), MvtSeamEdge::East);
        assert_eq!(seam.layers[0].first_line_events, 0);
        assert!(!seam.counts.defective());
        // The same geometry continues with another name: the attributes break at the seam.
        let west = streets(&[road(&[[100, 1000], [4096, 1000]], 1)]);
        let east = streets(&[road(&[[0, 1000], [900, 1000]], 2)]);
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert_eq!(seam.counts.line_interrupted, 2, "{seam:?}");
    }

    #[test]
    fn polygon_rings_and_holes_continue_across_the_edge() {
        // A lake clipped at the edge, with an island hole crossing it.
        let outer_west: &[[i32; 2]] = &[[3000, 1000], [4096, 1000], [4096, 3000], [3000, 3000]];
        let hole_west: &[[i32; 2]] = &[[3800, 1800], [3800, 2200], [4096, 2200], [4096, 1800]];
        let outer_east: &[[i32; 2]] = &[[0, 1000], [800, 1000], [800, 3000], [0, 3000]];
        let hole_east: &[[i32; 2]] = &[[0, 1800], [0, 2200], [300, 2200], [300, 1800]];
        let west = water(&[outer_west, hole_west]);
        let east = water(&[outer_east, hole_east]);
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert_eq!(seam.counts.polygon_groups, 1);
        assert!(!seam.counts.defective(), "{seam:?}");

        // Buffered east tile, one unit of quantization off: still continuous.
        let buffered: &[[i32; 2]] = &[[-64, 1001], [800, 1001], [800, 3000], [-64, 3000]];
        let hole_buffered: &[[i32; 2]] = &[[-64, 1800], [-64, 2200], [300, 2200], [300, 1800]];
        let seam = check(&west, &water(&[buffered, hole_buffered]), MvtSeamEdge::East);
        assert!(!seam.counts.defective(), "{seam:?}");
        assert_eq!(seam.counts.polygon_slack_used, 1);

        // The hole shifted by 40 units east of the edge: two one-sided parts.
        let shifted: &[[i32; 2]] = &[[0, 1840], [0, 2240], [300, 2240], [300, 1840]];
        let seam = check(&west, &water(&[outer_east, shifted]), MvtSeamEdge::East);
        assert_eq!(seam.counts.polygon_mismatches, 2, "{seam:?}");
        let parts: Vec<_> = seam
            .findings
            .iter()
            .map(|finding| (finding.side, finding.distance_units))
            .collect();
        assert_eq!(
            parts,
            vec![
                (Some(MvtSeamSide::Second), 40.0),
                (Some(MvtSeamSide::First), 40.0)
            ]
        );

        // No hole east of the edge: the island is interrupted.
        let seam = check(&west, &water(&[outer_east]), MvtSeamEdge::East);
        assert_eq!(seam.counts.polygon_mismatches, 1);
        assert_eq!(seam.findings[0].side, Some(MvtSeamSide::Second));
        assert_eq!(seam.findings[0].distance_units, 400.0);
    }

    #[test]
    fn buffer_corners_beyond_the_shared_edge_are_not_compared() {
        // The west tile's buffer reaches past the corner (y < 0): that part of x = 4096 is the
        // edge of two other tiles, so a line crossing there and a lake reaching into it are not
        // this pair's concern.
        let west_lines = streets(&[road(&[[4000, -40], [4160, -40]], 1)]);
        let seam = check(&west_lines, &streets(&[]), MvtSeamEdge::East);
        assert!(!seam.counts.defective(), "{seam:?}");
        let west_lake: &[[i32; 2]] = &[[3000, -64], [4160, -64], [4160, 2000], [3000, 2000]];
        let east_lake: &[[i32; 2]] = &[[0, 0], [800, 0], [800, 2000], [0, 2000]];
        let seam = check(
            &water(&[west_lake]),
            &water(&[east_lake]),
            MvtSeamEdge::East,
        );
        assert!(!seam.counts.defective(), "{seam:?}");
        assert_eq!(seam.counts.polygon_groups, 1);
    }

    #[test]
    fn a_polygon_ending_on_the_edge_is_a_seam_only_without_a_buffer() {
        // Found in the Atlas archive (14/8625/5751 → 5752): a building whose northern wall lies
        // on the tile edge. The northern tile carries it in its buffer only.
        let building = |rings: &[&[[i32; 2]]]| {
            layer(
                "buildings",
                &[feature(None, 3, &path_commands(rings, true), &[0, 0])],
                &["kind"],
                &["residential"],
            )
        };
        let north = building(&[&[
            [368, 4096],
            [367, 4136],
            [346, 4136],
            [346, 4120],
            [330, 4120],
            [331, 4096],
        ]]);
        let south = building(&[&[
            [368, 0],
            [367, 40],
            [346, 40],
            [346, 24],
            [330, 24],
            [331, 0],
        ]]);
        let seam = check(&north, &south, MvtSeamEdge::South);
        assert!(!seam.counts.defective(), "{seam:?}");
        assert_eq!(seam.counts.polygon_groups, 1);

        // Two tiles clipped at the edge: only continuity across it can be compared, so the
        // same wall is reported (a documented limit of unbuffered tilesets).
        let seam = check(&building(&[]), &south, MvtSeamEdge::South);
        assert_eq!(seam.counts.polygon_mismatches, 1, "{seam:?}");
        assert_eq!(seam.findings[0].strip, None);

        // A buffered northern tile that lacks the building: the southern strip disagrees.
        let other: &[[i32; 2]] = &[[2000, 4000], [2100, 4000], [2100, 4150], [2000, 4150]];
        let seam = check(&building(&[other]), &south, MvtSeamEdge::South);
        let disagreement: Vec<_> = seam
            .findings
            .iter()
            .map(|finding| (finding.side, finding.strip, finding.distance_units))
            .collect();
        assert!(
            disagreement.contains(&(Some(MvtSeamSide::Second), Some(MvtSeamSide::Second), 37.0)),
            "{seam:?}"
        );
    }

    #[test]
    fn invalid_winding_does_not_change_edge_coverage() {
        // Even-odd edge coverage: a reversed outer ring covers the same part of the edge.
        let west: &[[i32; 2]] = &[[3000, 1000], [3000, 3000], [4096, 3000], [4096, 1000]];
        let east: &[[i32; 2]] = &[[0, 1000], [800, 1000], [800, 3000], [0, 3000]];
        let seam = check(&water(&[west]), &water(&[east]), MvtSeamEdge::East);
        assert!(!seam.counts.defective(), "{seam:?}");
    }

    #[test]
    fn different_extents_compare_as_fractions_of_the_edge() {
        let west = streets(&[road(&[[100, 1000], [4096, 1000]], 1)]);
        let east = layer_with_extent(
            "streets",
            &[road(&[[0, 250], [200, 250]], 1)],
            &["kind", "name"],
            &["primary", "Alpha Road", "Beta Road"],
            1024,
        );
        let seam = check(&west, &east, MvtSeamEdge::East);
        assert_eq!(seam.counts.line_crossings, 1, "{seam:?}");
        assert_eq!(seam.layers[0].second_extent, Some(1024));
    }

    #[test]
    fn a_world_tile_is_its_own_neighbour_across_the_antimeridian() {
        let world = streets(&[road(&[[0, 2000], [4096, 2000]], 1)]);
        let seam = check(&world, &world, MvtSeamEdge::Antimeridian);
        assert_eq!(seam.counts.line_crossings, 1);
        assert!(!seam.counts.defective());
        let broken = streets(&[road(&[[0, 2000], [4000, 2000]], 1)]);
        let seam = check(&broken, &broken, MvtSeamEdge::Antimeridian);
        assert_eq!(seam.counts.line_interrupted, 1, "{seam:?}");
        assert_eq!(seam.findings[0].side, Some(MvtSeamSide::Second));

        // A buffered producer that does not wrap its buffer across the antimeridian: the land
        // reaches 64 units beyond the inner edges but stops at the world's edge. Across the
        // antimeridian only continuity is compared, so this is not a seam.
        let land = |ring: &[[i32; 2]]| {
            layer(
                "land",
                &[feature(None, 3, &path_commands(&[ring], true), &[0, 0])],
                &["kind"],
                &["forest"],
            )
        };
        let east_end = land(&[[-64, 0], [4096, 0], [4096, 4096], [-64, 4096]]);
        let west_end = land(&[[0, 0], [4160, 0], [4160, 4096], [0, 4096]]);
        let seam = check(&east_end, &west_end, MvtSeamEdge::Antimeridian);
        assert!(!seam.counts.defective(), "{seam:?}");
        assert_eq!(seam.counts.polygon_groups, 1);
        // The same tiles as ordinary neighbours would disagree about both buffer strips.
        let seam = check(&east_end, &west_end, MvtSeamEdge::East);
        assert_eq!(seam.counts.polygon_mismatches, 2, "{seam:?}");
    }

    #[test]
    fn samples_are_bounded_and_errors_name_their_side() {
        let west = streets(
            &(0..10)
                .map(|row| road(&[[100, 100 + row * 300], [4096, 100 + row * 300]], 1))
                .collect::<Vec<_>>(),
        );
        let seam = check_mvt_seam(&west, &streets(&[]), MvtSeamEdge::East, TOLERANCE, 3).unwrap();
        assert_eq!(seam.counts.line_interrupted, 10);
        assert_eq!(seam.findings.len(), 3);
        assert!(seam.findings_truncated);

        let error = check_mvt_seam(&west, &[0x1a, 0x05, 0x01], MvtSeamEdge::East, TOLERANCE, 3)
            .unwrap_err();
        assert!(matches!(
            error,
            MvtSeamError::Undecodable(MvtSeamSide::Second, _)
        ));
        let mut repeated = streets(&[]);
        repeated.extend(streets(&[]));
        assert_eq!(
            check_mvt_seam(&repeated, &west, MvtSeamEdge::South, TOLERANCE, 3).unwrap_err(),
            MvtSeamError::DuplicateLayer(MvtSeamSide::First, "streets".into())
        );
        let invalid = MvtSeamTolerance {
            slack_units: f64::NAN,
            offset_window_units: 1.0,
        };
        assert_eq!(
            check_mvt_seam(&west, &west, MvtSeamEdge::East, invalid, 3).unwrap_err(),
            MvtSeamError::InvalidTolerance
        );
    }
}
