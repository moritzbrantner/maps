//! MapLibre 6.15's `coveringTiles` for the Web Mercator projection
//! (`geo/projection/covering_tiles.ts`, `mercator_covering_tiles_details_provider.ts`):
//! a depth-first descent over tile bounding boxes against the camera frustum, with
//! MapLibre's distance-based level of detail under pitch or terrain.

use super::transform::{Frustum, TerrainTransform};
use crate::matrix_camera::MAX_MERCATOR_HORIZON_ANGLE_DEGREES;

/// A covering tile; `wrap` counts world copies east (+) or west (−).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CoveredTile {
    pub z: u8,
    pub x: u32,
    pub y: u32,
    pub wrap: i32,
}

/// A tile's exaggerated `(min, max)` terrain elevation (`Terrain.getMinMaxElevation`).
pub type TileElevationRange<'a> = &'a dyn Fn(u8, u32, u32) -> Option<(f64, f64)>;

/// `CoveringTilesOptions` of one source.
#[derive(Clone, Copy, Debug)]
pub struct CoveringOptions {
    pub tile_size: f64,
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub round_zoom: bool,
}

const DEFAULT_MAX_ZOOM_LEVELS_ON_SCREEN: f64 = 9.314;
const DEFAULT_TILE_COUNT_MAX_MIN_RATIO: f64 = 3.0;
const ASSUMED_MAX_FEATURE_HEIGHT_METERS: f64 = 500.0;
const TILE_CULLING_HORIZON_ONSET_DEGREES: f64 = 15.0;
const FIELD_OF_VIEW_DEGREES: f64 = 36.869_897_645_844_02;

#[derive(Clone, Copy, PartialEq)]
enum Intersection {
    None,
    Partial,
    Full,
}

struct Aabb {
    min: [f64; 3],
    max: [f64; 3],
}

impl Aabb {
    fn intersects_plane(&self, plane: [f64; 4]) -> Intersection {
        let (mut dist_min, mut dist_max) = (plane[3], plane[3]);
        for ((normal, min), max) in plane.iter().zip(self.min).zip(self.max) {
            if *normal > 0.0 {
                dist_min += normal * min;
                dist_max += normal * max;
            } else {
                dist_max += normal * min;
                dist_min += normal * max;
            }
        }
        if dist_min >= 0.0 {
            Intersection::Full
        } else if dist_max < 0.0 {
            Intersection::None
        } else {
            Intersection::Partial
        }
    }

    fn intersects_frustum(&self, frustum: &Frustum) -> Intersection {
        let mut fully_inside = true;
        for plane in frustum.planes {
            match self.intersects_plane(plane) {
                Intersection::None => return Intersection::None,
                Intersection::Partial => fully_inside = false,
                Intersection::Full => {}
            }
        }
        if fully_inside {
            return Intersection::Full;
        }
        for axis in 0..3 {
            if frustum.min[axis] > self.max[axis] || frustum.max[axis] < self.min[axis] {
                return Intersection::None;
            }
        }
        Intersection::Partial
    }

    fn distance_2d(&self, x: f64, y: f64) -> f64 {
        let dx = x.clamp(self.min[0], self.max[0]) - x;
        let dy = y.clamp(self.min[1], self.max[1]) - y;
        dx.hypot(dy)
    }
}

fn scale_zoom(scale: f64) -> f64 {
    scale.log2()
}

fn integral_of_cos_x_by_p(p: f64, x1: f64, x2: f64) -> f64 {
    let points = 10;
    let dx = (x2 - x1) / f64::from(points);
    (0..points)
        .map(|i| {
            let x = x1 + (f64::from(i) + 0.5) / f64::from(points) * (x2 - x1);
            dx * x.cos().powf(p)
        })
        .sum()
}

/// `createCalculateTileZoomFunction(9.314, 3.0)`.
fn default_tile_zoom(
    requested_center_zoom: f64,
    distance_to_tile_2d: f64,
    distance_to_tile_z: f64,
    distance_to_center_3d: f64,
    fov: f64,
) -> f64 {
    let horizon = MAX_MERCATOR_HORIZON_ANGLE_DEGREES;
    let behavior = 2.0
        * ((DEFAULT_MAX_ZOOM_LEVELS_ON_SCREEN - 1.0)
            / scale_zoom((horizon - fov).to_radians().cos() / horizon.to_radians().cos())
            - 1.0);
    let center_pitch = (distance_to_tile_z / distance_to_center_3d).acos();
    let half_fov = (fov / 2.0).to_radians();
    let tile_count_pitch0 = 2.0 * integral_of_cos_x_by_p(behavior - 1.0, 0.0, half_fov);
    let highest = horizon.to_radians().min(center_pitch + half_fov);
    let lowest = highest.min(center_pitch - half_fov);
    let tile_count = integral_of_cos_x_by_p(behavior - 1.0, lowest, highest);
    let tile_pitch = (distance_to_tile_2d / distance_to_tile_z).atan();
    let distance_to_tile_3d = distance_to_tile_2d.hypot(distance_to_tile_z);
    let mut z = requested_center_zoom;
    z += scale_zoom(distance_to_center_3d / distance_to_tile_3d / half_fov.cos().max(0.5));
    z += behavior * scale_zoom(tile_pitch.cos()) / 2.0;
    z -= scale_zoom((tile_count / tile_count_pitch0 / DEFAULT_TILE_COUNT_MAX_MIN_RATIO).max(1.0))
        / 2.0;
    z
}

/// MapLibre's `coveringTiles`. `terrain` returns a tile's exaggerated `(min, max)` elevation
/// (`Terrain.getMinMaxElevation`) when terrain is on; terrain also enables variable zoom.
pub fn covering_tiles(
    transform: &TerrainTransform,
    options: CoveringOptions,
    terrain: Option<TileElevationRange<'_>>,
) -> Vec<CoveredTile> {
    let camera = transform.camera;
    let frustum = transform.frustum();
    let camera_coord = transform.camera_mercator();
    let center_coord = transform.center_mercator();
    let bottom_edge =
        MAX_MERCATOR_HORIZON_ANGLE_DEGREES - camera.pitch - FIELD_OF_VIEW_DEGREES / 2.0;
    let proximity = ((TILE_CULLING_HORIZON_ONSET_DEGREES - bottom_edge)
        / TILE_CULLING_HORIZON_ONSET_DEGREES)
        .clamp(0.0, 1.0);
    let culling_elevation = camera.elevation + proximity * ASSUMED_MAX_FEATURE_HEIGHT_METERS;
    let max_constant_zoom_pitch = (78.5 - FIELD_OF_VIEW_DEGREES / 2.0).clamp(0.0, 60.0);
    let variable_zoom = terrain.is_some() || camera.pitch > max_constant_zoom_pitch;

    let zoom_offset = scale_zoom(512.0 / options.tile_size);
    let round = |value: f64| {
        if options.round_zoom {
            js_round(value)
        } else {
            value.floor()
        }
    };
    let desired_z = round(camera.zoom + zoom_offset).max(0.0);
    let max_zoom = f64::from(options.max_zoom);
    let nominal_z = desired_z.max(0.0).min(max_zoom);
    let num_tiles = 2_f64.powf(nominal_z);
    let center_point = [num_tiles * center_coord[0], num_tiles * center_coord[1]];
    let distance_to_center_2d =
        (center_coord[0] - camera_coord[0]).hypot(center_coord[1] - camera_coord[1]);
    let distance_z = (center_coord[2] - camera_coord[2]).abs();
    let distance_to_center_3d = distance_to_center_2d.hypot(distance_z);

    struct Entry {
        zoom: u8,
        x: u32,
        y: u32,
        wrap: i32,
        fully_visible: bool,
    }
    let mut stack = Vec::new();
    for i in 1..=3 {
        for wrap in [-i, i] {
            stack.push(Entry {
                zoom: 0,
                x: 0,
                y: 0,
                wrap,
                fully_visible: false,
            });
        }
    }
    stack.push(Entry {
        zoom: 0,
        x: 0,
        y: 0,
        wrap: 0,
        fully_visible: false,
    });

    let mut result: Vec<(f64, CoveredTile)> = Vec::new();
    while let Some(entry) = stack.pop() {
        let tiles = f64::from(1_u32 << entry.zoom);
        let (mut min_elevation, mut max_elevation) =
            (culling_elevation.min(0.0), culling_elevation.max(0.0));
        if let Some((min, max)) = terrain.and_then(|terrain| terrain(entry.zoom, entry.x, entry.y))
        {
            min_elevation = min;
            max_elevation = max;
        }
        let wrap = f64::from(entry.wrap);
        let aabb = Aabb {
            min: [
                wrap + f64::from(entry.x) / tiles,
                f64::from(entry.y) / tiles,
                min_elevation,
            ],
            max: [
                wrap + f64::from(entry.x + 1) / tiles,
                f64::from(entry.y + 1) / tiles,
                max_elevation,
            ],
        };
        let mut fully_visible = entry.fully_visible;
        if !fully_visible {
            match aabb.intersects_frustum(&frustum) {
                Intersection::None => continue,
                intersection => fully_visible = intersection == Intersection::Full,
            }
        }
        let distance_to_tile_2d = aabb.distance_2d(camera_coord[0], camera_coord[1]);
        let mut tile_desired_z = desired_z;
        if variable_zoom {
            tile_desired_z = default_tile_zoom(
                camera.zoom + zoom_offset,
                distance_to_tile_2d,
                distance_z,
                distance_to_center_3d,
                FIELD_OF_VIEW_DEGREES,
            );
        }
        let tile_desired_z = round(tile_desired_z).max(0.0);
        let z = tile_desired_z.min(max_zoom);
        if f64::from(entry.zoom) >= z {
            if entry.zoom < options.min_zoom {
                continue;
            }
            let distance_sq = (center_point[0] - 0.5 - f64::from(entry.x)).powi(2)
                + (center_point[1] - 0.5 - f64::from(entry.y)).powi(2);
            result.push((
                distance_sq,
                CoveredTile {
                    z: entry.zoom,
                    x: entry.x,
                    y: entry.y,
                    wrap: entry.wrap,
                },
            ));
            continue;
        }
        for i in 0..4 {
            stack.push(Entry {
                zoom: entry.zoom + 1,
                x: (entry.x << 1) + (i % 2),
                y: (entry.y << 1) + (i >> 1),
                wrap: entry.wrap,
                fully_visible,
            });
        }
    }
    result.sort_by(|a, b| a.0.total_cmp(&b.0));
    result.into_iter().map(|(_, tile)| tile).collect()
}

/// JavaScript `Math.round`: halves round toward +∞.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terrain::transform::TerrainCamera;

    fn transform(pitch: f64) -> TerrainTransform {
        TerrainTransform::new(TerrainCamera {
            longitude: 9.0,
            latitude: 47.2,
            zoom: 8.0,
            bearing: 20.0,
            pitch,
            width: 720.0,
            height: 480.0,
            elevation: 0.0,
            min_elevation_for_current_tile: 0.0,
        })
        .unwrap()
    }

    const RASTER: CoveringOptions = CoveringOptions {
        tile_size: 256.0,
        min_zoom: 0,
        max_zoom: 19,
        round_zoom: true,
    };

    #[test]
    fn flat_camera_covers_the_viewport_at_one_zoom() {
        let tiles = covering_tiles(&transform(0.0), RASTER, None);
        assert!(!tiles.is_empty());
        assert!(tiles.iter().all(|tile| tile.z == 9));
        // 720×480 CSS px at zoom 8 is under 4×3 tiles of 256 px at zoom 9, rotated a bit more.
        assert!(tiles.len() <= 20, "{}", tiles.len());
    }

    /// MapLibre 6.15's `coveringTiles` for the same cameras, in its order (#324).
    #[test]
    fn matches_maplibre_covering_tiles() {
        let ids = |tiles: Vec<CoveredTile>| {
            tiles
                .iter()
                .map(|tile| format!("{}/{}/{}", tile.z, tile.x, tile.y))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let terrain_cover = |options: CoveringOptions| {
            let transform = TerrainTransform::new(TerrainCamera {
                elevation: 2000.0,
                ..transform(55.0).camera
            })
            .unwrap();
            let bounds = |_: u8, _: u32, _: u32| Some((1000.0, 3000.0));
            ids(covering_tiles(&transform, options, Some(&bounds)))
        };
        let terrain_tiles = CoveringOptions {
            tile_size: 512.0,
            min_zoom: 0,
            max_zoom: 22,
            round_zoom: false,
        };
        assert_eq!(
            ids(covering_tiles(&transform(55.0), terrain_tiles, None)),
            "8/134/89 8/134/90 8/133/89 8/133/90 8/135/89 8/135/90 8/134/88 8/133/88 8/135/88 \
             8/136/89 8/136/88 8/133/87"
        );
        assert_eq!(
            terrain_cover(RASTER),
            "9/268/179 9/269/179 9/269/180 9/268/178 9/267/179 9/269/178 9/267/178 9/270/180 \
             8/136/89 8/136/88 8/135/89 8/135/88 8/134/88 8/133/88 7/67/43 7/66/43 10/535/360 \
             10/535/361 10/536/360 10/536/361 10/537/360 10/537/361 10/538/362"
        );
        assert_eq!(
            terrain_cover(terrain_tiles),
            "8/134/90 8/133/90 8/135/90 7/67/44 7/66/44 6/34/22 6/33/21"
        );
    }

    #[test]
    fn terrain_lowers_far_tiles_under_pitch() {
        let flat = |_: u8, _: u32, _: u32| Some((0.0, 0.0));
        let tiles = covering_tiles(&transform(55.0), RASTER, Some(&flat));
        let zooms: std::collections::BTreeSet<u8> = tiles.iter().map(|tile| tile.z).collect();
        assert!(zooms.len() > 1, "{zooms:?}");
        assert!(zooms.iter().all(|&z| z <= 10));
    }
}
