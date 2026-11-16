//! Tiles past a vector source's maximum zoom (#346), as MapLibre GL JS 6.17 makes them.
//!
//! Up to `zoomLevelsToOverscale` (4) zoom levels below the map's maximum zoom, MapLibre does
//! not stretch a source tile: its worker slices the source's deepest tile into the tile of the
//! camera's zoom (`sliceVectorTileLayer`) and lays that out like any other tile. Labels then
//! repeat, anchor and collide per sliced tile. Deeper still, the sliced tile of the deepest
//! split zoom is laid out again at the camera's tile zoom (`overscaledZ`, see
//! [`super::layout_overscaled_tile`]).

use crate::TileId;
use crate::mvt_features::{MvtFeature, MvtGeometryType, MvtLayer};

use super::expression::js_round;
use super::layout::EXTENT;

/// MapLibre's default `zoomLevelsToOverscale`: the zoom levels below the map's maximum zoom
/// that stretch the deepest split tile instead of splitting further.
pub const ZOOM_LEVELS_TO_OVERSCALE: f64 = 4.0;

/// The deepest zoom MapLibre's tile cover splits a vector source to: the source's maximum
/// zoom, or the map's maximum zoom less [`ZOOM_LEVELS_TO_OVERSCALE`] when that is deeper
/// (rounded up, as the cover stops at the first whole zoom reaching it).
#[must_use]
pub fn split_max_zoom(source_max_zoom: u8, map_max_zoom: f64) -> u8 {
    let split = (map_max_zoom - ZOOM_LEVELS_TO_OVERSCALE).ceil();
    if split.is_finite() && split > f64::from(source_max_zoom) {
        split.min(f64::from(u8::MAX)) as u8
    } else {
        source_max_zoom
    }
}

/// `sliceVectorTileLayer` for every layer of the source tile `parent`: features moved into
/// the frame of its descendant `target` and clipped to it with MapLibre's 128-unit buffer
/// (in the source's extent). Features left without geometry are dropped, as MapLibre drops
/// them. The sliced layers carry [`EXTENT`] units, rounded as MapLibre's `loadGeometry`
/// rounds the sliced floating-point coordinates. `None` unless `target` lies in `parent`.
#[must_use]
pub fn slice_tile_layers(
    layers: &[MvtLayer],
    parent: TileId,
    target: TileId,
) -> Option<Vec<MvtLayer>> {
    let dz = target.z.checked_sub(parent.z)?;
    let scale_shift = u32::from(dz);
    if scale_shift >= 32
        || target.x >> scale_shift != parent.x
        || target.y >> scale_shift != parent.y
    {
        return None;
    }
    let scale = f64::from(dz).exp2();
    Some(
        layers
            .iter()
            .map(|layer| slice_layer(layer, parent, target, scale))
            .collect(),
    )
}

fn slice_layer(layer: &MvtLayer, parent: TileId, target: TileId, scale: f64) -> MvtLayer {
    let extent = f64::from(layer.extent);
    let offset = [
        (f64::from(target.x) - f64::from(parent.x) * scale) * extent,
        (f64::from(target.y) - f64::from(parent.y) * scale) * extent,
    ];
    const BUFFER: f64 = 128.0;
    let (low, high) = (-BUFFER, extent + BUFFER);
    let to_extent = EXTENT / extent;
    let features = layer
        .features
        .iter()
        .filter_map(|feature| {
            let geometry: Vec<Vec<[f64; 2]>> = feature
                .geometry
                .iter()
                .map(|path| {
                    path.iter()
                        .map(|point| {
                            [
                                f64::from(point[0]) * scale - offset[0],
                                f64::from(point[1]) * scale - offset[1],
                            ]
                        })
                        .collect()
                })
                .collect();
            let geometry = clip_geometry(geometry, feature.geometry_type, low, high);
            if geometry.is_empty() {
                return None;
            }
            Some(MvtFeature {
                id: feature.id,
                geometry_type: feature.geometry_type,
                geometry: geometry
                    .into_iter()
                    .map(|path| {
                        path.into_iter()
                            .map(|point| point.map(|value| js_round(value * to_extent) as i32))
                            .collect()
                    })
                    .collect(),
                properties: feature.properties.clone(),
            })
        })
        .collect();
    MvtLayer {
        name: layer.name.clone(),
        extent: EXTENT as u32,
        features,
    }
}

/// MapLibre's `clipGeometry`: x first, then y, to `[low, high]` on both axes.
fn clip_geometry(
    geometry: Vec<Vec<[f64; 2]>>,
    kind: MvtGeometryType,
    low: f64,
    high: f64,
) -> Vec<Vec<[f64; 2]>> {
    let clipped = clip_on_axis(geometry, kind, low, high, 0);
    clip_on_axis(clipped, kind, low, high, 1)
}

fn clip_on_axis(
    geometry: Vec<Vec<[f64; 2]>>,
    kind: MvtGeometryType,
    start: f64,
    end: f64,
    axis: usize,
) -> Vec<Vec<[f64; 2]>> {
    match kind {
        // `clipPoints`: every point left becomes its own path.
        MvtGeometryType::Point => geometry
            .iter()
            .flatten()
            .filter(|point| point[axis] >= start && point[axis] <= end)
            .map(|point| vec![*point])
            .collect(),
        MvtGeometryType::LineString => geometry
            .iter()
            .flat_map(|line| clip_line(line, start, end, axis, false))
            .collect(),
        MvtGeometryType::Polygon => geometry
            .iter()
            .flat_map(|ring| clip_line(ring, start, end, axis, true))
            .collect(),
    }
}

/// `clipLineInternal`: lines split where they leave the band; polygon rings stay one ring,
/// closed again if clipping opened them.
fn clip_line(
    line: &[[f64; 2]],
    start: f64,
    end: f64,
    axis: usize,
    polygon: bool,
) -> Vec<Vec<[f64; 2]>> {
    let intersect = |p1: [f64; 2], p2: [f64; 2], at: f64| -> [f64; 2] {
        let t = (at - p1[axis]) / (p2[axis] - p1[axis]);
        let mut point = [0.0; 2];
        point[axis] = at;
        let other = 1 - axis;
        point[other] = p1[other] + (p2[other] - p1[other]) * t;
        point
    };
    let mut slice: Vec<[f64; 2]> = Vec::new();
    let mut lines = Vec::new();
    for pair in line.windows(2) {
        let (p1, p2) = (pair[0], pair[1]);
        let (pos1, pos2) = (p1[axis], p2[axis]);
        let mut exited = false;
        if pos1 < start {
            if pos2 > start {
                slice.push(intersect(p1, p2, start));
            }
        } else if pos1 > end {
            if pos2 < end {
                slice.push(intersect(p1, p2, end));
            }
        } else {
            slice.push(p1);
        }
        if pos2 < start && pos1 >= start {
            slice.push(intersect(p1, p2, start));
            exited = true;
        }
        if pos2 > end && pos1 <= end {
            slice.push(intersect(p1, p2, end));
            exited = true;
        }
        if !polygon && exited {
            lines.push(std::mem::take(&mut slice));
        }
    }
    if let Some(last) = line.last()
        && last[axis] >= start
        && last[axis] <= end
    {
        slice.push(*last);
    }
    if polygon
        && let (Some(first), Some(last)) = (slice.first().copied(), slice.last().copied())
        && first != last
    {
        slice.push(first);
    }
    if !slice.is_empty() {
        lines.push(slice);
    }
    lines
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn layer(kind: MvtGeometryType, geometry: Vec<Vec<[i32; 2]>>) -> MvtLayer {
        MvtLayer {
            name: "l".to_owned(),
            extent: 4096,
            features: vec![MvtFeature {
                id: Some(7),
                geometry_type: kind,
                geometry,
                properties: BTreeMap::new(),
            }],
        }
    }

    fn tile(z: u8, x: u32, y: u32) -> TileId {
        TileId::new(z, x, y).unwrap()
    }

    #[test]
    fn the_split_reaches_four_zooms_below_the_map_max_zoom_or_the_source_max_zoom() {
        assert_eq!(split_max_zoom(12, 22.0), 18);
        assert_eq!(split_max_zoom(12, 19.5), 16);
        assert_eq!(split_max_zoom(14, 16.0), 14);
        assert_eq!(split_max_zoom(14, f64::NAN), 14);
    }

    #[test]
    fn lines_move_into_the_child_frame_and_split_where_they_leave_its_buffer() {
        // A line across the parent's top half: the north-east child (x 1 of 2) keeps the part
        // from its west buffer edge on, doubled and shifted by one parent width.
        let parent = layer(
            MvtGeometryType::LineString,
            vec![vec![[0, 1000], [4096, 1000]]],
        );
        let sliced = slice_tile_layers(
            std::slice::from_ref(&parent),
            tile(12, 10, 20),
            tile(13, 21, 40),
        )
        .unwrap();
        assert_eq!(sliced[0].extent, 8192);
        // x: 0 -> -4096, clipped at -128; 4096 -> 4096 (in the 4096 extent), then doubled.
        assert_eq!(
            sliced[0].features[0].geometry,
            vec![vec![[-256, 4000], [8192, 4000]]]
        );
        assert_eq!(sliced[0].features[0].id, Some(7));
        // The south children miss it: no feature is left.
        let south = slice_tile_layers(
            std::slice::from_ref(&parent),
            tile(12, 10, 20),
            tile(13, 21, 41),
        )
        .unwrap();
        assert!(south[0].features.is_empty());
        // A line leaving the band and coming back is two lines.
        let zigzag = layer(
            MvtGeometryType::LineString,
            vec![vec![[1000, 500], [3000, 500], [3000, 2000], [1000, 2000]]],
        );
        let west = slice_tile_layers(&[zigzag], tile(12, 10, 20), tile(13, 20, 40)).unwrap();
        assert_eq!(
            west[0].features[0].geometry,
            vec![
                vec![[4000, 2000], [8448, 2000]],
                vec![[8448, 8000], [4000, 8000]],
            ]
        );
        // Not a descendant.
        assert!(slice_tile_layers(&[parent], tile(12, 10, 20), tile(13, 23, 40)).is_none());
    }

    #[test]
    fn polygons_stay_closed_and_points_outside_the_buffer_drop() {
        let square = layer(
            MvtGeometryType::Polygon,
            vec![vec![
                [1000, 1000],
                [3000, 1000],
                [3000, 3000],
                [1000, 3000],
                [1000, 1000],
            ]],
        );
        let sliced = slice_tile_layers(&[square], tile(1, 0, 0), tile(2, 0, 0)).unwrap();
        let ring = &sliced[0].features[0].geometry[0];
        assert_eq!(ring.first(), ring.last());
        assert!(ring.iter().all(|p| p[0] <= 8448 && p[1] <= 8448));
        let points = layer(
            MvtGeometryType::Point,
            vec![vec![[100, 100], [2100, 100], [4000, 4000]]],
        );
        let sliced = slice_tile_layers(&[points], tile(1, 0, 0), tile(2, 0, 0)).unwrap();
        // 2100 doubles to 4200: inside the 4096 + 128 buffer; 4000 doubles to 8000: outside.
        assert_eq!(
            sliced[0].features[0].geometry,
            vec![vec![[400, 400]], vec![[8400, 400]]]
        );
    }
}
